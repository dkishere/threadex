# Local Browser Bridge

Control your existing Chrome profile from local coding agents, while keeping the browser extension as the user-facing security boundary. This project is intentionally independent of any chat UI: Codex, Claude Code, shell scripts, and other local agents all call the same CLI.

> This is an alpha release. Do not expose the local daemon beyond loopback, and review the extension permissions before installing it.

## Architecture

```text
Local agents ── browser-bridge CLI ──► local daemon ◄── WebSocket ── Chrome extension
Website ────── origin-gated HTTP ────► local daemon ──► extension approval window
```

The daemon is a transport detail: agents only need the `browser-bridge` command. It owns the persistent extension connection, serializes request/response IDs, and never listens outside `127.0.0.1`. A tab's DevTools debugger attachment is released automatically after five seconds without another debugger command; the next command attaches again as needed.

## Install and pair

```bash
npm install
npm run build
npm link
```

Load `extension/` from `chrome://extensions` with Developer mode enabled, then run:

```bash
browser-bridge start
```

That is the whole first-run pairing flow. The extension creates its own credential and claims an unpaired loopback daemon automatically; there is no token to copy. If the daemon was previously paired with another extension install, `browser-bridge pair` opens an authenticated 60-second re-pairing window and waits for the enabled extension to reconnect.

Verify the connection:

```bash
browser-bridge status
browser-bridge tabs
```

## Agent use

```bash
browser-bridge tabs
browser-bridge windows
browser-bridge targets
browser-bridge snapshot 123
browser-bridge react-inspect 123 '.workspace-tab'
browser-bridge click 123 '#save'
browser-bridge type 123 '#search' 'release checklist'
browser-bridge screenshot 123 /tmp/browser.png
browser-bridge context-screenshot 'codex-browser-bridge:context:123:key' /tmp/context.webp
browser-bridge context-snapshot 'codex-browser-bridge:context:123:key' /tmp/context.json
browser-bridge cdp 123 Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
browser-bridge api cookies getAll '[{}]'
```

Every command writes JSON to stdout. `cdp` sends a raw DevTools Protocol command
to a tab, while `api` exposes an allowlist of extension namespaces to the
authenticated CLI only. Agents should inspect `browser-bridge tabs` first and
treat actions that send, buy, delete, or publish as user-confirmation points.

`react-inspect` is read-only and provides a best-effort DOM-to-React mapping for
the element selected by a CSS selector. It returns the React component hierarchy
and, when a development build preserves it, each component's source filename,
line, and column. It never returns props or hook state. Source locations are not
expected in production builds.

## Page injection

The extension installs its own content script on normal HTTP(S) pages. Hold Shift while right-clicking an element to highlight it and open an extension-owned context card. You can add an optional comment, which is embedded as the `user-comment` field in the resulting JSON:

- **Copy** copies a compact `browser-bridge-context` JSON object.
- An open app registers its app name and context callback directly with the extension. While a receiver exists, the menu also shows **Add to _app name_** and injects the compact context into that app without a server relay or polling. The app callback decides which active thread or composer receives it.

For a React page, context trace version 2 stores each source position once in
`react-source-locations`. All `sourceRef`, `creationSourceRef`, and `stackRefs`
values are zero-based indexes into that array. `react-components` preserves
component identity and render/creation call-site roles; `react-element` links
the selected DOM element's source and stack (including plain render helpers).
Follow the element stack and then component creation references outward to the
app entry point. These are call sites, not component definition locations.

Missing selected-element metadata is explicitly reported by `sourceStatus`.
Alternate-fiber fallback is marked `fiberVersion: "alternate"`; if neither fiber
has metadata, `nearestAncestor` provides separate evidence with its distance,
without presenting it as the selected element's exact source. Debug-stack
coordinates are marked `runtime`, not source-map-resolved original TSX positions.
Name-only module guessing is not used. Component traversal is capped at 40
entries/200 fibers (`react-trace-truncated`); stacks retain at most 12
non-dependency frames. Props and hook state are never captured.
Reload the unpacked extension after rebuilding to update menu captures.

The selected text and larger element snapshot stay in extension-owned IndexedDB
for up to seven days. The compact JSON contains one shared
`extension-context-key` for both the snapshot and WebP capture. Retrieve the
snapshot with
`browser-bridge context-snapshot <key> <output.json>`. The content script does
not read or write the host page's local storage. Receiver registration is
limited to loopback HTTP(S) tabs and is removed when the Agent tab closes or
unregisters.

The Shift+right-click gesture also captures the visible viewport before the
extension card and highlight are painted. Chrome converts the capture to WebP
and keeps it in extension-owned IndexedDB for up to seven days. An authenticated
local agent can retrieve it using the same `extension-context-key` with
`browser-bridge context-screenshot <key> <output.webp>`.
Cleanup runs hourly. WebP captures are limited to 50 items and 100 MiB; page
snapshots are limited to 500 items and 25 MiB.

## Page values and URL matching

Agents can attach stable, user-configured JSON context to a captured page URL. Mappings are applied from broadest to most-specific prefix, so the latter overrides duplicate keys while preserving the other values.

```bash
browser-bridge set-page-values '[
  {"urlPrefix":"https://example.test/","values":{"project":"shared","environment":"test"}},
  {"urlPrefix":"https://example.test/projects/alpha/","values":{"project":"alpha","region":"eu"}}
]'
browser-bridge page-context 123
```

The latter returns a `browser-bridge-context` JSON object with `page-values` and `match-by-url`. You can edit the same mappings in the extension popup. The popup talks only to the paired daemon over its authenticated WebSocket; the mappings remain in the daemon's mode-`0600` config file.

Any local agent that can run JavaScript can use the authenticated local API directly. Read the token from its local config rather than hard-coding or sharing it:

```js
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const config = JSON.parse(await readFile(join(homedir(), ".local-browser-bridge/config.json"), "utf8"));
const response = await fetch(`http://127.0.0.1:${config.port}/v1/command`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${config.cliToken}` },
  body: JSON.stringify({
    type: "setPageValueMappings",
    mappings: [{ urlPrefix: "https://example.test/", values: { project: "shared" } }]
  })
});
if (!response.ok) throw new Error(await response.text());
```

## Website access

Browser pages do not receive implicit access. A site first calls `POST /v1/web/pair` with an `Origin` header and requested scopes. The extension opens an extension-owned approval window. Time-limited and persistent grants are stored in the extension, displayed in its popup, and can be revoked there. After approval, the daemon gives the site an in-memory, origin-bound session token.

```js
const paired = await fetch("http://127.0.0.1:9327/v1/web/pair", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ scopes: ["tabs.read"] })
}).then((response) => response.json());

const tabs = await fetch("http://127.0.0.1:9327/v1/web/command", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}` },
  body: JSON.stringify({ type: "listTabs" })
}).then((response) => response.json());
```

Website grants are deliberately limited to `tabs.read`, `page.read`, and `page.interact`; they can only operate tabs whose origin exactly matches the approved website. Raw CDP, arbitrary JavaScript evaluation, cookies, history, downloads, and cross-origin tab access are CLI-only capabilities.

Run `npm run example:website`, open `http://127.0.0.1:9410/`, and choose **Request website access** for a minimal end-to-end example.

## Security model

- The daemon binds only to loopback and every CLI request needs a random token in a mode-`0600` local config file.
- The extension creates its own connection credential. A daemon with no extension identity accepts the first exact `chrome-extension://<id>` claimant; replacing that identity requires a short-lived pairing window opened through the CLI-authenticated API.
- The extension, not the website, shows the authorization UI. The approval screen displays exact scheme, host, port, requested scopes, and a limited duration.
- CORS is scoped to the calling origin, never `*`.
- A website cannot use a grant to control a different origin.
- Page injection is an extension content script activated by a Shift+right-click user gesture; it does not grant the host page access to the bridge.

See [docs/release-checklist.md](docs/release-checklist.md) before publishing.
