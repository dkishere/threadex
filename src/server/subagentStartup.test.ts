import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubagentStartupSnapshot } from "./subagentStartup";

test("child snapshots are fresh, bounded and use the child's cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "child-startup-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd });
    const clean = await buildSubagentStartupSnapshot(cwd);
    assert.ok(clean.includes(`pwd: ${realpathSync(cwd)}`));
    assert.match(clean, /\(clean\)/);
    for (let i = 0; i < 35; i++) writeFileSync(join(cwd, `file-${i}.txt`), "test");
    const dirty = await buildSubagentStartupSnapshot(cwd, true);
    assert.match(dirty, /…5 more lines/);
    assert.match(dirty, /子代理啟動/);
    assert.equal(dirty.split("\n").filter(line => line.startsWith("?? ")).length, 30);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("missing or invalid cwd never reports a clean repository", async () => {
  const snapshot = await buildSubagentStartupSnapshot("/nonexistent/threadex-child-startup");
  assert.match(snapshot, /unavailable/);
  assert.doesNotMatch(snapshot, /\(clean\)/);
  assert.match(await buildSubagentStartupSnapshot(""), /cwd: unavailable/);
});
