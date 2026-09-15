import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { captureTurnGitBaseline } from "./turnGitPatch";
import { collectSessionReviewChanges, collectTurnReviewChanges, createWebVsCodeAnnotationSession, createWebVsCodeReviewSession } from "./webVsCodeReviewSession";

test("creates one source-level review request containing every changed file", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-session-"));
  const dataDir = resolve(root, "data");
  const cwd = resolve(root, "project");
  const firstPath = resolve(cwd, "first.ts");
  const secondPath = resolve(cwd, "second.ts");
  try {
    mkdirSync(cwd, { recursive: true });
    writeFileSync(firstPath, "export const first = 1;\n", { encoding: "utf8", flag: "wx" });
    writeFileSync(secondPath, "export const second = 2;\n", { encoding: "utf8", flag: "wx" });
    captureTurnGitBaseline(dataDir, "turn-1", cwd);
    writeFileSync(firstPath, "export const first = 10;\n", "utf8");
    writeFileSync(secondPath, "export const second = 20;\n", "utf8");

    const result = createWebVsCodeReviewSession({
      dataDir,
      sessionId: "session-1",
      turnId: "turn-1",
      cwd,
      changes: [
        { path: "first.ts", kind: "update" },
        { path: "second.ts", kind: "update" }
      ]
    });

    assert.ok(result);
    assert.equal(result.fileCount, 2);
    assert.equal(result.firstOpenPath, "first.ts");
    const request = JSON.parse(readFileSync(result.requestPath, "utf8"));
    assert.equal(request.version, 2);
    assert.equal(request.mode, "edit");
    assert.deepEqual(request.capabilities, { explain: true, annotate: true, mutate: true, accept: true, reject: true });
    assert.equal(request.workspacePath, cwd);
    assert.deepEqual(request.files.map((file: { path: string }) => file.path), ["first.ts", "second.ts"]);
    assert.match(request.files[0].patch, /^@@ /m);
    assert.equal(request.files[0].baselineText, "export const first = 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a project annotation request tied to its source session", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-annotation-"));
  try {
    const result = createWebVsCodeAnnotationSession({
      dataDir: resolve(root, "data"),
      sessionId: "session-current",
      cwd: resolve(root, "project"),
      returnUrl: "http://127.0.0.1:8787/?workspaceId=w&sessionId=session-current"
    });
    const request = JSON.parse(readFileSync(result.requestPath, "utf8"));
    assert.equal(request.version, 3);
    assert.equal(request.mode, "annotate");
    assert.equal(request.sessionId, "session-current");
    assert.equal(request.returnUrl, "http://127.0.0.1:8787/?workspaceId=w&sessionId=session-current");
    assert.deepEqual(request.capabilities, { explain: false, annotate: true, mutate: false, accept: false, reject: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collects every saved file-change event for a turn in order", () => {
  const changes = collectTurnReviewChanges([
    { itemType: "command_execution", changes: [{ path: "ignored.ts" }] },
    { itemType: "file_change", changes: [{ path: "same.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] },
    { itemType: "file_change", changes: [{ path: "same.ts", diff: "@@ -2 +2 @@\n-c\n+d" }] }
  ]) as Array<{ path: string; diff: string }>;

  assert.deepEqual(changes.map((change) => change.path), ["same.ts", "same.ts"]);
  assert.match(changes[0].diff, /-a/);
  assert.match(changes[1].diff, /-c/);
});

test("uses the authoritative net turn diff instead of reverted edit activity", () => {
  const changes = collectTurnReviewChanges([
    { itemType: "file_change", changes: [{ path: "reverted-a.ts" }, { path: "reverted-b.ts" }] },
    {
      itemType: "file_change",
      authoritative: true,
      changes: [{ path: "net-a.ts" }, { path: "net-b.ts" }, { path: "net-c.ts" }]
    }
  ]) as Array<{ path: string }>;

  assert.deepEqual(changes.map((change) => change.path), ["net-a.ts", "net-b.ts", "net-c.ts"]);
});

test("collects saved file changes from every turn in a session", () => {
  const changes = collectSessionReviewChanges({
    "turn-1": [{ itemType: "file_change", changes: [{ path: "first.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] }],
    "turn-2": [{ itemType: "file_change", changes: [{ path: "second.ts", diff: "@@ -1 +1 @@\n-c\n+d" }] }]
  }) as Array<{ path: string }>;

  assert.deepEqual(changes.map((change) => change.path), ["first.ts", "second.ts"]);
});

test("labels a cross-turn review as a session review", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-session-scope-"));
  const dataDir = resolve(root, "data");
  const cwd = resolve(root, "project");
  try {
    mkdirSync(cwd, { recursive: true });
    writeFileSync(resolve(cwd, "changed.ts"), "const changed = true;\n", "utf8");
    const result = createWebVsCodeReviewSession({
      dataDir,
      sessionId: "session-1",
      turnId: "",
      scope: "session",
      cwd,
      changes: [{ path: "changed.ts", kind: "update", diff: "@@ -1 +1 @@\n-const changed = false;\n+const changed = true;" }]
    });

    assert.ok(result);
    const request = JSON.parse(readFileSync(result.requestPath, "utf8"));
    assert.equal(request.title, "Threadex session review");
    assert.equal(request.source.kind, "session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to every saved hunk for the same file without an empty-file diff", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-session-hunks-"));
  const dataDir = resolve(root, "data");
  const cwd = resolve(root, "project");
  try {
    mkdirSync(resolve(cwd, "src"), { recursive: true });
    writeFileSync(resolve(cwd, "src/current.ts"), "one changed\ntwo changed\n", "utf8");

    const result = createWebVsCodeReviewSession({
      dataDir,
      sessionId: "session-1",
      turnId: "turn-without-shadow-baseline",
      cwd,
      changes: [
        { path: "src/current.ts", kind: "update", diff: "@@ -1 +1 @@\n-one\n+one changed" },
        { path: "src/current.ts", kind: "update", diff: "@@ -2 +2 @@\n-two\n+two changed" }
      ]
    });

    assert.ok(result);
    assert.equal(result.fileCount, 1);
    const request = JSON.parse(readFileSync(result.requestPath, "utf8"));
    assert.match(request.files[0].patch, /-one\n\+one changed/);
    assert.match(request.files[0].patch, /-two\n\+two changed/);
    assert.doesNotMatch(request.files[0].patch, /@@ -1,0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviews saved absolute file changes from one external Git worktree", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-web-vscode-external-"));
  const dataDir = resolve(root, "data");
  const cwd = resolve(root, "session-project");
  const externalCwd = resolve(root, "external-project");
  const changedPath = resolve(externalCwd, "src", "changed.ts");
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(resolve(externalCwd, "src"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: externalCwd });
    writeFileSync(changedPath, "const changed = true;\n", "utf8");

    const denied = createWebVsCodeReviewSession({
      dataDir,
      sessionId: "session-1",
      turnId: "turn-1",
      cwd,
      changes: [{ path: changedPath, kind: "update", diff: "@@ -1 +1 @@\n-const changed = false;\n+const changed = true;" }]
    });
    assert.equal(denied, null);

    const result = createWebVsCodeReviewSession({
      dataDir,
      sessionId: "session-1",
      turnId: "turn-1",
      cwd,
      allowExternalPaths: true,
      changes: [{ path: changedPath, kind: "update", diff: "@@ -1 +1 @@\n-const changed = false;\n+const changed = true;" }]
    });

    assert.ok(result);
    assert.equal(result.workspacePath, externalCwd);
    assert.equal(result.firstOpenPath, "src/changed.ts");
    const request = JSON.parse(readFileSync(result.requestPath, "utf8"));
    assert.equal(request.workspacePath, externalCwd);
    assert.deepEqual(request.files.map((file: { path: string }) => file.path), ["src/changed.ts"]);
    assert.equal(request.files[0].baselineText, "const changed = false;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
