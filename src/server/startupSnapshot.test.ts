import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildStartupSnapshot } from "./startupSnapshot";

test("startup snapshot identifies a non-Git workspace", () => {
  const root = mkdtempSync(resolve(tmpdir(), "startup-snapshot-"));
  const physicalRoot = realpathSync(root);

  const snapshot = buildStartupSnapshot(root, new Date("2026-07-12T09:00:00.000Z"));

  assert.match(snapshot, /\[STARTUP\]/);
  assert.match(snapshot, /at: 2026-07-12T09:00:00\.000Z/);
  assert.match(snapshot, new RegExp(`pwd: ${escapeRegExp(physicalRoot)}\\n`));
  assert.match(snapshot, /^git: not a Git repository$/m);
});

test("startup snapshot remains available in any workspace", () => {
  const root = mkdtempSync(resolve(tmpdir(), "startup-snapshot-no-git-"));
  const physicalRoot = realpathSync(root);
  const snapshot = buildStartupSnapshot(root);

  assert.match(snapshot, new RegExp(`pwd: ${escapeRegExp(physicalRoot)}\\n`));
  assert.match(snapshot, /^git: not a Git repository$/m);
});

test("startup snapshot includes the concise Git status for a repository", () => {
  const root = mkdtempSync(resolve(tmpdir(), "startup-snapshot-git-"));
  const physicalRoot = realpathSync(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  writeFileSync(resolve(root, "untracked.txt"), "untracked\n");

  const snapshot = buildStartupSnapshot(root, new Date("2026-07-12T09:00:00.000Z"));

  assert.match(snapshot, new RegExp(`^git: repository \\(${escapeRegExp(physicalRoot)}\\)$`, "m"));
  assert.match(snapshot, /^git status:\n\?\? untracked\.txt$/m);
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
