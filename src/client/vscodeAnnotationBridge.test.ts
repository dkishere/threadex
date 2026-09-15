import assert from "node:assert/strict";
import test from "node:test";
import { consumeVsCodeAnnotation } from "./vscodeAnnotationBridge";

test("consumes a VS Code file annotation and clears the URL fragment", () => {
  const payload = {
    version: 1,
    sessionId: "session-1",
    annotation: {
      text: "const answer = 42;",
      annotation: "Please rename this.",
      source: {
        type: "file",
        path: "src/example.ts",
        selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 19 },
        side: "modified"
      }
    }
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  let replaced = "";
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "http://threadex.test/?sessionId=session-1", origin: "http://threadex.test" },
      history: { state: null, replaceState: (_state: unknown, _title: string, href: string) => { replaced = href; } }
    }
  });
  try {
    const result = consumeVsCodeAnnotation(`http://threadex.test/?sessionId=session-1#threadex-annotation=${encoded}`);
    assert.equal(result?.sessionId, "session-1");
    assert.equal(result?.annotation.source?.type, "file");
    assert.equal(result?.annotation.annotation, "Please rename this.");
    assert.equal(replaced, "http://threadex.test/?sessionId=session-1");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
