import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildWebVsCodeReview } from "./webVsCodeReview";

test("combines one turn's file changes into a single review without git metadata", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-web-review-"));
  const review = buildWebVsCodeReview([
    { path: "src/a.ts", kind: "update", before: "old", after: "new" },
    { path: "src/b.ts", kind: "add", after: "added" }
  ], cwd);
  assert.match(review, /# Files: 2/);
  assert.match(review, /--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts/);
  assert.match(review, /-old\n\+new/);
  assert.match(review, /--- \/dev\/null\n\+\+\+ b\/src\/b\.ts/);
});

test("does not invent an empty baseline when an update only contains a path", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-web-review-"));
  writeFileSync(resolve(cwd, "current.ts"), "current contents\n", "utf8");
  const review = buildWebVsCodeReview([{ path: "current.ts", kind: "update" }], cwd);
  assert.doesNotMatch(review, /current contents/);
  assert.doesNotMatch(review, /^@@ /m);
});

test("uses a saved hunk-only turn diff without treating the whole file as added", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-web-review-"));
  const review = buildWebVsCodeReview([{
    path: "src/current.ts",
    kind: "update",
    diff: "@@ -2,2 +2,2 @@\n-old value\n+new value\n context"
  }], cwd);
  assert.match(review, /--- a\/src\/current\.ts\n\+\+\+ b\/src\/current\.ts/);
  assert.match(review, /@@ -2,2 \+2,2 @@\n-old value\n\+new value/);
  assert.doesNotMatch(review, /@@ -1,0/);
});

test("keeps a legacy Add File event whose source text was stored in diff", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-web-review-"));
  const review = buildWebVsCodeReview([{
    path: "src/new.ts",
    kind: "",
    diff: "export const added = true;\n"
  }], cwd);
  assert.match(review, /--- \/dev\/null\n\+\+\+ b\/src\/new\.ts/);
  assert.match(review, /@@ -1,0 \+1,1 @@\n\+export const added = true;/);
});

test("ignores review paths outside the session cwd", () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "threadex-web-review-"));
  const review = buildWebVsCodeReview([{ path: "../secret.txt", after: "secret" }], cwd);
  assert.doesNotMatch(review, /secret\.txt/);
});
