import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canInlineWorkspaceFile, resolveWorkspaceFilePath } from "./workspaceFiles";

test("resolves relative and absolute files only within a workspace", () => {
  const root = "/Volumes/dev/tools/session-manager";
  assert.equal(resolveWorkspaceFilePath(root, "src/client/main.tsx"), `${root}/src/client/main.tsx`);
  assert.equal(resolveWorkspaceFilePath(root, `${root}/image.png`), `${root}/image.png`);
  assert.equal(resolveWorkspaceFilePath(root, "/Volumes/dev/elsewhere/secret.txt"), null);
  assert.equal(resolveWorkspaceFilePath(root, "../secret.txt"), null);
});

test("allows absolute files inside explicitly configured temporary roots", () => {
  const root = "/Volumes/dev/tools/session-manager";
  assert.equal(
    resolveWorkspaceFilePath(root, "/private/tmp/structured-comment-compact-ui.png", ["/private/tmp"]),
    "/private/tmp/structured-comment-compact-ui.png"
  );
  assert.equal(
    resolveWorkspaceFilePath(root, "/private/elsewhere/secret.png", ["/private/tmp"]),
    null
  );
});

test("allows symlinked aliases of a temporary root, such as macOS /tmp", () => {
  const fixtureDirectory = realpathSync(mkdtempSync(join(tmpdir(), "threadex-workspace-files-")));
  try {
    const runnerTemporaryRoot = join(fixtureDirectory, "private-tmp");
    const outsideDirectory = join(fixtureDirectory, "outside");
    mkdirSync(join(runnerTemporaryRoot, "shots"), { recursive: true });
    mkdirSync(outsideDirectory);
    writeFileSync(join(runnerTemporaryRoot, "shots", "agent-screenshot.png"), "");
    writeFileSync(join(outsideDirectory, "secret.png"), "");
    const aliasRoot = join(fixtureDirectory, "tmp");
    const outsideAlias = join(fixtureDirectory, "outside-alias");
    symlinkSync(runnerTemporaryRoot, aliasRoot);
    symlinkSync(outsideDirectory, outsideAlias);

    const workspaceRoot = "/Volumes/dev/tools/session-manager";
    assert.equal(
      resolveWorkspaceFilePath(workspaceRoot, join(aliasRoot, "shots", "agent-screenshot.png"), [runnerTemporaryRoot]),
      join(runnerTemporaryRoot, "shots", "agent-screenshot.png")
    );
    assert.equal(resolveWorkspaceFilePath(workspaceRoot, join(outsideAlias, "secret.png"), [runnerTemporaryRoot]), null);
    assert.equal(resolveWorkspaceFilePath(workspaceRoot, join(aliasRoot, "shots", "missing.png"), [runnerTemporaryRoot]), null);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test("only allows passive raster formats to render inline", () => {
  assert.equal(canInlineWorkspaceFile("concept.PNG"), true);
  assert.equal(canInlineWorkspaceFile("concept.webp"), true);
  assert.equal(canInlineWorkspaceFile("active.svg"), false);
  assert.equal(canInlineWorkspaceFile("active.html"), false);
});
