/*
 * Seek the Deep — background service worker
 *
 * The API request runs here so it is not constrained by the page's CORS or
 * Content-Security-Policy. The only network destination is chat.deepseek.com.
 */
importScripts("shared.js");

const DS = globalThis.DSExport;
const API_ORIGIN = "https://chat.deepseek.com";
const CLIENT_VERSION = "2.3.0";
const REQUEST_TIMEOUT_MS = 25000;
const MAX_PRINT_HTML_BYTES = 18 * 1024 * 1024;
const RATE_LIMIT_STORAGE_KEY = "exportRateLimitTimestamps";

// All export reservations go through this queue. That keeps two tabs from
// racing past the same cooldown or window in the same service-worker lifetime.
let rateLimitQueue = Promise.resolve();

function isChatSender(sender) {
    const url = sender && sender.tab && sender.tab.url;
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && parsed.hostname === "chat.deepseek.com";
    } catch (error) {
        return false;
    }
}

function validateChatId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function apiMessage(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.msg && typeof payload.msg === "string") return payload.msg;
    if (payload.message && typeof payload.message === "string") return payload.message;
    const data = payload.data;
    if (data && typeof data === "object") {
        if (typeof data.biz_msg === "string" && data.biz_msg) return data.biz_msg;
        if (typeof data.msg === "string" && data.msg) return data.msg;
    }
    return "";
}

function apiCodeFailed(value) {
    return value != null && value !== 0 && value !== "0";
}

async function fetchConversation(chatId, token, locale, timezoneOffset) {
    const endpoint = new URL("/api/v0/chat/history_messages", API_ORIGIN);
    endpoint.searchParams.set("chat_session_id", chatId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(endpoint.href, {
            method: "GET",
            credentials: "include",
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}`,
                "x-client-bundle-id": "com.deepseek.chat",
                "x-client-platform": "web",
                "x-client-version": CLIENT_VERSION,
                "x-client-locale": String(locale || "en-US").replace("-", "_"),
                "x-client-timezone-offset": String(Number.isFinite(Number(timezoneOffset)) ? Number(timezoneOffset) : 0),
            },
        });
    } catch (error) {
        if (error && error.name === "AbortError") {
            throw new Error("DeepSeek took too long to respond. Try again in a moment.");
        }
        throw new Error(`Could not reach DeepSeek: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
        throw new Error("Your DeepSeek session expired. Reload chat.deepseek.com, sign in, and try again.");
    }
    if (response.status === 429) {
        throw new Error("DeepSeek is rate-limiting requests. Wait a moment and try again.");
    }
    if (!response.ok) {
        throw new Error(`DeepSeek API request failed (HTTP ${response.status}).`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw new Error("DeepSeek returned a response that was not valid JSON.");
    }

    if (apiCodeFailed(payload && payload.code)) {
        throw new Error(apiMessage(payload) || "DeepSeek rejected the request.");
    }
    const data = payload && payload.data;
    if (data && typeof data === "object" && apiCodeFailed(data.biz_code)) {
        throw new Error(apiMessage(payload) || "DeepSeek rejected the request.");
    }

    return DS.normalizeApiConversation(payload, {
        chatId,
        url: `${API_ORIGIN}/a/chat/s/${encodeURIComponent(chatId)}`,
    });
}

function handleFetchChat(message, sender) {
    if (!isChatSender(sender)) {
        return { ok: false, error: "The exporter can only read chats on chat.deepseek.com." };
    }
    if (!validateChatId(message.chatId)) {
        return { ok: false, error: "The chat id in the page URL is not valid." };
    }
    if (typeof message.token !== "string" || message.token.length < 12 || message.token.length > 8000) {
        return { ok: false, error: "The DeepSeek login token is missing. Reload the page and try again." };
    }

    return fetchConversation(
        message.chatId,
        message.token,
        message.locale,
        message.timezoneOffset
    ).then((conversation) => ({ ok: true, conversation }));
}

async function handleOpenPrint(message, sender) {
    if (!isChatSender(sender)) {
        return { ok: false, error: "The print page can only be opened from chat.deepseek.com." };
    }
    if (typeof message.html !== "string" || !message.html.trim()) {
        return { ok: false, error: "The printable document was empty." };
    }
    const bytes = new Blob([message.html]).size;
    if (bytes > MAX_PRINT_HTML_BYTES) {
        return { ok: false, error: "This conversation is too large to prepare as a PDF in one pass." };
    }

    const job = {
        html: message.html,
        title: String(message.title || "DeepSeek conversation").slice(0, 120),
        messageCount: Number(message.messageCount || 0),
        createdAt: Date.now(),
    };
    await chrome.storage.local.set({ printJob: job });
    await chrome.tabs.create({ url: chrome.runtime.getURL("print.html") });
    return { ok: true };
}

function withRateLimitLock(work) {
    const next = rateLimitQueue.then(work, work);
    rateLimitQueue = next.catch(() => {});
    return next;
}

function handleReserveExport(sender) {
    if (!isChatSender(sender)) {
        return { ok: false, error: "Exports can only be reserved from chat.deepseek.com." };
    }

    return withRateLimitLock(async () => {
        const stored = await chrome.storage.local.get(RATE_LIMIT_STORAGE_KEY);
        const result = DS.evaluateExportRateLimit(stored[RATE_LIMIT_STORAGE_KEY], Date.now());

        if (!result.allowed) {
            const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
            return {
                ok: false,
                code: "RATE_LIMITED",
                error: result.reason === "window"
                    ? `Export limit reached. Try again in ${seconds} seconds.`
                    : `Please wait ${seconds} seconds between exports.`,
                retryAfterMs: result.retryAfterMs,
                remaining: result.remaining,
                limit: result.limit,
                windowMs: result.windowMs,
            };
        }

        await chrome.storage.local.set({
            [RATE_LIMIT_STORAGE_KEY]: result.timestamps,
        });

        return {
            ok: true,
            remaining: result.remaining,
            limit: result.limit,
            windowMs: result.windowMs,
            minIntervalMs: result.minIntervalMs,
            resetAt: result.resetAt,
        };
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return undefined;

    let promise = null;
    if (message.type === "DS_FETCH_CHAT") {
        promise = handleFetchChat(message, sender);
    } else if (message.type === "DS_OPEN_PRINT") {
        promise = handleOpenPrint(message, sender);
    } else if (message.type === "DS_RESERVE_EXPORT") {
        promise = handleReserveExport(sender);
    } else {
        return undefined;
    }

    promise
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove("printJob").catch(() => {});
});
