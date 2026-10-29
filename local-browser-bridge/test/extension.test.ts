import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("selected element innerText survives compact context serialization with a 128 character limit", async () => {
  const content = await readFile("extension/content.js", "utf8");
  const captureSource = content.slice(content.indexOf("    function summarizeElementInnerText("), content.indexOf("    function pageValuesForUrl("));
  const stored: unknown[] = [];
  const capture = runInNewContext(`${captureSource}\ncaptureContext`, {
    Intl,
    location: { href: "https://example.com/" },
    document: { title: "Selected element test" },
    getSelection: () => null,
    cssPath: () => "main > p",
    pageValuesForUrl: () => null,
    send: async (message: unknown) => { stored.push(message); return {}; },
  });
  const cases = [
    { input: "", expected: "" },
    { input: " \n\t ", expected: "" },
    { input: " Hello\n\t world\u00a0! ", expected: "Hello world !" },
    { input: "a".repeat(128), expected: "a".repeat(128) },
    { input: "a".repeat(129), expected: "a".repeat(128) },
    { input: "中".repeat(129), expected: "中".repeat(128) },
    { input: "😀".repeat(129), expected: "😀".repeat(128) },
    { input: "a".repeat(127) + "👩🏽‍💻", expected: "a".repeat(127) },
    { input: "a".repeat(124) + "👩🏽‍💻!", expected: "a".repeat(124) + "👩🏽‍💻" },
    { input: "a".repeat(127) + "e\u0301", expected: "a".repeat(127) },
    { input: undefined, expected: "" },
  ];
  for (const { input, expected } of cases) {
    const context = await capture({ tabId: 42, mappings: [] }, {
      tagName: "P", id: "", className: "example", getAttribute: () => null,
      innerText: input, textContent: "Hidden text must not leak into the summary", outerHTML: "<p>example</p>",
    }, { key: "context-key" });
    // Copy and Add to Threadex share this captured context; both serialize it as JSON.
    const serialized = JSON.parse(JSON.stringify(context));
    assert.equal(serialized.element.innerText, expected);
    assert.ok(Array.from(serialized.element.innerText).length <= 128);
    assert.equal(serialized.selector, "main > p");
    assert.equal(serialized["extension-context-key"], "context-key");
    assert.equal(serialized.element.className, "example");
    const snapshot = (stored.at(-1) as { snapshot: { element: { innerText: string } } }).snapshot;
    assert.equal(snapshot.element.innerText, expected);
  }
});

test("manifest installs the automatic HTTP(S) page context content script", async () => {
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8")) as { permissions?: string[]; content_scripts?: Array<{ matches?: string[]; js?: string[] }> };
  assert.ok(manifest.permissions?.includes("scripting"));
  assert.ok(manifest.permissions?.includes("cookies"));
  assert.ok(manifest.permissions?.includes("downloads"));
  assert.deepEqual(manifest.content_scripts, [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"], run_at: "document_idle" }]);
  const content = await readFile("extension/content.js", "utf8");
  assert.match(content, /pageInjectionConfig/);
  assert.match(content, /browserContextReceiver/);
  assert.match(content, /injectBrowserContext/);
  assert.match(content, /data-local-browser-bridge-context-receiver/);
  assert.match(content, /Add to/);
  assert.match(content, /extension-context-key/);
  assert.doesNotMatch(content, /localStorage\./);
  assert.doesNotMatch(content, /extension-(?:page-snapshot|webp-screenshot)-key/);
  assert.match(content, /captureContextScreenshot/);
  assert.match(content, /function onPointerDown/);
  assert.match(content, /try\s*\{\s*contentGlobal\.__localBrowserBridgeContent\?\.dispose\(\);\s*\}\s*catch/);
  assert.match(content, /function dispose\(\)/);
  assert.match(content, /chrome\.runtime\.onMessage\.removeListener\(onExtensionMessage\)/);
  assert.match(content, /event\.shiftKey && event\.button === 2/);
  assert.match(content, /target\.right \+ gap/);
  assert.match(content, /function interceptMenuEvent/);
  assert.match(content, /Comment \(optional\)/);
  assert.match(content, /"user-comment": value/);
  assert.match(content, /createButton\("Copy"/);
  assert.doesNotMatch(content, /Copy to chat/);
  assert.match(content, /JSON\.stringify\(contextWithComment\(\)\)/);
  assert.doesNotMatch(content, /JSON\.stringify\(contextWithComment\(\), null, 2\)/);
  assert.match(content, /function showElementHighlight/);
  assert.match(content, /localBrowserBridgeHighlight/);
  assert.match(content, /host\.addEventListener\(eventName, interceptMenuEvent\)/);
  assert.match(content, /event\.stopImmediatePropagation\(\)/);
  assert.match(content, /\(\(\) => \{/);
  assert.doesNotMatch(content, /^export\s/m);
  const background = await readFile("extension/background.js", "utf8");
  assert.match(background, /listWindows/);
  assert.match(background, /listTargets/);
  assert.match(background, /chromeApi/);
  assert.match(background, /case "reactInspect"/);
  assert.match(background, /reactInspectExpression/);
  assert.match(background, /withReactComponents/);
  assert.match(background, /reactContextMetadata/);
  assert.match(background, /enrichPageContext/);
  assert.match(background, /chrome\.tabs\.captureVisibleTab/);
  assert.match(background, /contextScreenshotRetentionMs = 7 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(background, /convertToBlob\(\{ type: "image\/webp"/);
  assert.match(background, /getContextScreenshot/);
  assert.match(background, /storePageSnapshot/);
  assert.match(background, /getPageSnapshot/);
  assert.match(background, /pageSnapshotRetentionMs = 7 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(background, /chrome\.alarms\.create\(contextStorageCleanupAlarm/);
  assert.match(background, /indexedDB\.open\(contextStorageDatabaseName/);
  assert.match(background, /case "cdp"/);
  assert.match(background, /debuggerIdleTimeoutMs = 5_000/);
  assert.match(background, /chrome\.debugger\.detach/);
  assert.match(background, /scheduleDebuggerDetach\(tabId\)/);
  assert.match(background, /chrome\.debugger\.onDetach/);
  assert.match(background, /receiver: currentTabReceiver \?\? await findInjectionReceiver\(tabId\)/);
  assert.doesNotMatch(background, /enabled: false, tabId: tabId, mappings: \[\], receiver: null/);
  assert.doesNotMatch(background, /contextApiUrl/);
});

test("React inspection only reports component and source metadata", async () => {
  const source = await readFile("extension-src/reactInspect.ts", "utf8");
  assert.match(source, /__reactFiber\$/);
  assert.match(source, /_debugSource/);
  assert.match(source, /_debugStack/);
  assert.match(source, /elementSourceStack/);
  assert.match(source, /creationSource/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.match(source, /sourceLocationAvailable/);
  assert.doesNotMatch(source, /memoizedProps/);
  assert.doesNotMatch(source, /memoizedState/);
});
