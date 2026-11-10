/*
 * Seek the Deep — content script
 *
 * Injected on demand by the popup. It reads the active chat through
 * DeepSeek's own web API when possible, and falls back to the visible page
 * text if the API is unavailable.
 */
(function initContentScript() {
    "use strict";

    if (globalThis.__dsChatExporterContentLoaded) return;
    globalThis.__dsChatExporterContentLoaded = true;

    const DS = globalThis.DSExport;
    if (!DS) {
        console.error("[Seek the Deep] shared.js was not loaded before content.js");
        return;
    }

    const CACHE_TTL_MS = 12000;
    const UI_LABELS = new Set([
        "copy",
        "copy code",
        "edit",
        "regenerate",
        "retry",
        "share",
        "like",
        "dislike",
        "good response",
        "bad response",
        "more",
        "read aloud",
    ]);

    let cachedConversation = null;
    let cachedAt = 0;
    let cachedWarning = "";

    function runtimeMessage(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    const error = chrome.runtime.lastError;
                    if (error) {
                        reject(new Error(error.message || "The extension background service did not respond."));
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    function getChatId() {
        const match = location.pathname.match(/\/(?:a\/chat\/s|share|chat|s)\/([^/?#]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function pageTitle() {
        const raw = String(document.title || "")
            .replace(/\s*[|·–—-]\s*DeepSeek(?:\s+Chat)?\s*$/i, "")
            .replace(/^DeepSeek(?:\s+Chat)?\s*[|·–—-]\s*/i, "")
            .trim();
        if (!raw || /^deepseek(?:\s*-\s*into the unknown)?$/i.test(raw) || /^new chat$/i.test(raw)) return "";
        return raw;
    }

    function readToken() {
        let raw = null;
        try {
            raw = localStorage.getItem("userToken");
        } catch (error) {
            return "";
        }
        if (!raw) return "";

        const visit = (value, depth) => {
            if (depth > 4 || value == null) return "";
            if (typeof value === "string") {
                const candidate = value.trim().replace(/^Bearer\s+/i, "");
                return candidate.length > 12 ? candidate : "";
            }
            if (typeof value !== "object") return "";
            for (const key of ["value", "token", "access_token", "accessToken"]) {
                if (key in value) {
                    const found = visit(value[key], depth + 1);
                    if (found) return found;
                }
            }
            return "";
        };

        try {
            return visit(JSON.parse(raw), 0) || "";
        } catch (error) {
            return raw.trim().replace(/^Bearer\s+/i, "");
        }
    }

    async function fetchThroughApi() {
        const chatId = getChatId();
        if (!chatId) {
            throw new Error("This page does not have a chat session id in its URL.");
        }
        const token = readToken();
        if (!token) {
            throw new Error("The DeepSeek login token was not found. Reload the page and sign in again.");
        }
        const response = await runtimeMessage({
            type: "DS_FETCH_CHAT",
            chatId,
            token,
            locale: document.documentElement.lang || navigator.language || "en-US",
            timezoneOffset: -new Date().getTimezoneOffset() * 60,
        });
        if (!response) throw new Error("The extension background service returned an empty response.");
        if (!response.ok) throw new Error(response.error || "DeepSeek API request failed.");
        if (!response.conversation) throw new Error("DeepSeek returned no conversation data.");
        return response.conversation;
    }

    function cleanPageText(value) {
        let text = DS.normalizeNewlines(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();
        const lines = text.split("\n");
        while (lines.length) {
            const last = lines[lines.length - 1].trim().toLowerCase();
            if (!UI_LABELS.has(last)) break;
            lines.pop();
        }
        return lines.join("\n").trim();
    }

    function pickContentNode(element, role) {
        if (role === "assistant") {
            return element.querySelector(".ds-assistant-message-main-content")
                || (element.matches(".ds-markdown") ? element : element.querySelector(".ds-markdown"))
                || element;
        }
        if (element.matches(".fbb737a4")) return element;
        return element.querySelector(".fbb737a4") || element;
    }

    function extractPageMessages() {
        const marked = Array.from(document.querySelectorAll("[data-message-author-role]"));
        let candidates = [];

        if (marked.length >= 2) {
            candidates = marked.map((element) => ({
                element,
                role: String(element.getAttribute("data-message-author-role") || "").toLowerCase(),
            }));
        } else {
            const nodes = Array.from(document.querySelectorAll(
                ".fbb737a4, .ds-assistant-message-main-content, .ds-markdown"
            ));
            candidates = nodes
                .filter((element) => !(element.matches(".ds-markdown") && element.closest(".ds-think-content")))
                .map((element) => ({
                    element,
                    role: element.matches(".fbb737a4") || element.closest("._9663006") ? "user" : "assistant",
                }));
        }

        const messages = [];
        for (const candidate of candidates) {
            if (candidate.role !== "user" && candidate.role !== "assistant") continue;
            const contentNode = pickContentNode(candidate.element, candidate.role);
            if (!contentNode) continue;
            const text = cleanPageText(contentNode.innerText || contentNode.textContent || "");
            if (!text) continue;
            if (messages.length) {
                const previous = messages[messages.length - 1];
                if (previous.role === candidate.role && previous.text === text) continue;
            }
            messages.push({
                role: candidate.role,
                text,
                createdAt: 0,
            });
        }
        return messages;
    }

    async function getConversation(force) {
        if (!force && cachedConversation && Date.now() - cachedAt < CACHE_TTL_MS) {
            return { conversation: cachedConversation, warning: cachedWarning };
        }

        let apiError = null;
        try {
            const conversation = await fetchThroughApi();
            cachedConversation = conversation;
            cachedAt = Date.now();
            cachedWarning = "";
            return { conversation, warning: "" };
        } catch (error) {
            apiError = error;
            console.warn("[Seek the Deep] API extraction failed, trying page text:", error);
        }

        const messages = extractPageMessages();
        if (!messages.length) {
            throw new Error(
                `${apiError ? `${apiError.message} ` : ""}No visible messages were found either. ` +
                "Make sure the conversation is open and has finished loading, then try again."
            );
        }

        const conversation = DS.normalizePageConversation(messages, {
            chatId: getChatId(),
            title: pageTitle(),
            url: location.href.split("#")[0],
        });
        cachedConversation = conversation;
        cachedAt = Date.now();
        cachedWarning = "Using visible page text because the DeepSeek API was unavailable.";
        return { conversation, warning: cachedWarning };
    }

    function downloadText(filename, mime, text) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = "none";
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    function normalizeOptions(options) {
        return {
            includeReasoning: options && options.includeReasoning !== false,
            includeTimestamps: Boolean(options && options.includeTimestamps),
        };
    }

    async function reserveExportSlot() {
        const response = await runtimeMessage({ type: "DS_RESERVE_EXPORT" });
        if (!response) {
            throw new Error("The extension background service returned an empty response.");
        }
        if (!response.ok) {
            const error = new Error(response.error || "The export limit has been reached.");
            error.code = response.code;
            error.retryAfterMs = response.retryAfterMs;
            error.remaining = response.remaining;
            error.limit = response.limit;
            error.windowMs = response.windowMs;
            throw error;
        }
        return response;
    }

    function rateLimitInfo(reservation) {
        return {
            remaining: reservation.remaining,
            limit: reservation.limit,
            windowMs: reservation.windowMs,
            resetAt: reservation.resetAt,
        };
    }

    async function exportConversation(message) {
        const format = String(message.format || "md");
        if (!DS.FORMATS[format]) throw new Error("Unknown export format.");
        const options = normalizeOptions(message.options);

        // Reserve before touching the API so rapid repeated exports cannot
        // hammer DeepSeek, even if the export later fails.
        const reservation = await reserveExportSlot();
        const { conversation, warning } = await getConversation(true);

        if (format === "pdf") {
            const html = DS.buildHtmlBody(conversation, options);
            const base = DS.makeBaseFilename(conversation);
            const response = await runtimeMessage({
                type: "DS_OPEN_PRINT",
                html,
                title: base,
                messageCount: conversation.messages.length,
            });
            if (!response || !response.ok) {
                throw new Error(response && response.error || "Could not open the print page.");
            }
            return {
                ok: true,
                print: true,
                filename: `${base}.pdf`,
                warning,
                rateLimit: rateLimitInfo(reservation),
            };
        }

        const text = DS.serialize(conversation, format, options);
        const filename = DS.makeFilename(conversation, format);
        downloadText(filename, DS.FORMATS[format].mime, text);
        return {
            ok: true,
            filename,
            warning,
            bytes: new Blob([text]).size,
            rateLimit: rateLimitInfo(reservation),
        };
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.type !== "string") return undefined;

        if (message.type === "DS_PING") {
            sendResponse({ ok: true, version: "1.1.1" });
            return undefined;
        }

        if (message.type === "DS_GET_INFO") {
            getConversation(Boolean(message.force))
                .then(({ conversation, warning }) => {
                    sendResponse({
                        ok: true,
                        info: {
                            chatId: conversation.id,
                            title: conversation.title,
                            messageCount: conversation.messages.length,
                            model: conversation.model,
                            source: conversation.source,
                            url: conversation.url,
                            warning,
                        },
                    });
                })
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }

        if (message.type === "DS_EXPORT") {
            exportConversation(message)
                .then((result) => sendResponse(result))
                .catch((error) => sendResponse({
                    ok: false,
                    error: error.message,
                    code: error.code,
                    retryAfterMs: error.retryAfterMs,
                    remaining: error.remaining,
                    limit: error.limit,
                    windowMs: error.windowMs,
                }));
            return true;
        }

        return undefined;
    });
})();
