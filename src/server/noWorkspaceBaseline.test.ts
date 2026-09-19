import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createWebVsCodeReviewSession } from "./webVsCodeReviewSession";

test("server startup and runner lifecycle do not invoke workspace snapshot writers", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /captureTurnGitBaseline|compactTurnGitBaseline/);
});

test("saved diffs work without snapshots and take precedence over legacy archives", () => {
  const root = mkdtempSync(resolve(tmpdir(), "saved-diff-review-"));
  const cwd = resolve(root, "project");
  const dataDir = resolve(root, "data");
  mkdirSync(cwd);
  try {
    writeFileSync(resolve(cwd, "file.ts"), "new\n");
    const input = { dataDir, cwd, sessionId: "session", turnId: "turn",
      changes: [{ path: "file.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] };
    const first = createWebVsCodeReviewSession(input);
    assert.ok(first);
    assert.equal(JSON.parse(readFileSync(first.requestPath, "utf8")).files[0].baselineText, "old\n");
    const legacy = resolve(dataDir, "code-server/turn-baselines/turn");
    mkdirSync(legacy, { recursive: true });
    // A corrupt archive must not even be read when DB content is available.
    writeFileSync(resolve(legacy, "baseline.json.gz"), "not a gzip archive");
    const second = createWebVsCodeReviewSession(input);
    assert.ok(second);
    assert.equal(JSON.parse(readFileSync(second.requestPath, "utf8")).files[0].baselineText, "old\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
