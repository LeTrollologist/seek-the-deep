/*
 * Seek the Deep — shared helpers
 *
 * This file is loaded as a classic script in the extension service worker,
 * content script, popup, and print page. It intentionally has no dependencies
 * and never sends data anywhere except back to chat.deepseek.com.
 */
(function initDeepSeekExporter(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.DSExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildExporter() {
    "use strict";

    const EXPORT_FORMAT = "deepseek-chat-export";
    const EXPORT_VERSION = 1;

    const FORMATS = {
        md: { label: "Markdown", extension: "md", mime: "text/markdown;charset=utf-8" },
        txt: { label: "Plain text", extension: "txt", mime: "text/plain;charset=utf-8" },
        html: { label: "HTML", extension: "html", mime: "text/html;charset=utf-8" },
        json: { label: "JSON", extension: "json", mime: "application/json;charset=utf-8" },
        pdf: { label: "PDF", extension: "pdf", mime: "application/pdf" },
    };

    const RATE_LIMIT = Object.freeze({
        maxExports: 10,
        windowMs: 10 * 60 * 1000,
        minIntervalMs: 5000,
    });

    const BLOCKED_SCHEMES = /^(?:javascript|vbscript|data|file):/i;
    const ALLOWED_SCHEMES = /^(?:https?:|mailto:)/i;

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function safeUrl(value, fallback) {
        const raw = String(value == null ? "" : value).trim();
        if (!raw) return fallback || "";
        if (BLOCKED_SCHEMES.test(raw)) return fallback || "";
        if (/^(?:#|\/|\.\/|\.\.\/)/.test(raw)) return raw;
        if (!ALLOWED_SCHEMES.test(raw)) return fallback || "";
        return raw;
    }

    function escapeMarkdownLinkLabel(value) {
        return String(value == null ? "" : value)
            .replace(/\r?\n/g, " ")
            .replace(/([\\\[\]])/g, "\\$1")
            .trim();
    }

    function escapeMarkdownLinkUrl(value) {
        return String(value == null ? "" : value)
            .trim()
            .replace(/\s/g, "%20")
            .replace(/\)/g, "%29");
    }

    function normalizeNewlines(value) {
        return String(value == null ? "" : value).replace(/\r\n?/g, "\n");
    }

    function trimBlankLines(value) {
        return normalizeNewlines(value).replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
    }

    function toEpochSeconds(value) {
        if (value == null || value === "") return 0;
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.max(0, Math.floor(value > 100000000000 ? value / 1000 : value));
        }
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return Math.max(0, Math.floor(numeric > 100000000000 ? numeric / 1000 : numeric));
        }
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
    }

    function toIso(seconds) {
        if (!seconds) return "";
        return new Date(seconds * 1000).toISOString();
    }

    function formatDateTime(seconds, options) {
        if (!seconds) return "";
        const date = new Date(seconds * 1000);
        if (Number.isNaN(date.getTime())) return "";
        const opts = Object.assign({
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        }, options || {});
        try {
            return new Intl.DateTimeFormat(undefined, opts).format(date);
        } catch (error) {
            return date.toLocaleString();
        }
    }

    function formatDateStamp(seconds) {
        const date = seconds ? new Date(seconds * 1000) : new Date();
        if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }

    function cleanTitle(value, fallback) {
        let title = normalizeNewlines(value)
            .replace(/\s+/g, " ")
            .replace(/^[\s#*_`"'\-–—]+|[\s#*_`"'\-–—]+$/g, "")
            .trim();
        if (!title || /^(?:deepseek|deepseek chat|new chat|untitled)$/i.test(title)) {
            title = fallback || "DeepSeek conversation";
        }
        return title.slice(0, 160);
    }

    function sanitizeFilenamePart(value) {
        let name = String(value == null ? "" : value)
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .replace(/[<>:"/\\|?*]+/g, "-")
            .replace(/\s+/g, " ")
            .replace(/\s*-\s*/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-. ]+|[-. ]+$/g, "")
            .trim();
        if (!name) name = "DeepSeek conversation";
        if (name.length > 100) name = name.slice(0, 100).replace(/[. ]+$/g, "");
        // Windows reserved device names.
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name += "-chat";
        return name;
    }

    function makeBaseFilename(conversation, dateSeconds) {
        const title = sanitizeFilenamePart(cleanTitle(conversation && conversation.title));
        const stamp = formatDateStamp(dateSeconds || Math.floor(Date.now() / 1000));
        return `${title} - ${stamp}`;
    }

    function makeFilename(conversation, format) {
        const info = FORMATS[format] || FORMATS.md;
        return `${makeBaseFilename(conversation)}.${info.extension}`;
    }

    function displayModelName(value) {
        const model = String(value || "").trim();
        if (!model) return "";
        if (/reason|r1/i.test(model)) return "DeepSeek Reasoner";
        if (/vision|vl/i.test(model)) return "DeepSeek Vision";
        if (/chat|default/i.test(model)) return "DeepSeek Chat";
        return model.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function countWords(value) {
        const text = String(value == null ? "" : value).trim();
        if (!text) return 0;
        return (text.match(/[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF]+/g) || []).length;
    }

    /**
     * Pure rate-limit evaluator. The background worker calls this while
     * holding a lock, then persists the returned timestamps.
     */
    function evaluateExportRateLimit(timestamps, now, config) {
        const settings = Object.assign({}, RATE_LIMIT, config || {});
        const current = Number.isFinite(now) ? now : Date.now();
        const cutoff = current - settings.windowMs;
        const recent = (Array.isArray(timestamps) ? timestamps : [])
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > cutoff && value <= current)
            .sort((left, right) => left - right);

        const cooldownRemaining = recent.length
            ? Math.max(0, recent[recent.length - 1] + settings.minIntervalMs - current)
            : 0;
        const windowRemaining = recent.length >= settings.maxExports
            ? Math.max(0, recent[recent.length - settings.maxExports] + settings.windowMs - current)
            : 0;

        if (cooldownRemaining > 0 || windowRemaining > 0) {
            return {
                allowed: false,
                reason: windowRemaining > 0 ? "window" : "cooldown",
                retryAfterMs: Math.max(1000, cooldownRemaining, windowRemaining),
                remaining: Math.max(0, settings.maxExports - recent.length),
                limit: settings.maxExports,
                windowMs: settings.windowMs,
                minIntervalMs: settings.minIntervalMs,
                timestamps: recent,
            };
        }

        const next = recent.concat(current);
        return {
            allowed: true,
            retryAfterMs: 0,
            remaining: Math.max(0, settings.maxExports - next.length),
            limit: settings.maxExports,
            windowMs: settings.windowMs,
            minIntervalMs: settings.minIntervalMs,
            resetAt: next[0] + settings.windowMs,
            timestamps: next,
        };
    }

    /* ---------------------------------------------------------------------
     * A deliberately small, safe Markdown renderer.
     * Raw HTML in a model response is escaped, never interpreted. The output
     * is used only in the exported HTML and the print-to-PDF page.
     * ------------------------------------------------------------------- */

    const INLINE_TOKEN_OPEN = "\u0000";
    const INLINE_TOKEN_CLOSE = "\u0001";

    function renderInline(rawText) {
        const tokens = [];
        const stash = (html) => {
            const index = tokens.push(html) - 1;
            return `${INLINE_TOKEN_OPEN}${index}${INLINE_TOKEN_CLOSE}`;
        };

        let text = escapeHtml(rawText);

        // Code spans are protected before any other inline formatting.
        text = text.replace(/(`+)([^`]*?)\1/g, (match, ticks, code) => {
            if (!code) return match;
            return stash(`<code>${code}</code>`);
        });

        // Images are intentionally reduced to links; no remote content is
        // embedded into an export.
        text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (match, alt, url) => {
            const href = safeUrl(url.replace(/&amp;/g, "&"));
            if (!href) return escapeHtml(alt || "image");
            return stash(`<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(alt || "image")}</a>`);
        });

        // Markdown links.
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (match, label, url, title) => {
            const href = safeUrl(url.replace(/&amp;/g, "&"));
            if (!href) return label;
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
            return stash(`<a href="${escapeHtml(href)}"${titleAttr} rel="noreferrer noopener">${label}</a>`);
        });

        // Angle-bracket autolinks.
        text = text.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (match, url) => {
            const href = safeUrl(url);
            if (!href) return match;
            return stash(`<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(href)}</a>`);
        });

        // Bare URLs. Trailing punctuation is kept outside the link.
        text = text.replace(/\bhttps?:\/\/[^\s<>"']+/g, (match) => {
            let url = match;
            let trailing = "";
            while (/[.,;:!?]$/.test(url)) {
                trailing = url.slice(-1) + trailing;
                url = url.slice(0, -1);
            }
            const href = safeUrl(url);
            if (!href) return match;
            return stash(`<a href="${escapeHtml(href)}" rel="noreferrer noopener">${escapeHtml(url)}</a>`) + trailing;
        });

        text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
        text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
        text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
        text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

        text = text.replace(/\u0000(\d+)\u0001/g, (match, index) => tokens[Number(index)] || match);
        return text;
    }

    function isTableDelimiter(line) {
        const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
        if (!trimmed || !trimmed.includes("|")) return false;
        return trimmed.split("|").every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
    }

    function splitTableRow(line) {
        let row = line.trim();
        if (row.startsWith("|")) row = row.slice(1);
        if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
        const cells = [];
        let current = "";
        for (let i = 0; i < row.length; i += 1) {
            if (row[i] === "\\" && row[i + 1] === "|") {
                current += "|";
                i += 1;
            } else if (row[i] === "|") {
                cells.push(current.trim());
                current = "";
            } else {
                current += row[i];
            }
        }
        cells.push(current.trim());
        return cells;
    }

    function tableAlignment(line) {
        return splitTableRow(line).map((cell) => {
            const value = cell.trim();
            const left = value.startsWith(":");
            const right = value.endsWith(":");
            if (left && right) return "center";
            if (right) return "right";
            if (left) return "left";
            return "";
        });
    }

    function isFenceStart(line) {
        return /^ {0,3}(`{3,}|~{3,})/.test(line);
    }

    function isBlockStart(lines, index) {
        const line = lines[index];
        if (line == null) return true;
        if (!line.trim()) return true;
        if (isFenceStart(line)) return true;
        if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
        if (/^ {0,3}(?:[-*_]\s*){3,}$/.test(line)) return true;
        if (/^ {0,3}>/.test(line)) return true;
        if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])\s+/.test(line)) return true;
        if (line.includes("|") && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) return true;
        return false;
    }

    function renderMarkdown(source) {
        const lines = normalizeNewlines(source).replace(/\t/g, "    ").split("\n");
        const out = [];
        let index = 0;

        while (index < lines.length) {
            const line = lines[index];

            if (!line.trim()) {
                index += 1;
                continue;
            }

            // Fenced code block.
            const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^\n]*$/);
            if (fence) {
                const marker = fence[1][0];
                const length = fence[1].length;
                const language = (fence[2] || "").replace(/[^A-Za-z0-9_+#.-]/g, "").slice(0, 32);
                const codeLines = [];
                index += 1;
                while (index < lines.length) {
                    const close = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
                    if (close && close[1][0] === marker && close[1].length >= length) {
                        index += 1;
                        break;
                    }
                    codeLines.push(lines[index]);
                    index += 1;
                }
                const langClass = language ? ` class="language-${escapeHtml(language)}"` : "";
                const label = language
                    ? `<span class="code-lang">${escapeHtml(language)}</span>`
                    : "";
                out.push(`<div class="code-block">${label}<pre><code${langClass}>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
                continue;
            }

            // ATX heading.
            const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
            if (heading) {
                const level = heading[1].length;
                out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
                index += 1;
                continue;
            }

            // Horizontal rule.
            if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
                out.push("<hr>");
                index += 1;
                continue;
            }

            // Blockquote.
            if (/^ {0,3}>/.test(line)) {
                const quote = [];
                while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
                    quote.push(lines[index].replace(/^ {0,3}>\s?/, ""));
                    index += 1;
                }
                out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
                continue;
            }

            // Table.
            if (line.includes("|") && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
                const headerCells = splitTableRow(line);
                const alignments = tableAlignment(lines[index + 1]);
                index += 2;
                const rows = [];
                while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
                    rows.push(splitTableRow(lines[index]));
                    index += 1;
                }
                const head = headerCells.map((cell, cellIndex) => {
                    const align = alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]}"` : "";
                    return `<th${align}>${renderInline(cell)}</th>`;
                }).join("");
                const body = rows.map((row) => {
                    const cells = headerCells.map((unused, cellIndex) => {
                        const align = alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]}"` : "";
                        return `<td${align}>${renderInline(row[cellIndex] || "")}</td>`;
                    }).join("");
                    return `<tr>${cells}</tr>`;
                }).join("");
                out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
                continue;
            }

            // Lists. Continuation lines are folded into the current item.
            const listStart = line.match(/^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/);
            if (listStart) {
                const ordered = /\d/.test(listStart[2]);
                const baseIndent = listStart[1].length;
                const items = [];
                while (index < lines.length) {
                    const item = lines[index].match(/^(\s*)([-+*]|\d{1,9}[.)])\s+(.*)$/);
                    if (!item || item[1].length < baseIndent) break;
                    if (item[1].length > baseIndent) {
                        // Nested list or continuation: keep it in the item body.
                        if (items.length) items[items.length - 1].push(lines[index].trim());
                        index += 1;
                        continue;
                    }
                    if (/\d/.test(item[2]) !== ordered) break;
                    items.push([item[3]]);
                    index += 1;
                    // Lines that belong to this item without a new bullet.
                    while (index < lines.length && lines[index].trim()) {
                        const next = lines[index];
                        if (/^\s*(?:[-+*]|\d{1,9}[.)])\s+/.test(next)) break;
                        if (isBlockStart(lines, index)) break;
                        if (/^\s{2,}\S/.test(next)) {
                            items[items.length - 1].push(next.trim());
                            index += 1;
                        } else {
                            break;
                        }
                    }
                }
                const tag = ordered ? "ol" : "ul";
                const htmlItems = items.map((parts) => {
                    let body = parts.join(" ");
                    const task = body.match(/^\[([ xX])\]\s+(.*)$/);
                    let prefix = "";
                    if (task) {
                        prefix = `<span class="task-box" aria-hidden="true">${task[1].toLowerCase() === "x" ? "☑" : "☐"}</span> `;
                        body = task[2];
                    }
                    return `<li>${prefix}${renderInline(body)}</li>`;
                }).join("");
                out.push(`<${tag}>${htmlItems}</${tag}>`);
                continue;
            }

            // Paragraph.
            const paragraph = [line];
            index += 1;
            while (index < lines.length && !isBlockStart(lines, index)) {
                paragraph.push(lines[index]);
                index += 1;
            }
            out.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
        }

        return out.join("\n");
    }

    /* ---------------------------------------------------------------------
     * API normalization
     * ------------------------------------------------------------------- */

    function unwrapApiPayload(payload) {
        let data = payload;
        if (data && typeof data === "object" && data.data != null) data = data.data;
        if (data && typeof data === "object" && data.biz_data != null) data = data.biz_data;
        if (data && typeof data === "object" && data.data != null && data.data.chat_messages) data = data.data;
        return data || {};
    }

    function fragmentType(fragment) {
        return String(fragment && fragment.type || "").toUpperCase();
    }

    function fragmentText(fragment) {
        if (!fragment || typeof fragment !== "object") return "";
        if (typeof fragment.content === "string") return trimBlankLines(fragment.content);
        if (typeof fragment.text === "string") return trimBlankLines(fragment.text);
        return "";
    }

    function visibleApiText(raw) {
        const role = String(raw && raw.role || "").toUpperCase();
        const accepted = role === "USER"
            ? new Set(["REQUEST"])
            : new Set(["RESPONSE", "TEMPLATE_RESPONSE"]);
        const fragments = Array.isArray(raw && raw.fragments) ? raw.fragments : [];
        const acceptedText = fragments
            .filter((fragment) => accepted.has(fragmentType(fragment)))
            .map(fragmentText)
            .filter(Boolean)
            .join("\n\n");
        if (acceptedText.trim()) return trimBlankLines(acceptedText);

        if (raw && typeof raw.content === "string" && raw.content.trim()) {
            return trimBlankLines(raw.content);
        }
        if (raw && typeof raw.text === "string" && raw.text.trim()) {
            return trimBlankLines(raw.text);
        }

        const special = new Set(["THINK", "SEARCH", "TOOL_SEARCH", "TOOL_OPEN", "TIP", "FILE"]);
        return trimBlankLines(fragments
            .filter((fragment) => !special.has(fragmentType(fragment)))
            .map(fragmentText)
            .filter(Boolean)
            .join("\n\n"));
    }

    function fileUrl(file) {
        if (!file || typeof file !== "object") return "";
        const raw = file.signed_path || file.url || file.download_url || "";
        if (!raw || typeof raw !== "string") return "";
        if (/^\/file(?:\?|$)/.test(raw)) {
            return `https://files.deepseeksvc.com/api${raw}`;
        }
        return safeUrl(raw);
    }

    function collectFiles(raw) {
        const files = [];
        const seen = new Set();
        const push = (file) => {
            if (!file || typeof file !== "object") return;
            const name = file.file_name || file.filename || file.name || file.title || "Attachment";
            const url = fileUrl(file);
            const key = `${name}|${url}`;
            if (seen.has(key)) return;
            seen.add(key);
            files.push({
                name: String(name).slice(0, 240),
                url,
                mime: String(file.mime_type || file.mimetype || file.type || ""),
            });
        };
        if (Array.isArray(raw && raw.files)) raw.files.forEach(push);
        const fragments = Array.isArray(raw && raw.fragments) ? raw.fragments : [];
        for (const fragment of fragments) {
            if (!fragment || typeof fragment !== "object") continue;
            if (Array.isArray(fragment.files)) fragment.files.forEach(push);
            if (fragment.file) push(fragment.file);
        }
        return files;
    }

    function collectSources(raw) {
        const found = [];
        const seen = new Set();
        const walk = (value, depth) => {
            if (!value || typeof value !== "object" || depth > 6) return;
            if (Array.isArray(value)) {
                value.forEach((item) => walk(item, depth + 1));
                return;
            }
            if (typeof value.url === "string") {
                const url = safeUrl(value.url);
                if (url && !seen.has(url) && !/^https:\/\/chat\.deepseek\.com/i.test(url)) {
                    seen.add(url);
                    found.push({
                        title: String(value.title || value.site_name || value.name || url).slice(0, 240),
                        url,
                    });
                }
            }
            Object.keys(value).forEach((key) => {
                if (key === "url" || key === "signed_path" || key === "download_url") return;
                walk(value[key], depth + 1);
            });
        };
        const fragments = Array.isArray(raw && raw.fragments) ? raw.fragments : [];
        for (const fragment of fragments) {
            const type = fragmentType(fragment);
            if (type === "SEARCH" || type === "TOOL_SEARCH" || type === "TOOL_OPEN") {
                walk(fragment, 0);
            }
        }
        return found.slice(0, 40);
    }

    function collectThinking(raw) {
        const fragments = Array.isArray(raw && raw.fragments) ? raw.fragments : [];
        const text = fragments
            .filter((fragment) => fragmentType(fragment) === "THINK")
            .map(fragmentText)
            .filter(Boolean)
            .join("\n\n");
        return trimBlankLines(text);
    }

    function inferTitle(messages) {
        const firstUser = messages.find((message) => message.role === "user" && message.text);
        if (!firstUser) return "DeepSeek conversation";
        const firstLine = firstUser.text.split("\n").find((line) => line.trim()) || "DeepSeek conversation";
        return firstLine.replace(/^#+\s*/, "").slice(0, 90);
    }

    function activeApiMessages(rawMessages, session) {
        const byId = new Map();
        for (const raw of rawMessages) {
            if (!raw || typeof raw !== "object") continue;
            const id = raw.message_id != null ? String(raw.message_id) : (raw.id != null ? String(raw.id) : "");
            if (id) byId.set(id, raw);
        }
        if (!byId.size) return rawMessages.slice();

        let currentId = session && session.current_message_id != null
            ? String(session.current_message_id)
            : "";
        if (!currentId || !byId.has(currentId)) {
            const parentIds = new Set();
            for (const raw of byId.values()) {
                if (raw.parent_id != null) parentIds.add(String(raw.parent_id));
            }
            const leaves = Array.from(byId.values()).filter((raw) => {
                const id = raw.message_id != null ? String(raw.message_id) : String(raw.id);
                return !parentIds.has(id);
            });
            const candidates = leaves.length ? leaves : Array.from(byId.values());
            candidates.sort((a, b) => toEpochSeconds(a.inserted_at) - toEpochSeconds(b.inserted_at));
            currentId = candidates.length
                ? String(candidates[candidates.length - 1].message_id != null
                    ? candidates[candidates.length - 1].message_id
                    : candidates[candidates.length - 1].id)
                : "";
        }

        const path = [];
        const visited = new Set();
        while (currentId && !visited.has(currentId)) {
            visited.add(currentId);
            const raw = byId.get(currentId);
            if (!raw) break;
            path.push(raw);
            currentId = raw.parent_id != null ? String(raw.parent_id) : "";
        }
        return path.length ? path.reverse() : rawMessages.slice();
    }

    function normalizeApiConversation(payload, meta) {
        const info = meta || {};
        const data = unwrapApiPayload(payload);
        const session = data.chat_session || data.chatSession || data.session || {};
        const rawMessages = Array.isArray(data.chat_messages)
            ? data.chat_messages
            : Array.isArray(data.messages)
                ? data.messages
                : [];
        if (!rawMessages.length) {
            throw new Error("DeepSeek returned no messages for this chat.");
        }

        const active = activeApiMessages(rawMessages, session);
        const messages = [];
        for (const raw of active) {
            const role = String(raw.role || "").toLowerCase();
            if (role !== "user" && role !== "assistant") continue;
            const text = visibleApiText(raw);
            const reasoning = role === "assistant" ? collectThinking(raw) : "";
            const attachments = collectFiles(raw);
            if (!text && !reasoning && !attachments.length) continue;
            const time = toEpochSeconds(raw.inserted_at || raw.created_at || raw.create_time);
            messages.push({
                id: raw.message_id != null ? String(raw.message_id) : (raw.id != null ? String(raw.id) : ""),
                role,
                text,
                reasoning,
                attachments,
                sources: role === "assistant" ? collectSources(raw) : [],
                createdAt: time,
                model: String(raw.model || ""),
            });
        }
        if (!messages.length) {
            throw new Error("This chat has no user or assistant messages to export.");
        }

        const firstTime = messages.find((message) => message.createdAt)?.createdAt || 0;
        const lastTime = [...messages].reverse().find((message) => message.createdAt)?.createdAt || 0;
        const createdAt = toEpochSeconds(session.inserted_at || session.created_at || firstTime);
        const updatedAt = toEpochSeconds(session.updated_at || session.update_time || lastTime || createdAt);
        const title = cleanTitle(
            session.title || data.title || info.title,
            inferTitle(messages)
        );

        return {
            id: String(session.id || info.chatId || ""),
            title,
            url: info.url || (info.chatId ? `https://chat.deepseek.com/a/chat/s/${info.chatId}` : "https://chat.deepseek.com/"),
            model: String(session.model_type || messages.find((message) => message.model)?.model || ""),
            createdAt,
            updatedAt,
            exportedAt: new Date().toISOString(),
            source: "api",
            messages,
        };
    }

    function normalizePageConversation(rawMessages, meta) {
        const info = meta || {};
        const messages = [];
        for (const raw of rawMessages || []) {
            if (!raw) continue;
            const role = raw.role === "assistant" ? "assistant" : "user";
            const text = trimBlankLines(raw.text);
            if (!text) continue;
            if (messages.length) {
                const previous = messages[messages.length - 1];
                if (previous.role === role && previous.text === text) continue;
            }
            messages.push({
                id: raw.id || `page-${messages.length + 1}`,
                role,
                text,
                reasoning: "",
                attachments: [],
                sources: [],
                createdAt: toEpochSeconds(raw.createdAt),
                model: "",
            });
        }
        if (!messages.length) {
            throw new Error("No conversation text was found on the page. Make sure the chat is open and has finished loading.");
        }
        return {
            id: String(info.chatId || ""),
            title: cleanTitle(info.title, inferTitle(messages)),
            url: info.url || "https://chat.deepseek.com/",
            model: "",
            createdAt: messages[0]?.createdAt || 0,
            updatedAt: messages[messages.length - 1]?.createdAt || 0,
            exportedAt: new Date().toISOString(),
            source: "page",
            messages,
        };
    }

    /* ---------------------------------------------------------------------
     * Export serializers
     * ------------------------------------------------------------------- */

    function allSources(conversation) {
        const result = [];
        const seen = new Set();
        for (const message of conversation.messages || []) {
            for (const source of message.sources || []) {
                if (!source || !source.url || seen.has(source.url)) continue;
                seen.add(source.url);
                result.push(source);
            }
        }
        return result;
    }

    function metadataLines(conversation, options) {
        const lines = [];
        lines.push(`Source: ${conversation.url}`);
        if (conversation.model) lines.push(`Model: ${displayModelName(conversation.model)}`);
        lines.push(`Exported: ${formatDateTime(Math.floor(Date.parse(conversation.exportedAt || "") / 1000) || Math.floor(Date.now() / 1000))}`);
        lines.push(`Messages: ${conversation.messages.length}`);
        if (conversation.source === "page") {
            lines.push("Capture: visible page text (the DeepSeek API was unavailable)");
        }
        return lines;
    }

    function attachmentMarkdown(attachments) {
        if (!attachments || !attachments.length) return "";
        return attachments.map((attachment) => {
            if (attachment.url) {
                return `- [${escapeMarkdownLinkLabel(attachment.name)}](${escapeMarkdownLinkUrl(attachment.url)})`;
            }
            return `- ${attachment.name}`;
        }).join("\n");
    }

    function buildMarkdown(conversation, options) {
        const opts = options || {};
        const chunks = [`# ${conversation.title}`];
        const meta = metadataLines(conversation, opts);
        chunks.push(meta.map((line) => `> ${line}`).join("  \n"));
        chunks.push("---");

        conversation.messages.forEach((message, index) => {
            const label = message.role === "user" ? "You" : "DeepSeek";
            const heading = [`## ${label}`];
            if (opts.includeTimestamps && message.createdAt) {
                heading.push(`_${formatDateTime(message.createdAt)}_`);
            }
            chunks.push(heading.join("\n\n"));
            if (opts.includeReasoning && message.reasoning) {
                chunks.push(`<details>\n<summary>Reasoning</summary>\n\n${message.reasoning}\n\n</details>`);
            }
            if (message.text) chunks.push(message.text);
            if (message.attachments && message.attachments.length) {
                chunks.push(`**Attachments**\n\n${attachmentMarkdown(message.attachments)}`);
            }
            if (index < conversation.messages.length - 1) chunks.push("---");
        });

        const sources = allSources(conversation);
        if (sources.length) {
            chunks.push("---");
            chunks.push("## Sources");
            chunks.push(sources.map((source) => `- [${escapeMarkdownLinkLabel(source.title)}](${escapeMarkdownLinkUrl(source.url)})`).join("\n"));
        }
        chunks.push(`*Exported with Seek the Deep on ${formatDateTime(Math.floor(Date.now() / 1000))}.*`);
        return `${chunks.join("\n\n").trim()}\n`;
    }

    function buildText(conversation, options) {
        const opts = options || {};
        const width = 78;
        const line = "=".repeat(width);
        const thin = "-".repeat(width);
        const chunks = [
            conversation.title.toUpperCase(),
            line,
            ...metadataLines(conversation, opts),
            line,
        ];

        conversation.messages.forEach((message) => {
            const role = message.role === "user" ? "YOU" : "DEEPSEEK";
            const stamp = opts.includeTimestamps && message.createdAt
                ? `  ·  ${formatDateTime(message.createdAt)}`
                : "";
            chunks.push("");
            chunks.push(`${role}${stamp}`);
            chunks.push(thin);
            if (opts.includeReasoning && message.reasoning) {
                chunks.push("[Reasoning]");
                chunks.push(message.reasoning);
                chunks.push("");
            }
            chunks.push(message.text || "");
            if (message.attachments && message.attachments.length) {
                chunks.push("");
                chunks.push("Attachments:");
                for (const attachment of message.attachments) {
                    chunks.push(attachment.url ? `  - ${attachment.name}: ${attachment.url}` : `  - ${attachment.name}`);
                }
            }
            chunks.push("");
        });

        const sources = allSources(conversation);
        if (sources.length) {
            chunks.push(thin);
            chunks.push("SOURCES");
            sources.forEach((source, index) => {
                chunks.push(`  ${index + 1}. ${source.title}`);
                chunks.push(`     ${source.url}`);
            });
        }
        return `${chunks.join("\n").trim()}\n`;
    }

    function buildJson(conversation) {
        const payload = {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
            exportedAt: conversation.exportedAt || new Date().toISOString(),
            source: conversation.source || "api",
            conversation: {
                id: conversation.id || "",
                title: conversation.title,
                url: conversation.url,
                model: conversation.model || "",
                createdAt: toIso(conversation.createdAt),
                updatedAt: toIso(conversation.updatedAt),
                messageCount: conversation.messages.length,
                messages: conversation.messages.map((message) => ({
                    id: message.id || "",
                    role: message.role,
                    createdAt: toIso(message.createdAt),
                    model: message.model || "",
                    text: message.text || "",
                    reasoning: message.reasoning || "",
                    attachments: (message.attachments || []).map((attachment) => ({
                        name: attachment.name,
                        url: attachment.url || "",
                        mime: attachment.mime || "",
                    })),
                    sources: (message.sources || []).map((source) => ({
                        title: source.title,
                        url: source.url,
                    })),
                })),
            },
        };
        return `${JSON.stringify(payload, null, 2)}\n`;
    }

    const DOCUMENT_CSS = `
:root {
  --ink: #16181d;
  --muted: #626875;
  --line: #e2e6ee;
  --soft: #f5f7fb;
  --blue: #4d6bfe;
  --blue-deep: #2d49d4;
  --code-bg: #f6f8fa;
  --paper: #ffffff;
}
* { box-sizing: border-box; }
html { color-scheme: light; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.doc {
  max-width: 820px;
  margin: 0 auto;
  padding: 48px 44px 56px;
}
.doc-header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 30px; }
.brand-line { display: flex; align-items: center; gap: 8px; color: var(--blue-deep); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 12px; }
.brand-mark { width: 18px; height: 18px; border-radius: 5px; display: inline-grid; place-items: center; color: #fff; background: linear-gradient(145deg, #607dff, #3550dd); font-size: 9px; letter-spacing: 0; }
h1 { font-size: 30px; line-height: 1.22; letter-spacing: -.025em; margin: 0 0 14px; color: #101217; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 12.5px; }
.meta a { color: var(--blue-deep); text-decoration: none; }
.meta span { display: inline-flex; align-items: center; gap: 5px; }
.meta .dot { width: 3px; height: 3px; border-radius: 50%; background: #aeb5c4; display: inline-block; }
.message { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 18px; padding: 22px 0; border-bottom: 1px solid var(--line); break-inside: avoid; }
.message:last-of-type { border-bottom: 0; }
.message-role { padding-top: 2px; font-size: 12px; font-weight: 700; letter-spacing: .02em; color: var(--muted); }
.message.assistant .message-role { color: var(--blue-deep); }
.message-time { display: block; font-weight: 400; color: #9299a8; font-size: 11px; margin-top: 3px; }
.message-body { min-width: 0; overflow-wrap: anywhere; }
.message-body > :first-child { margin-top: 0; }
.message-body > :last-child { margin-bottom: 0; }
.message-body p { margin: 0 0 12px; }
.message-body h1, .message-body h2, .message-body h3, .message-body h4, .message-body h5, .message-body h6 { line-height: 1.3; margin: 24px 0 10px; color: #101217; }
.message-body h1 { font-size: 24px; }
.message-body h2 { font-size: 20px; }
.message-body h3 { font-size: 17px; }
.message-body h4, .message-body h5, .message-body h6 { font-size: 15px; }
.message-body ul, .message-body ol { margin: 0 0 13px; padding-left: 24px; }
.message-body li { margin: 4px 0; }
.message-body li > ul, .message-body li > ol { margin-top: 4px; }
.message-body blockquote { margin: 14px 0; padding: 4px 0 4px 16px; border-left: 3px solid #c9d3ff; color: #4b5262; }
.message-body blockquote p:last-child { margin-bottom: 0; }
.message-body hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
.message-body a { color: var(--blue-deep); text-decoration: underline; text-underline-offset: 2px; }
.message-body strong { font-weight: 650; }
.message-body code { font-family: "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: .88em; background: #eef1f6; border: 1px solid #e1e5ed; border-radius: 4px; padding: .1em .34em; overflow-wrap: anywhere; }
.code-block { position: relative; margin: 14px 0; border: 1px solid #dfe3eb; border-radius: 9px; background: var(--code-bg); overflow: hidden; break-inside: avoid; }
.code-lang { display: block; padding: 6px 12px; border-bottom: 1px solid #e4e8ef; color: #737b8c; background: #f0f3f8; font: 600 10.5px/1.4 "Cascadia Code", Consolas, monospace; text-transform: lowercase; }
.message-body pre { margin: 0; padding: 13px 15px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.message-body pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; margin: 14px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
th { background: var(--soft); font-weight: 650; }
.reasoning { margin: 0 0 15px; border: 1px solid #e5e8f0; border-radius: 8px; background: #f8f9fc; padding: 0 13px; }
.reasoning summary { cursor: pointer; padding: 9px 0; color: #687083; font-size: 12.5px; font-weight: 600; }
.reasoning-body { padding: 2px 0 12px; color: #596173; font-size: 13.5px; }
.reasoning-body > :first-child { margin-top: 0; }
.reasoning-body > :last-child { margin-bottom: 0; }
.attachments { margin: 14px 0 0; padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); font-size: 13px; }
.attachments-title { margin: 0 0 5px; font-size: 11px; font-weight: 700; color: var(--muted); letter-spacing: .05em; text-transform: uppercase; }
.attachments ul { margin: 0; padding-left: 18px; }
.attachments a { color: var(--blue-deep); }
.sources { margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); }
.sources h2 { font-size: 15px; margin: 0 0 10px; }
.sources ol { margin: 0; padding-left: 22px; font-size: 12.5px; color: var(--muted); }
.sources li { margin: 5px 0; overflow-wrap: anywhere; }
.sources a { color: var(--blue-deep); }
.doc-footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid var(--line); color: #8a91a0; font-size: 11.5px; display: flex; justify-content: space-between; gap: 20px; }
.task-box { color: var(--blue-deep); font-weight: 700; }
@media (max-width: 620px) {
  .doc { padding: 30px 22px 40px; }
  .message { grid-template-columns: 1fr; gap: 5px; padding: 18px 0; }
  .message-role { padding-top: 0; }
  .message-time { display: inline; margin-left: 8px; }
  h1 { font-size: 25px; }
}
@media print {
  @page { size: A4; margin: 17mm 16mm 18mm; }
  html, body { background: #fff; }
  body { font-size: 10.5pt; line-height: 1.55; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .doc { max-width: none; padding: 0; }
  .doc-header { margin-bottom: 20px; padding-bottom: 16px; }
  h1 { font-size: 23pt; }
  .brand-line { margin-bottom: 8px; }
  .meta { font-size: 8.5pt; gap: 3px 12px; }
  .message { grid-template-columns: 64px minmax(0, 1fr); gap: 14px; padding: 14px 0; }
  .message-role { font-size: 8.5pt; }
  .message-time { font-size: 7.5pt; }
  .message-body p { margin-bottom: 8px; }
  .message-body pre code { font-size: 8.5pt; }
  .code-block, .reasoning, .attachments, table, tr, img { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  .sources { break-inside: avoid; }
  .doc-footer { margin-top: 22px; font-size: 8pt; }
  .doc-footer span:last-child { text-align: right; }
  a { color: #2442c9 !important; }
}
`;

    function messageHtml(message, options) {
        const opts = options || {};
        const isUser = message.role === "user";
        const roleLabel = isUser ? "You" : "DeepSeek";
        const time = opts.includeTimestamps && message.createdAt
            ? `<span class="message-time">${escapeHtml(formatDateTime(message.createdAt))}</span>`
            : "";
        const reasoning = opts.includeReasoning && message.reasoning
            ? `<details class="reasoning" open><summary>Reasoning</summary><div class="reasoning-body">${renderMarkdown(message.reasoning)}</div></details>`
            : "";
        const attachments = message.attachments && message.attachments.length
            ? `<div class="attachments"><p class="attachments-title">Attachments</p><ul>${message.attachments.map((attachment) => {
                const name = escapeHtml(attachment.name);
                const url = safeUrl(attachment.url);
                return `<li>${url ? `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${name}</a>` : name}</li>`;
            }).join("")}</ul></div>`
            : "";
        return `<article class="message ${isUser ? "user" : "assistant"}">
<div class="message-role">${roleLabel}${time}</div>
<div class="message-body">${reasoning}${renderMarkdown(message.text || "")}${attachments}</div>
</article>`;
    }

    function buildHtmlBody(conversation, options) {
        const opts = options || {};
        const meta = [
            `<span>${escapeHtml(conversation.messages.length)} messages</span>`,
        ];
        if (conversation.model) meta.push(`<span>${escapeHtml(displayModelName(conversation.model))}</span>`);
        if (conversation.createdAt) meta.push(`<span>Started ${escapeHtml(formatDateTime(conversation.createdAt, { year: "numeric", month: "short", day: "numeric" }))}</span>`);
        if (conversation.url) meta.push(`<span><a href="${escapeHtml(safeUrl(conversation.url))}" rel="noreferrer noopener">Open in DeepSeek</a></span>`);
        if (conversation.source === "page") meta.push("<span>Captured from visible page</span>");

        const messages = conversation.messages.map((message) => messageHtml(message, opts)).join("\n");
        const sources = allSources(conversation);
        const sourcesHtml = sources.length
            ? `<section class="sources"><h2>Sources</h2><ol>${sources.map((source) => `<li><a href="${escapeHtml(safeUrl(source.url))}" rel="noreferrer noopener">${escapeHtml(source.title)}</a></li>`).join("")}</ol></section>`
            : "";
        return `<div class="doc">
<header class="doc-header">
<div class="brand-line"><span class="brand-mark">DS</span> Seek the Deep</div>
<h1>${escapeHtml(conversation.title)}</h1>
<div class="meta">${meta.join("")}</div>
</header>
<main>
${messages}
</main>
${sourcesHtml}
<footer class="doc-footer"><span>Exported ${escapeHtml(formatDateTime(Math.floor(Date.now() / 1000)))}</span><span>Seek the Deep</span></footer>
</div>`;
    }

    function buildHtmlDocument(conversation, options) {
        const body = buildHtmlBody(conversation, options);
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Seek the Deep">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(conversation.title)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
    }

    function serialize(conversation, format, options) {
        switch (format) {
            case "md": return buildMarkdown(conversation, options);
            case "txt": return buildText(conversation, options);
            case "html": return buildHtmlDocument(conversation, options);
            case "json": return buildJson(conversation);
            default: throw new Error(`Unsupported export format: ${format}`);
        }
    }

    return {
        EXPORT_FORMAT,
        EXPORT_VERSION,
        FORMATS,
        RATE_LIMIT,
        DOCUMENT_CSS,
        escapeHtml,
        safeUrl,
        normalizeNewlines,
        trimBlankLines,
        toEpochSeconds,
        toIso,
        formatDateTime,
        formatDateStamp,
        cleanTitle,
        sanitizeFilenamePart,
        makeBaseFilename,
        makeFilename,
        displayModelName,
        countWords,
        evaluateExportRateLimit,
        renderMarkdown,
        normalizeApiConversation,
        normalizePageConversation,
        buildMarkdown,
        buildText,
        buildJson,
        buildHtmlBody,
        buildHtmlDocument,
        serialize,
    };
});
