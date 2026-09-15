import assert from "node:assert/strict";
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

test("only allows passive raster formats to render inline", () => {
  assert.equal(canInlineWorkspaceFile("concept.PNG"), true);
  assert.equal(canInlineWorkspaceFile("concept.webp"), true);
  assert.equal(canInlineWorkspaceFile("active.svg"), false);
  assert.equal(canInlineWorkspaceFile("active.html"), false);
});
