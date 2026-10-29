import assert from "node:assert/strict";
import test from "node:test";
import { attachmentFilesFromPaste } from "./composerPaste";

function data(text: string, files: File[] = []) {
  return { files, items: [], getData: (type: string) => (type === "text/plain" ? text : "") } as unknown as DataTransfer;
}

test("pasted Browser Bridge context becomes a JSON attachment", async () => {
  const context = { kind: "browser-bridge-context", tabId: 7, url: "https://example.com/", element: { innerText: "所選元素 👩🏽‍💻" }, "extension-context-key": "k1" };
  const files = attachmentFilesFromPaste(data(JSON.stringify(context)));
  assert.equal(files?.length, 1);
  assert.equal(files?.[0].name, "browser-bridge-context-7.json");
  assert.equal(files?.[0].type, "application/json");
  assert.deepEqual(JSON.parse(await files![0].text()), context);
});

test("pasted images/files win, short text falls through, long text is compacted with unique names", () => {
  const image = new File(["x"], "shot.png", { type: "image/png" });
  assert.deepEqual(attachmentFilesFromPaste(data("", [image])), [image]);
  assert.equal(attachmentFilesFromPaste(data("hello")), null);
  assert.equal(attachmentFilesFromPaste(data('{"kind":"other"}')), null);
  const long = "x".repeat(20000);
  assert.equal(attachmentFilesFromPaste(data(long))?.[0].name, "Pasted text.txt");
  assert.equal(attachmentFilesFromPaste(data(long), ["Pasted text.txt"])?.[0].name, "Pasted text 2.txt");
});
