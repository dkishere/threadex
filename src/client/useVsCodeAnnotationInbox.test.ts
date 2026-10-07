import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

test("frontend retries acknowledgements without duplicating comments and stops on session change", async () => {
  let effect: (() => (() => void) | undefined) | undefined;
  let poll: (() => Promise<void>) | undefined;
  let failAck = true;
  const received: unknown[] = [];
  const requests: string[] = [];
  const receipts = new Map();
  const item = { id: "one", annotation: { text: "code", annotation: "comment" } };
  const module = { exports: {} as { useVsCodeAnnotationInbox: Function } };
  const code = ts.transpileModule(readFileSync(new URL("./useVsCodeAnnotationInbox.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sandbox = {
    module, exports: module.exports,
    require: () => ({ useEffect: (fn: typeof effect) => { effect = fn; }, useRef: (current: unknown) => ({ current }) }),
    document: { visibilityState: "visible" },
    navigator: { locks: { request: async (_: string, callback: Function) => callback() } },
    localStorage: { getItem: (key: string) => receipts.get(key), setItem: (key: string, value: string) => receipts.set(key, value) },
    window: { setInterval: () => 1, addEventListener: (_: string, fn: typeof poll) => { poll = fn; }, removeEventListener() {} },
    clearInterval() {},
    fetch: async (url: string, options?: { method: string }) => {
      requests.push(url);
      if (options?.method === "DELETE") return { ok: !failAck };
      return { ok: true, json: async () => ({ annotations: [item] }) };
    }
  };
  vm.runInNewContext(code, sandbox);
  module.exports.useVsCodeAnnotationInbox("source", true, (annotation: unknown) => received.push(annotation));
  const cleanup = effect!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  failAck = false;
  await poll!();
  assert.equal(received.length, 1);
  assert.ok(requests.every(url => url.startsWith("/api/sessions/source/vscode-annotations")));
  cleanup!();
  const count = requests.length;
  await poll!();
  assert.equal(requests.length, count);
});
