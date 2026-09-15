import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  isCodexSessionTitlePending,
  markCodexSessionTitlePending,
  normalizeCodexSessionTitle,
  parseCodexSessionIndex,
  readCodexSessionTitles,
  writeCodexSessionTitle
} from "./codexSessionTitles";

test("parses the latest named Codex session index records", () => {
  const titles = parseCodexSessionIndex([
    JSON.stringify({ id: "thread-1", thread_name: "First name" }),
    "not json",
    JSON.stringify({ id: "thread-2", thread_name: null }),
    JSON.stringify({ id: "thread-1", thread_name: "Updated name" }),
    JSON.stringify({ id: "thread-3", thread_name: "Removed later" }),
    JSON.stringify({ id: "thread-3", thread_name: null }),
    ""
  ].join("\n"));

  assert.deepEqual(titles, [{ threadId: "thread-1", title: "Updated name" }]);
});

test("normalizes Codex titles consistently with imported sessions", () => {
  assert.equal(normalizeCodexSessionTitle("  Name\n with   spacing  "), "Name with spacing");
  assert.equal(normalizeCodexSessionTitle(" "), null);
  assert.equal(normalizeCodexSessionTitle("a".repeat(80)), `${"a".repeat(69)}...`);
});

test("writes Codex session title updates to the index", () => {
  const codexHome = mkdtempSync(resolve(tmpdir(), "codex-session-title-write-test-"));
  assert.deepEqual(
    writeCodexSessionTitle(codexHome, { threadId: " thread-1 ", title: "  New\n name  " }),
    { threadId: "thread-1", title: "New name" }
  );
  assert.deepEqual(readCodexSessionTitles(codexHome), [{ threadId: "thread-1", title: "New name" }]);

  const indexPath = resolve(codexHome, "session_index.jsonl");
  const line = readFileSync(indexPath, "utf8").trim();
  assert.match(line, /"id":"thread-1"/);
  assert.match(line, /"thread_name":"New name"/);

  assert.equal(writeCodexSessionTitle(codexHome, { threadId: "", title: "Ignored" }), null);
  assert.equal(writeCodexSessionTitle(codexHome, { threadId: "thread-2", title: " " }), null);
  assert.equal(readFileSync(indexPath, "utf8").trim().split("\n").length, 1);
});

test("does not create a Codex session index for empty title writes", () => {
  const codexHome = mkdtempSync(resolve(tmpdir(), "codex-session-title-empty-test-"));
  assert.equal(writeCodexSessionTitle(codexHome, { threadId: "", title: "" }), null);
  assert.equal(existsSync(resolve(codexHome, "session_index.jsonl")), false);
});

test("marks fallback titles pending without duplicating the marker", () => {
  assert.equal(markCodexSessionTitlePending("Fallback title"), "**Fallback title");
  assert.equal(markCodexSessionTitlePending("**Fallback title"), "**Fallback title");
  assert.equal(isCodexSessionTitlePending("**Fallback title"), true);
  assert.equal(isCodexSessionTitlePending("Codex title"), false);
});
