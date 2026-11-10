/*
 * Seek the Deep — print / Save-as-PDF page
 */
(function initPrintPage() {
    "use strict";

    const DS = globalThis.DSExport;
    const doc = document.getElementById("doc");
    const status = document.getElementById("status");
    const toolbarMeta = document.getElementById("toolbarMeta");
    const printButton = document.getElementById("printBtn");
    const closeButton = document.getElementById("closeBtn");
    let job = null;
    let printedOnce = false;

    function setStatus(type, text) {
        status.className = `print-status ${type || ""}`.trim();
        status.textContent = text;
    }

    function injectDocumentStyles() {
        const style = document.createElement("style");
        style.textContent = DS.DOCUMENT_CSS;
        document.head.appendChild(style);
    }

    function showEmpty(message) {
        toolbarMeta.textContent = "Nothing to print";
        toolbarMeta.classList.add("error");
        setStatus("error", "The printable conversation could not be loaded.");
        doc.innerHTML = `<div class="empty-doc"><h1>No conversation to print</h1><p>${DS.escapeHtml(message)}</p></div>`;
    }

    function doPrint() {
        if (!job) return;
        setStatus("ready", "Choose “Save as PDF” as the destination in the print dialog.");
        window.print();
        if (printedOnce) {
            setStatus("", "Print dialog closed. Use the button above to print again.");
        }
        printedOnce = true;
    }

    async function init() {
        injectDocumentStyles();
        printButton.addEventListener("click", doPrint);
        closeButton.addEventListener("click", () => window.close());

        let stored;
        try {
            stored = await chrome.storage.local.get("printJob");
        } catch (error) {
            showEmpty(error.message || String(error));
            return;
        }

        job = stored && stored.printJob;
        if (!job || typeof job.html !== "string" || !job.html.trim()) {
            showEmpty("Return to the DeepSeek conversation and choose PDF again.");
            return;
        }

        const title = String(job.title || "DeepSeek conversation").slice(0, 120);
        document.title = title;
        doc.innerHTML = job.html;
        toolbarMeta.textContent = `${Number(job.messageCount || 0)} messages · Print / Save as PDF`;
        printButton.disabled = false;
        setStatus("ready", "Choose “Save as PDF” as the destination in the print dialog.");

        const params = new URLSearchParams(location.search);
        if (params.get("auto") === "0") return;

        // Give the browser one paint to lay out the document before opening
        // the print dialog. This also lets the bundled icon finish decoding.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setTimeout(doPrint, 450);
            });
        });
    }

    init();
})();
