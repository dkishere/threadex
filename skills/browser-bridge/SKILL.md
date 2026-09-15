---
name: browser-bridge
description: Control the trusted local Chrome browser through the authenticated Local Browser Bridge daemon without MCP. Use when a task needs real Chrome tabs, windows, DOM inspection, JavaScript evaluation, clicks, typing, screenshots, CDP, cookies, downloads, or browser debugging.
---

# Browser Bridge

Use the Local Browser Bridge CLI to control the user's trusted Chrome profile.
The CLI calls the standalone authenticated daemon and
the installed **Local Browser Bridge** extension; it does not use Session
Manager's retired relay, launch Playwright, or open a second browser profile.

The CLI is installed on `PATH` as:

```text
browser-bridge
```

Run `browser-bridge help` when the exact operation is unclear. Prefer these compact
commands:

```bash
browser-bridge start
browser-bridge status
browser-bridge pair
browser-bridge tabs
browser-bridge windows
browser-bridge targets
browser-bridge new-tab http://localhost:5173
browser-bridge navigate <tabId> http://localhost:5173
browser-bridge evaluate <tabId> '({ title: document.title, text: document.body.innerText })'
browser-bridge click <tabId> 'button[type="submit"]'
browser-bridge type <tabId> '#search' 'query text'
browser-bridge screenshot <tabId> /private/tmp/browser.png
browser-bridge context-screenshot <key> /private/tmp/browser-context.webp
browser-bridge context-snapshot <key> /private/tmp/browser-context.json
browser-bridge cdp <tabId> Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
browser-bridge api cookies getAll '[{}]'
browser-bridge page-context <tabId> [css-selector]
browser-bridge page-values
browser-bridge set-page-values '[{"urlPrefix":"https://example.com/","values":{"project":"demo"}}]'
```

Treat command output as JSON. Use `tabs` first when the tab id is unknown. Use
`evaluate` for read-only inspection, and use `screenshot` when visual state
matters. Keep screenshots under `/private/tmp` or the workspace and report the
path.

Codex runners must request this exact CLI command with
`sandbox_permissions: "require_escalated"`. Its fixed `browser-bridge` prefix is
pre-approved so only this purpose-built CLI bypasses the network sandbox; do
not enable general sandbox network access.

The CLI starts its loopback daemon automatically. If it says the extension is
not connected, ask the user to enable/reload **Local Browser Bridge** from
`local-browser-bridge/extension` in `chrome://extensions`; use `pair` only when
replacing a previously paired extension install. Do not silently switch to
Playwright because that would use a different browser profile.

The extension installs its Shift+right-click menu into normal HTTP(S) pages.
**Add to chat** sends a compact `browser-bridge-context` JSON attachment to
Threadex. **Copy** copies the same JSON. Larger page snapshots remain in the
extension's temporary IndexedDB storage for seven days. The compact payload
contains one `extension-context-key` shared by the HTML snapshot and WebP
capture. Retrieve the snapshot
with `browser-bridge context-snapshot <key> /private/tmp/browser-context.json`.
The content script does not use the source page's local storage.
The gesture also captures the visible viewport before the extension menu is
painted. Retrieve that temporary image with the same key using
`browser-bridge context-screenshot <key> /private/tmp/browser-context.webp`.
The extension retains these WebP captures for no more than seven days and cleans
them periodically, so retrieve the image before doing lengthy follow-up work.

## Browser context attachments

When a prompt provides a JSON object whose `kind` is
`browser-bridge-context`, treat it as direct context for the page the user is
referring to. It may arrive as an attachment, injected text, or another
structured context block; do not depend on its filename. The object supplies
the tab ID and URL, and may include a captured selector, element metadata,
component/source metadata, page-values, a `user-comment`, and an
`extension-context-key` shared by its stored HTML snapshot and WebP capture.
Retrieve the keyed JSON snapshot when selected text or the larger element HTML
is needed. When current visual appearance matters, retrieve the keyed screenshot
before falling back to a new live capture. If this context already identifies the likely component, source location,
element ID, selector, or other precise code-search term, search the scoped code
first. Do not load or inspect the browser tab merely as a required preliminary
step. Inspect the live tab with `page-context`, a read-only `evaluate`, or a
screenshot only when the task depends on current runtime state or appearance,
or when the JSON and focused code lookup leave the target ambiguous. When live
inspection is needed, use the attachment's tab ID directly rather than
rediscovering it with `tabs`.

Use the observed selector, accessible label, text, or class to make any source
lookup precise. If a `page-values` mapping contains a project or source-root
hint, scope the lookup there. A narrow source search can still be needed to
map rendered DOM back to its component, but avoid broad terms such as
`score|selected` across an unrelated workspace when the attachment already
identifies the live control.

Use `page-values` and `set-page-values` to manage URL-prefix mappings in the
daemon. Matching values appear as `page-values`; broad prefixes are merged
first, and more-specific prefixes override duplicate keys. For a local app,
values such as `project`, `projectRoot`, and `sourceRoot` can give an attached
context the source-location hint needed for a focused edit.

The bridge is local and trusted, but CLI commands can access the user's real
Chrome profile. Avoid exposing cookies or page secrets in output. Confirm before
irreversible actions such as purchases, deleting data, sending messages, or
closing many tabs.
