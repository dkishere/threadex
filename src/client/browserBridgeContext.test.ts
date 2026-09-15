import assert from "node:assert/strict";
import test from "node:test";
import { browserBridgeContextAttachmentName, browserBridgeContextDetail, browserBridgeContextTitle, parseBrowserBridgeContext } from "./browserBridgeContext";

const context = {
  kind: "browser-bridge-context",
  capturedAt: "2026-08-25T17:09:28.756Z",
  tabId: 609625556,
  url: "http://localhost:8082/session-conversation/example",
  title: "FairShot Hub",
  selector: "main > p",
  element: { tagName: "p", className: "muted" },
  "page-values": { workspace: "fairshot", environment: "local" },
  "match-by-url": ["http://localhost:8082/"],
  "react-components": [{ name: "App", source: "/src/client/App.tsx" }],
  "extension-context-key": "codex-browser-bridge:context:609625556:test"
};

test("parses an exact browser bridge context clipboard payload", () => {
  const parsed = parseBrowserBridgeContext(JSON.stringify(context));
  assert.deepEqual(parsed, context);
  assert.equal(browserBridgeContextAttachmentName(parsed!), "browser-bridge-context-609625556.json");
  assert.equal(browserBridgeContextTitle(parsed!), "FairShot Hub");
  assert.equal(browserBridgeContextDetail(parsed!), "Tab 609625556 · main > p");
  assert.equal(parsed!["react-components"]?.[0]?.source, "/src/client/App.tsx");
  assert.equal(parsed!["extension-context-key"], "codex-browser-bridge:context:609625556:test");
});

test("parses earlier split extension snapshot and screenshot keys", () => {
  const { "extension-context-key": _currentKey, ...baseContext } = context;
  const legacyContext = {
    ...baseContext,
    "extension-page-snapshot-key": "codex-browser-bridge:page-snapshot:609626102:test",
    "extension-webp-screenshot-key": "codex-browser-bridge:context-screenshot:609626102:test"
  };

  assert.deepEqual(parseBrowserBridgeContext(JSON.stringify(legacyContext)), legacyContext);
});

test("parses the original localStorage snapshot key", () => {
  const { "extension-context-key": _currentKey, ...baseContext } = context;
  const localStorageContext = {
    ...baseContext,
    "localstorage-page-snapshot-key": "codex-browser-bridge:page-snapshot:609626102:test"
  };

  assert.deepEqual(parseBrowserBridgeContext(JSON.stringify(localStorageContext)), localStorageContext);
});

test("does not treat unrelated or incomplete JSON as browser context", () => {
  assert.equal(parseBrowserBridgeContext('{"kind":"browser-page-context"}'), null);
  assert.equal(parseBrowserBridgeContext(JSON.stringify({ ...context, url: "file:///tmp/page" })), null);
  assert.equal(parseBrowserBridgeContext(JSON.stringify({ ...context, "extension-context-key": "" })), null);
});

test("preserves version 2 React source references in context attachments", () => {
  const payload = {
    ...context,
    "react-trace-version": 2,
    "react-source-locations": [{ fileName: "/src/Shell.tsx", lineNumber: 8, columnNumber: 2 }],
    "react-components": [{ name: "App", sourceRef: 0, creationSourceRef: null, stackRefs: [] }],
    "react-element": { sourceRef: 0, stackRefs: [0], sourceStatus: "available", nearestAncestor: null },
  };
  assert.deepEqual(parseBrowserBridgeContext(JSON.stringify(payload)), payload);
});
