import assert from "node:assert/strict";
import test from "node:test";
import { compactFilePath } from "./filePathDisplay.js";

test("keeps paths with three or fewer levels intact", () => {
  assert.equal(compactFilePath("src/client/App.tsx"), "src/client/App.tsx");
});

test("shows the final three path levels with an omitted prefix", () => {
  assert.equal(
    compactFilePath("/Volumes/dev/tools/session-manager/extensions/threadex-review/extension.js"),
    "…/extensions/threadex-review/extension.js"
  );
});

test("preserves Windows separators in compact labels", () => {
  assert.equal(compactFilePath("C:\\workspace\\src\\client\\App.tsx"), "…\\src\\client\\App.tsx");
});
