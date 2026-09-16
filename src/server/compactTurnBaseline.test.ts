import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { captureTurnGitBaseline, compactTurnGitBaseline, readCompactTurnBaseline } from "./turnGitPatch";
import { createWebVsCodeReviewSession } from "./webVsCodeReviewSession";

test("compaction preserves original content after later edits, additions and deletions", () => {
  const root = mkdtempSync(resolve(tmpdir(), "compact-baseline-"));
  const cwd = resolve(root, "project");
  const dataDir = resolve(root, "data");
  mkdirSync(cwd);
  try {
    writeFileSync(resolve(cwd, "changed.txt"), "original\n");
    writeFileSync(resolve(cwd, "deleted.txt"), "deleted original\n");
    writeFileSync(resolve(cwd, "unchanged.txt"), "keep\n");
    captureTurnGitBaseline(dataDir, "turn", cwd);
    writeFileSync(resolve(cwd, "changed.txt"), "edited\n");
    writeFileSync(resolve(cwd, "added.txt"), "new\n");
    rmSync(resolve(cwd, "deleted.txt"));
    compactTurnGitBaseline(dataDir, "turn", cwd, ["changed.txt", "added.txt", "deleted.txt"]);
    assert.equal(existsSync(resolve(dataDir, "code-server/turn-baselines/turn/git")), false);
    assert.equal(readCompactTurnBaseline(dataDir, "turn", cwd, "changed.txt"), "original\n");
    assert.equal(readCompactTurnBaseline(dataDir, "turn", cwd, "added.txt"), null);
    assert.equal(readCompactTurnBaseline(dataDir, "turn", cwd, "unchanged.txt"), undefined);
    writeFileSync(resolve(cwd, "changed.txt"), "inserted later\nedited again\n");
    const review = createWebVsCodeReviewSession({ dataDir, cwd, turnId: "turn", sessionId: "session",
      changes: ["changed.txt", "added.txt", "deleted.txt"].map(path => ({ path })) });
    assert.ok(review);
    const request = JSON.parse(readFileSync(review.requestPath, "utf8"));
    assert.equal(request.files[0].baselineText, "original\n");
    assert.equal(request.files[1].baselineText, "");
    assert.equal(request.files[2].baselineText, "deleted original\n");
    assert.match(request.files[0].patch, /\+inserted later/);
    compactTurnGitBaseline(dataDir, "turn", cwd, []);
    assert.equal(readCompactTurnBaseline(dataDir, "turn", cwd, "changed.txt"), "original\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsupported binary content retains the original Git snapshot", () => {
  const root = mkdtempSync(resolve(tmpdir(), "compact-baseline-binary-"));
  const cwd = resolve(root, "project");
  const dataDir = resolve(root, "data");
  mkdirSync(cwd);
  try {
    writeFileSync(resolve(cwd, "binary"), Buffer.from([0, 1, 2]));
    captureTurnGitBaseline(dataDir, "turn", cwd);
    assert.throws(() => compactTurnGitBaseline(dataDir, "turn", cwd, ["binary"]), /Non-text/);
    assert.equal(existsSync(resolve(dataDir, "code-server/turn-baselines/turn/git")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
