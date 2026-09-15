import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { SessionRecord, WorkspaceRecord } from "./sessionStore";
import {
  buildWalkthroughPrompt,
  createWebVsCodeWalkthroughSession,
  validateWalkthroughAction,
  walkthroughFingerprint,
  webVsCodeWalkthroughActionDirectory,
  webVsCodeWalkthroughResultDirectory,
  WebVsCodeWalkthroughService
} from "./webVsCodeWalkthrough";

test("asks the read-only agent for Markdown and a bounded optional flow chart", () => {
  const prompt = buildWalkthroughPrompt({
    path: "src/example.ts",
    selectedText: "if (ready) run();",
    contextBefore: "",
    contextAfter: ""
  });
  assert.match(prompt, /Return concise Markdown/);
  assert.match(prompt, /fenced Mermaid diagram/);
  assert.match(prompt, /maximum 8 nodes/);
  assert.match(prompt, /Do not edit files/);
});

function fixture(root: string) {
  const cwd = resolve(root, "project");
  mkdirSync(cwd, { recursive: true });
  const sourcePath = resolve(cwd, "source.ts");
  writeFileSync(sourcePath, "const answer = 42;\nexport { answer };\n", "utf8");
  const workspace: WorkspaceRecord = {
    id: "workspace-1",
    name: "Fixture",
    codexHome: resolve(root, "codex-home"),
    cwd,
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };
  const session: SessionRecord = {
    id: "session-1",
    threadId: null,
    workspaceId: workspace.id,
    cwd,
    accountId: null,
    keywordWeights: {},
    title: "Fixture session",
    titleSource: "initial",
    description: "",
    parentSessionId: null,
    forkedFromTurnId: null,
    created: workspace.created,
    updated: workspace.updated
  };
  return { cwd, sourcePath, workspace, session };
}

function actionFor(input: { cwd: string; session: SessionRecord; source: string }) {
  const selectedText = "const answer = 42;";
  const now = Date.now();
  return {
    version: 1,
    kind: "explainSelection" as const,
    actionId: "af1f3e19-a55f-4d8a-960d-7df3c497607b",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    workspacePath: input.cwd,
    sessionId: input.session.id,
    question: "What makes this safe?",
    source: {
      path: "source.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: selectedText.length } },
      selectedText,
      selectionHash: walkthroughFingerprint(selectedText),
      sourceFingerprint: walkthroughFingerprint(input.source),
      context: { before: "", after: "export { answer };" }
    }
  };
}

test("creates a read-only walkthrough bootstrap request", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-walkthrough-request-"));
  try {
    const { cwd, session } = fixture(root);
    const created = createWebVsCodeWalkthroughSession({ dataDir: resolve(root, "data"), sessionId: session.id, cwd });
    const request = JSON.parse(readFileSync(created.requestPath, "utf8"));
    assert.equal(request.version, 2);
    assert.equal(request.mode, "explain");
    assert.deepEqual(request.capabilities, { explain: true, annotate: true, mutate: false, accept: false, reject: false });
    assert.equal(request.files.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates ownership, path, range, and source fingerprints before an explanation runs", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-walkthrough-validation-"));
  try {
    const { cwd, sourcePath, session, workspace } = fixture(root);
    const source = readFileSync(sourcePath, "utf8");
    const action = actionFor({ cwd, session, source });
    const valid = validateWalkthroughAction(action, session, workspace);
    assert.equal(valid.ok, true);
    if (valid.ok) assert.equal(valid.value.relativePath, "source.ts");

    const traversal = { ...action, source: { ...action.source, path: "../outside.ts" } };
    assert.equal(validateWalkthroughAction(traversal, session, workspace).ok, false);

    writeFileSync(sourcePath, "const answer = 7;\nexport { answer };\n", "utf8");
    const stale = validateWalkthroughAction(action, session, workspace);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.stale, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates a diff baseline selection against the server-owned review snapshot", () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-walkthrough-diff-validation-"));
  try {
    const { cwd, session, workspace } = fixture(root);
    const dataDir = resolve(root, "data");
    const requestId = "bd8ea816-856c-42fb-8554-157b3d1cb322";
    const baselineText = "const answer = 7;\nexport { answer };\n";
    const requestDirectory = resolve(dataDir, "code-server", "review-requests");
    mkdirSync(requestDirectory, { recursive: true });
    writeFileSync(resolve(requestDirectory, `1-turn-${requestId}.json`), JSON.stringify({
      version: 2,
      requestId,
      workspacePath: cwd,
      sessionId: session.id,
      mode: "edit",
      files: [{ path: "source.ts", patch: "", baselineText }]
    }), "utf8");
    const selectedText = "const answer = 7;";
    const action: any = actionFor({ cwd, session, source: baselineText });
    action.source = {
      ...action.source,
      revision: "baseline",
      reviewRequestId: requestId,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: selectedText.length } },
      selectedText,
      selectionHash: walkthroughFingerprint(selectedText),
      sourceFingerprint: walkthroughFingerprint(baselineText)
    };

    const valid = validateWalkthroughAction(action, session, workspace, Date.now(), dataDir);
    assert.equal(valid.ok, true);
    if (valid.ok) {
      assert.equal(valid.value.selectedText, selectedText);
      assert.equal(valid.value.workspaceFingerprint, undefined);
    }

    const unowned = { ...action, source: { ...action.source, reviewRequestId: "1172b643-f3df-4cca-b60e-64371d44d240" } };
    assert.equal(validateWalkthroughAction(unowned, session, workspace, Date.now(), dataDir).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a stale result instead of attaching an explanation after the file changes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-walkthrough-service-"));
  let service: WebVsCodeWalkthroughService | null = null;
  try {
    const { cwd, sourcePath, session, workspace } = fixture(root);
    const dataDir = resolve(root, "data");
    const source = readFileSync(sourcePath, "utf8");
    const action = actionFor({ cwd, session, source });
    const actionDirectory = webVsCodeWalkthroughActionDirectory(dataDir);
    mkdirSync(actionDirectory, { recursive: true });
    writeFileSync(resolve(actionDirectory, "request.json"), JSON.stringify(action), "utf8");
    service = new WebVsCodeWalkthroughService({
      dataDir,
      getSession: async () => session,
      getActiveWorkspace: async () => workspace,
      watch: false,
      answer: async () => {
        writeFileSync(sourcePath, "const answer = 7;\nexport { answer };\n", "utf8");
        return "## What it does\nA real agent response.";
      }
    });
    service.start();
    const resultPath = await waitForResult(webVsCodeWalkthroughResultDirectory(dataDir));
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.status, "stale");
    assert.match(result.error, /changed while the explanation/i);
  } finally {
    service?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForResult(directory: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = readdirSync(directory, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (result) return resolve(directory, result.name);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for walkthrough result.");
}
