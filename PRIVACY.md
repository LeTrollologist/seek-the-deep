# Privacy

Seek the Deep is local-first.

- It does **not** collect analytics, telemetry, identifiers, or usage data.
- It does **not** send conversation content, tokens, or filenames to the developer or to any third party.
- The only network request is to `https://chat.deepseek.com`, using the session token already present in the DeepSeek tab, to download the current conversation from DeepSeek's own web API.
- Export rendering happens entirely in your browser.
- Preferences are stored in `chrome.storage.sync`, which may be synchronized by your browser if you have browser sync enabled.
- Recent export timestamps are stored in `chrome.storage.local` only to enforce the export rate limit. They contain no conversation content.
- The current printable document is stored temporarily in `chrome.storage.local` so it can be opened in the print tab. It is replaced on the next PDF export.
- No remote code is loaded. All scripts and styles ship inside the extension package.

If you do not want the extension to use DeepSeek's web API, remove it or review the source before loading it. The page-text fallback exists so exports can still work when the API is unavailable.
