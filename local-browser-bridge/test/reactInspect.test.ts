import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function inspect(fiber: object) {
  const source = await readFile("extension/reactInspect.js", "utf8");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  return vm.runInNewContext(module.reactInspectExpression(".model"), {
    document: { title: "Test", querySelector: () => ({ __reactFiber$test: fiber }) },
    location: { href: "http://localhost:5173/" }, URL,
  });
}
const stack = (...frames: string[]) => ({ stack: "Error\n" + frames.map(frame => "    at " + frame).join("\n") });

test("keeps selected DOM source and distinguishes identically named owners without module guessing", async () => {
  const outer = { type: function App() {}, tag: 0, _debugStack: stack("http://localhost:5173/src/main.tsx:9:2"), return: null };
  const alternate = {};
  const inner = { alternate, type: function App() {}, tag: 0, _debugOwner: outer, _debugStack: stack("App (http://localhost:5173/src/App.tsx:30:4)"), return: outer };
  const element = { type: "span", tag: 5, _debugOwner: alternate, return: inner, _debugStack: stack(
    "exports.jsx (http://localhost:5173/node_modules/runtime.js:1:2)",
    "http://localhost:5173/src/ThreadexShell.tsx?t=123:1452:31",
    "ThreadexShell (http://localhost:5173/src/ThreadexShell.tsx?t=123:1400:4)",
    "App (http://localhost:5173/src/ThreadexApp.tsx?t=123:58:10)",
  ) };
  const result = await inspect(element);
  assert.equal(result.elementSource.fileName, "/src/ThreadexShell.tsx");
  assert.equal(result.elementSource.lineNumber, 1452);
  assert.equal(result.elementSource.columnNumber, 31);
  assert.equal(result.elementSource.coordinates, "runtime");
  assert.equal(result.elementSourceStack.length, 3);
  assert.equal(result.components[0].source.fileName, "/src/ThreadexApp.tsx");
  assert.equal(result.components[0].creationSource.fileName, "/src/App.tsx");
  assert.equal(result.components[0].sourceRole, "render-callsite");
  assert.equal(result.components[1].source.fileName, "/src/App.tsx");
  assert.equal(result.truncated, false);
});

test("supports legacy source metadata and unavailable production metadata", async () => {
  const result = await inspect({ type: "span", _debugSource: { fileName: "/src/Label.tsx", lineNumber: 12, columnNumber: 3 } });
  assert.equal(result.elementSource.method, "debug-source");
  assert.equal(result.elementSource.lineNumber, 12);
  const production = await inspect({ type: function App() {}, tag: 0 });
  assert.equal(production.components[0].source, null);
  assert.equal(production.sourceLocationAvailable, false);
});

test("handles Firefox stack frames and bounds malformed fiber cycles", async () => {
  const fiber: Record<string, unknown> = { type: "span", _debugStack: { stack: "Label@http://localhost:5173/src/Label.tsx:2:3" } };
  fiber.return = fiber;
  const result = await inspect(fiber);
  assert.equal(result.elementSource.name, "Label");
  assert.equal(result.elementSource.lineNumber, 2);
  assert.equal(result.truncated, true);
});

test("recovers missing element stacks from alternate fibers with provenance", async () => {
  const result = await inspect({ type: "span", alternate: { _debugStack: stack("Shell (http://localhost/src/Shell.tsx:8:2)") } });
  assert.equal(result.elementSource.fileName, "/src/Shell.tsx");
  assert.equal(result.elementSource.fiberVersion, "alternate");
  assert.equal(result.elementSourceStatus, "available");
});

test("keeps missing element metadata distinct from nearest ancestor evidence", async () => {
  const result = await inspect({ type: "span", return: { type: "div", _debugStack: stack("Shell (http://localhost/src/Shell.tsx:7:1)") } });
  assert.equal(result.elementSource, null);
  assert.equal(result.elementSourceStatus, "debug-metadata-unavailable");
  assert.equal(result.ancestorSource.distance, 1);
  assert.equal(result.ancestorSource.source.fileName, "/src/Shell.tsx");
});

test("attachment positions are stored once and shared across component roles", async () => {
  const source = await readFile("extension/reactContext.js", "utf8");
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const shell = { fileName: "/src/Shell.tsx", lineNumber: 8, columnNumber: 2 };
  const app = { fileName: "/src/App.tsx", lineNumber: 30, columnNumber: 4 };
  const main = { fileName: "/src/main.tsx", lineNumber: 9, columnNumber: 2 };
  const result = module.reactContextMetadata({
    elementSource: shell, elementSourceStack: [shell, app], elementSourceStatus: "available",
    components: [
      { name: "App", source: shell, creationSource: app, sourceStack: [app] },
      { name: "App", source: app, creationSource: main, sourceStack: [main] },
    ],
  });
  assert.equal(result["react-source-locations"].length, 3);
  assert.equal(result["react-components"][0].creationSourceRef, result["react-components"][1].sourceRef);
  assert.deepEqual(result["react-element"].stackRefs, [0, 1]);
  assert.equal(result["react-components"][1].creationSourceRef, 2);
  assert.equal(result["react-trace-version"], 2);
});
