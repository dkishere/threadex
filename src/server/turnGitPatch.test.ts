import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildTurnGitPatch, captureTurnGitBaseline } from "./turnGitPatch";

test("creates a standard multi-file git patch from a shadow index without touching the project git state", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-turn-patch-"));
  const cwd = resolve(root, "project");
  const dataDir = resolve(root, "runtime");
  mkdirSync(resolve(cwd, "src"), { recursive: true });
  writeFileSync(resolve(cwd, "src", "changed.ts"), "one\ntwo\nthree\n", "utf8");
  writeFileSync(resolve(cwd, "src", "deleted.ts"), "remove me\n", "utf8");

  captureTurnGitBaseline(dataDir, "turn-1", cwd);
  writeFileSync(resolve(cwd, "src", "changed.ts"), "one\nTWO\nthree\n", "utf8");
  writeFileSync(resolve(cwd, "src", "added.ts"), "new file\n", "utf8");
  rmSync(resolve(cwd, "src", "deleted.ts"));
  const patch = buildTurnGitPatch(dataDir, "turn-1", cwd, ["src/changed.ts", "src/added.ts", "src/deleted.ts"]);

  assert.ok(patch);
  assert.match(patch, /diff --git a\/src\/changed\.ts b\/src\/changed\.ts/);
  assert.match(patch, /-two\n\+TWO/);
  assert.match(patch, /new file mode/);
  assert.match(patch, /deleted file mode/);
  assert.equal(existsSync(resolve(cwd, ".git")), false);
  rmSync(root, { recursive: true, force: true });
});

test("ignores nested Git workspaces that cannot be added to the shadow index", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-turn-nested-git-"));
  const cwd = resolve(root, "project");
  const dataDir = resolve(root, "runtime");
  mkdirSync(resolve(cwd, "nested", ".git"), { recursive: true });
  writeFileSync(resolve(cwd, "nested", "file.ts"), "nested\n", "utf8");
  writeFileSync(resolve(cwd, "main.ts"), "before\n", { encoding: "utf8", flag: "wx" });
  try {
    captureTurnGitBaseline(dataDir, "turn-1", cwd);
    writeFileSync(resolve(cwd, "main.ts"), "after\n", "utf8");
    const patch = buildTurnGitPatch(dataDir, "turn-1", cwd, ["main.ts"]);
    assert.match(patch ?? "", /-before\n\+after/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
