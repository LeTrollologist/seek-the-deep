/*
 * Seek the Deep — popup controller
 */
(function initPopup() {
    "use strict";

    const DS = globalThis.DSExport;
    const DEFAULTS = {
        format: "md",
        includeReasoning: true,
        includeTimestamps: false,
    };
    const HINTS = {
        md: "Full conversation with headings, code blocks, and links.",
        txt: "Clean, readable transcript. Markdown is kept as-is.",
        pdf: "Opens your browser's print dialog — choose “Save as PDF”.",
        json: "Structured messages for backups or scripting.",
        html: "Standalone page with formatting; opens in any browser.",
    };
    const PDF_LABEL = "Print / Save as PDF";

    const state = {
        tabId: null,
        format: DEFAULTS.format,
        includeReasoning: DEFAULTS.includeReasoning,
        includeTimestamps: DEFAULTS.includeTimestamps,
        info: null,
        busy: false,
        ready: false,
        rateLimitedUntil: 0,
        rateLimitTimer: null,
    };

    const elements = {
        loadingView: document.getElementById("loadingView"),
        notChatView: document.getElementById("notChatView"),
        chatView: document.getElementById("chatView"),
        refreshBtn: document.getElementById("refreshBtn"),
        openSiteBtn: document.getElementById("openSiteBtn"),
        chatTitle: document.getElementById("chatTitle"),
        chatMeta: document.getElementById("chatMeta"),
        sourcePill: document.getElementById("sourcePill"),
        messageCount: document.getElementById("messageCount"),
        formatGrid: document.getElementById("formatGrid"),
        formatNote: document.getElementById("formatNote"),
        formatHint: document.getElementById("formatHint"),
        rateNote: document.getElementById("rateNote"),
        includeReasoning: document.getElementById("includeReasoning"),
        includeTimestamps: document.getElementById("includeTimestamps"),
        banner: document.getElementById("banner"),
        exportBtn: document.getElementById("exportBtn"),
        buttonLabel: document.querySelector("#exportBtn .button-label"),
    };

    function isChatUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === "https:" && url.hostname === "chat.deepseek.com";
        } catch (error) {
            return false;
        }
    }

    function formatLabel(format) {
        return DS.FORMATS[format] ? DS.FORMATS[format].label : "Markdown";
    }

    function friendlyModel(model) {
        const value = String(model || "").trim();
        if (!value) return "";
        if (/reason|r1/i.test(value)) return "DeepSeek Reasoner";
        if (/vision|vl/i.test(value)) return "DeepSeek Vision";
        if (/chat|default/i.test(value)) return "DeepSeek Chat";
        return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function storageGet(defaults) {
        return new Promise((resolve) => {
            try {
                chrome.storage.sync.get(defaults, (values) => {
                    if (chrome.runtime.lastError) resolve({ ...defaults });
                    else resolve({ ...defaults, ...values });
                });
            } catch (error) {
                resolve({ ...defaults });
            }
        });
    }

    function storageSet(values) {
        try {
            chrome.storage.sync.set(values, () => void chrome.runtime.lastError);
        } catch (error) {
            // Preferences are a convenience, not a requirement.
        }
    }

    function sendToTab(message, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (state.tabId == null) {
                reject(new Error("No active tab."));
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error("The page did not respond in time. Reload the chat and try again."));
            }, timeoutMs || 45000);

            try {
                chrome.tabs.sendMessage(state.tabId, message, (response) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    const error = chrome.runtime.lastError;
                    if (error) {
                        reject(new Error(error.message || "Could not reach the page."));
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    async function ensureContentScript() {
        try {
            const pong = await sendToTab({ type: "DS_PING" }, 2500);
            if (pong && pong.ok) return;
        } catch (error) {
            // Inject below.
        }
        await chrome.scripting.executeScript({
            target: { tabId: state.tabId },
            files: ["shared.js", "content.js"],
        });
        const pong = await sendToTab({ type: "DS_PING" }, 3000);
        if (!pong || !pong.ok) {
            throw new Error("The exporter could not attach to this page. Reload the page and try again.");
        }
    }

    function showView(name) {
        elements.loadingView.hidden = name !== "loading";
        elements.notChatView.hidden = name !== "notChat";
        elements.chatView.hidden = name !== "chat";
    }

    function setBanner(type, text) {
        elements.banner.className = `banner ${type}`;
        elements.banner.textContent = text;
        elements.banner.hidden = false;
    }

    function clearBanner() {
        elements.banner.hidden = true;
        elements.banner.textContent = "";
    }

    function updateFormatUI() {
        const cards = elements.formatGrid.querySelectorAll(".format-card");
        cards.forEach((card) => {
            const selected = card.dataset.format === state.format;
            card.classList.toggle("selected", selected);
            card.setAttribute("aria-checked", selected ? "true" : "false");
            card.tabIndex = selected ? 0 : -1;
        });
        elements.formatNote.textContent = state.format === "pdf"
            ? "print"
            : `.${DS.FORMATS[state.format].extension}`;
        elements.formatHint.textContent = HINTS[state.format] || "";
        updateButtonLabel();
    }

    function isRateLimited() {
        return state.rateLimitedUntil > Date.now();
    }

    function rateLimitSeconds() {
        return Math.max(1, Math.ceil((state.rateLimitedUntil - Date.now()) / 1000));
    }

    function updateButtonLabel() {
        if (state.busy) return;
        if (isRateLimited()) {
            elements.buttonLabel.textContent = `Try again in ${rateLimitSeconds()}s`;
            elements.exportBtn.disabled = true;
            return;
        }
        elements.buttonLabel.textContent = state.format === "pdf"
            ? PDF_LABEL
            : `Download ${formatLabel(state.format)}`;
    }

    function stopRateLimitTimer() {
        if (state.rateLimitTimer) {
            clearInterval(state.rateLimitTimer);
            state.rateLimitTimer = null;
        }
    }

    function beginRateLimit(retryAfterMs, message) {
        stopRateLimitTimer();
        const wait = Math.max(1000, Number(retryAfterMs) || 1000);
        state.rateLimitedUntil = Date.now() + wait;
        elements.exportBtn.disabled = true;
        setBanner("warning", message || `Export limit reached. Try again in ${Math.ceil(wait / 1000)} seconds.`);

        const tick = () => {
            if (!isRateLimited()) {
                stopRateLimitTimer();
                state.rateLimitedUntil = 0;
                setBanner("success", "You can export again.");
                if (state.ready) setReady(true);
                updateButtonLabel();
                return;
            }
            updateButtonLabel();
        };
        tick();
        state.rateLimitTimer = setInterval(tick, 500);
    }

    function setBusy(busy) {
        state.busy = busy;
        elements.exportBtn.classList.toggle("busy", busy);
        elements.exportBtn.disabled = busy || !state.ready || isRateLimited();
        if (busy) {
            elements.buttonLabel.textContent = state.format === "pdf"
                ? "Preparing print view…"
                : "Preparing export…";
        } else {
            updateButtonLabel();
        }
    }

    function setReady(ready) {
        state.ready = ready;
        elements.exportBtn.disabled = !ready || state.busy || isRateLimited();
        elements.refreshBtn.hidden = state.tabId == null;
    }

    function showNotChat() {
        state.tabId = null;
        state.ready = false;
        elements.refreshBtn.hidden = true;
        showView("notChat");
        setReady(false);
    }

    function showError(message) {
        showView("chat");
        state.ready = false;
        state.info = null;
        elements.chatTitle.textContent = "Couldn’t read this chat";
        elements.chatMeta.textContent = "The conversation could not be loaded.";
        elements.sourcePill.textContent = "Not connected";
        elements.sourcePill.classList.remove("page");
        elements.messageCount.textContent = "— messages";
        setBanner("error", message);
        setReady(false);
    }

    function applyInfo(info) {
        state.info = info;
        state.ready = true;
        showView("chat");

        elements.chatTitle.textContent = info.title || "DeepSeek conversation";
        const count = Number(info.messageCount || 0);
        elements.messageCount.textContent = `${count} message${count === 1 ? "" : "s"}`;
        const model = friendlyModel(info.model);
        elements.chatMeta.textContent = model
            ? `${model} · ${info.source === "api" ? "full history" : "visible page text"}`
            : `${info.source === "api" ? "Full conversation" : "Visible page text"}`;

        const fromApi = info.source === "api";
        elements.sourcePill.textContent = fromApi ? "DeepSeek API" : "Page text";
        elements.sourcePill.classList.toggle("page", !fromApi);

        if (info.warning) {
            setBanner("warning", info.warning);
        } else {
            clearBanner();
        }
        setReady(count > 0);
    }

    async function loadInfo(force) {
        clearBanner();
        if (!state.info) showView("loading");
        elements.refreshBtn.classList.add("spinning");
        try {
            await ensureContentScript();
            const response = await sendToTab({ type: "DS_GET_INFO", force: Boolean(force) }, 45000);
            if (!response) throw new Error("The page returned an empty response.");
            if (!response.ok) throw new Error(response.error || "The conversation could not be read.");
            applyInfo(response.info);
        } catch (error) {
            showError(error.message || String(error));
        } finally {
            elements.refreshBtn.classList.remove("spinning");
        }
    }

    function setFormat(format) {
        if (!DS.FORMATS[format] || state.busy) return;
        state.format = format;
        storageSet({ format });
        updateFormatUI();
        if (elements.banner.classList.contains("success")) clearBanner();
    }

    async function runExport() {
        if (state.busy || !state.ready || isRateLimited()) return;
        clearBanner();
        setBusy(true);

        try {
            const response = await sendToTab({
                type: "DS_EXPORT",
                format: state.format,
                options: {
                    includeReasoning: state.includeReasoning,
                    includeTimestamps: state.includeTimestamps,
                },
            }, 60000);

            if (!response) throw new Error("The page returned an empty response.");
            if (!response.ok) {
                const failure = new Error(response.error || "The export failed.");
                Object.assign(failure, response);
                throw failure;
            }

            const remaining = response.rateLimit && Number.isFinite(Number(response.rateLimit.remaining))
                ? ` ${response.rateLimit.remaining} of ${response.rateLimit.limit} exports left in this window.`
                : "";

            if (response.print) {
                setBanner(
                    "success",
                    `Print view opened in a new tab. Choose “Save as PDF” in the print dialog.${remaining}`
                );
            } else {
                setBanner("success", `Downloaded ${response.filename || "your chat export"}.${remaining}`);
            }
            if (response.warning) {
                setTimeout(() => {
                    if (!state.busy && !isRateLimited()) setBanner("warning", response.warning);
                }, 3500);
            }
        } catch (error) {
            if (error.code === "RATE_LIMITED") {
                beginRateLimit(error.retryAfterMs, error.message);
            } else {
                setBanner("error", error.message || String(error));
            }
        } finally {
            setBusy(false);
        }
    }

    function bindEvents() {
        elements.formatGrid.addEventListener("click", (event) => {
            const card = event.target.closest(".format-card");
            if (!card) return;
            setFormat(card.dataset.format);
        });

        elements.formatGrid.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const formats = Array.from(elements.formatGrid.querySelectorAll(".format-card")).map((card) => card.dataset.format);
            const current = formats.indexOf(state.format);
            const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
            const next = (current + direction + formats.length) % formats.length;
            setFormat(formats[next]);
            elements.formatGrid.querySelector(`[data-format="${formats[next]}"]`).focus();
        });

        elements.includeReasoning.addEventListener("change", () => {
            state.includeReasoning = elements.includeReasoning.checked;
            storageSet({ includeReasoning: state.includeReasoning });
        });

        elements.includeTimestamps.addEventListener("change", () => {
            state.includeTimestamps = elements.includeTimestamps.checked;
            storageSet({ includeTimestamps: state.includeTimestamps });
        });

        elements.exportBtn.addEventListener("click", runExport);
        elements.refreshBtn.addEventListener("click", () => loadInfo(true));
        elements.openSiteBtn.addEventListener("click", () => {
            chrome.tabs.create({ url: "https://chat.deepseek.com/" });
        });
    }

    async function init() {
        const prefs = await storageGet(DEFAULTS);
        state.format = DS.FORMATS[prefs.format] ? prefs.format : DEFAULTS.format;
        state.includeReasoning = prefs.includeReasoning !== false;
        state.includeTimestamps = Boolean(prefs.includeTimestamps);
        elements.includeReasoning.checked = state.includeReasoning;
        elements.includeTimestamps.checked = state.includeTimestamps;
        const windowMinutes = Math.round(DS.RATE_LIMIT.windowMs / 60000);
        elements.rateNote.textContent = `Rate-limited to ${DS.RATE_LIMIT.maxExports} exports per ${windowMinutes} minutes.`;
        updateFormatUI();
        bindEvents();

        let tabs;
        try {
            tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        } catch (error) {
            showNotChat();
            return;
        }
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null || !isChatUrl(tab.url)) {
            showNotChat();
            return;
        }

        state.tabId = tab.id;
        elements.refreshBtn.hidden = false;
        showView("loading");
        await loadInfo(true);
    }

    init();
})();
