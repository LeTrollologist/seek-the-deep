const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const DS = require("../shared.js");

function apiFixture() {
    return {
        code: 0,
        data: {
            biz_code: 0,
            biz_data: {
                chat_session: {
                    id: "chat-123",
                    title: "API design <draft>",
                    model_type: "deepseek-reasoner",
                    current_message_id: 4,
                    inserted_at: 1760000000,
                    updated_at: 1760000500,
                },
                chat_messages: [
                    {
                        message_id: 1,
                        parent_id: null,
                        role: "USER",
                        inserted_at: 1760000000,
                        fragments: [{ type: "REQUEST", content: "How should I design the API?" }],
                    },
                    {
                        message_id: 2,
                        parent_id: 1,
                        role: "ASSISTANT",
                        model: "deepseek-reasoner",
                        inserted_at: 1760000010,
                        fragments: [
                            { type: "THINK", content: "Consider pagination and errors." },
                            {
                                type: "RESPONSE",
                                content: "## Plan\n\nUse **cursor pagination**.\n\n```json\n{\"ok\": true}\n```",
                            },
                            {
                                type: "SEARCH",
                                results: [
                                    { title: "RFC 9457", url: "https://www.rfc-editor.org/rfc/rfc9457" },
                                ],
                            },
                            {
                                type: "FILE",
                                files: [{ file_name: "schema.json", signed_path: "/file?f=1" }],
                            },
                        ],
                    },
                    {
                        message_id: 3,
                        parent_id: 1,
                        role: "ASSISTANT",
                        inserted_at: 1760000020,
                        fragments: [{ type: "RESPONSE", content: "This branch should not be exported." }],
                    },
                    {
                        message_id: 4,
                        parent_id: 2,
                        role: "USER",
                        inserted_at: 1760000500,
                        fragments: [{ type: "REQUEST", content: "Thanks. What about errors?" }],
                    },
                    {
                        message_id: 5,
                        parent_id: 3,
                        role: "USER",
                        inserted_at: 1760000600,
                        fragments: [{ type: "REQUEST", content: "Other branch follow-up." }],
                    },
                ],
            },
        },
    };
}

test("normalizes the active API branch, reasoning, sources, and files", () => {
    const conversation = DS.normalizeApiConversation(apiFixture(), { chatId: "chat-123" });
    assert.equal(conversation.title, "API design <draft>");
    assert.equal(conversation.model, "deepseek-reasoner");
    assert.equal(conversation.messages.length, 3);
    assert.deepEqual(conversation.messages.map((message) => message.role), ["user", "assistant", "user"]);
    assert.match(conversation.messages[1].text, /cursor pagination/);
    assert.match(conversation.messages[1].reasoning, /pagination/);
    assert.equal(conversation.messages[1].attachments[0].name, "schema.json");
    assert.match(conversation.messages[1].attachments[0].url, /^https:\/\/files\.deepseeksvc\.com\/api\/file/);
    assert.equal(conversation.messages[1].sources[0].title, "RFC 9457");
    assert.equal(conversation.messages[2].createdAt, 1760000500);
});

test("exports Markdown with metadata, reasoning, and no abandoned branch", () => {
    const conversation = DS.normalizeApiConversation(apiFixture(), { chatId: "chat-123" });
    const markdown = DS.buildMarkdown(conversation, { includeReasoning: true, includeTimestamps: true });
    assert.match(markdown, /^# API design <draft>/);
    assert.match(markdown, /> Source: https:\/\/chat\.deepseek\.com\/a\/chat\/s\/chat-123/);
    assert.match(markdown, /<summary>Reasoning<\/summary>/);
    assert.match(markdown, /cursor pagination/);
    assert.match(markdown, /schema\.json/);
    assert.match(markdown, /RFC 9457/);
    assert.doesNotMatch(markdown, /abandoned branch|Other branch/);
});

test("plain-text export is readable and includes timestamps when requested", () => {
    const conversation = DS.normalizeApiConversation(apiFixture(), { chatId: "chat-123" });
    const text = DS.buildText(conversation, { includeReasoning: false, includeTimestamps: true });
    assert.match(text, /API DESIGN <DRAFT>/);
    assert.match(text, /YOU/);
    assert.match(text, /DEEPSEEK/);
    assert.doesNotMatch(text, /Consider pagination/);
});

test("JSON export is valid and preserves message structure", () => {
    const conversation = DS.normalizeApiConversation(apiFixture(), { chatId: "chat-123" });
    const parsed = JSON.parse(DS.buildJson(conversation));
    assert.equal(parsed.format, "deepseek-chat-export");
    assert.equal(parsed.conversation.id, "chat-123");
    assert.equal(parsed.conversation.messages.length, 3);
    assert.equal(parsed.conversation.messages[1].role, "assistant");
    assert.match(parsed.conversation.messages[1].reasoning, /pagination/);
});

test("HTML export escapes raw HTML and strips dangerous links", () => {
    const conversation = DS.normalizeApiConversation(apiFixture(), { chatId: "chat-123" });
    conversation.messages[1].text += "\n\n<script>window.pwned = true</script>\n\n[click](javascript:alert(1))";
    const html = DS.buildHtmlDocument(conversation, { includeReasoning: true });
    assert.doesNotMatch(html, /<script>window\.pwned/);
    assert.match(html, /&lt;script&gt;window\.pwned/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.match(html, /<a href="https:\/\/www\.rfc-editor\.org/);
});

test("Markdown renderer handles common chat formatting", () => {
    const html = DS.renderMarkdown([
        "# Heading",
        "",
        "A **bold** and *italic* sentence with `inline()` code and ~~old~~ text.",
        "",
        "> quoted **text**",
        "",
        "1. first",
        "2. second",
        "",
        "| Name | Value |",
        "| --- | ---: |",
        "| a | 1 |",
        "",
        "```js",
        "const x = `<tag>`;",
        "```",
        "",
        "[safe](https://example.com?a=1&b=2)",
    ].join("\n"));
    assert.match(html, /<h1>Heading<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>inline\(\)<\/code>/);
    assert.match(html, /<del>old<\/del>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<table>/);
    assert.match(html, /<span class="code-lang">js<\/span>/);
    assert.match(html, /&lt;tag&gt;/);
    assert.match(html, /href="https:\/\/example\.com\?a=1&amp;b=2"/);
});

test("page-text normalization deduplicates adjacent repeats and infers a title", () => {
    const conversation = DS.normalizePageConversation([
        { role: "user", text: "Hello there" },
        { role: "user", text: "Hello there" },
        { role: "assistant", text: "Hi! How can I help?" },
    ], { url: "https://chat.deepseek.com/a/chat/s/abc" });
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.title, "Hello there");
    assert.equal(conversation.source, "page");
});

test("filenames are safe and deterministic for a given date", () => {
    const name = DS.makeBaseFilename({ title: 'A/B: "test"?' }, 1760000000);
    assert.equal(name, "A-B-test - 2025-10-09");
    assert.doesNotMatch(name, /[<>:"/\\|?*]/);
    assert.match(DS.makeFilename({ title: "Chat" }, "md"), /\.md$/);
});

test("manifest references local files that exist", () => {
    const root = path.resolve(__dirname, "..");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    const files = [
        manifest.background.service_worker,
        manifest.action.default_popup,
        ...Object.values(manifest.icons),
        ...Object.values(manifest.action.default_icon),
    ];
    for (const file of files) {
        assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
    }
});
