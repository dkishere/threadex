import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexReference, parseCodexReference } from "../codexReference.js";

test("builds and parses workspace-scoped Codex references", () => {
  const uri = buildCodexReference("my-workspace", "local_session-1");
  assert.equal(uri, "codex://threads/local_session-1?workspace=my-workspace");
  assert.deepEqual(parseCodexReference(uri), {
    uri,
    workspaceId: "my-workspace",
    target: "local_session-1",
    lookupKind: "sessionId"
  });
});

test("keeps legacy Codex references compatible", () => {
  assert.deepEqual(parseCodexReference("codex://thread-1"), {
    uri: "codex://threads/thread-1",
    target: "thread-1",
    lookupKind: "threadId"
  });
  assert.deepEqual(parseCodexReference("codex://old-workspace/local_session-1"), {
    uri: "codex://threads/local_session-1?workspace=old-workspace",
    workspaceId: "old-workspace",
    target: "local_session-1",
    lookupKind: "sessionId"
  });
});

test("parses unscoped standard Codex thread references", () => {
  assert.deepEqual(parseCodexReference("codex://threads/01a04e5a-d906-7282-b8a9-124c122f3de2"), {
    uri: "codex://threads/01a04e5a-d906-7282-b8a9-124c122f3de2",
    target: "01a04e5a-d906-7282-b8a9-124c122f3de2",
    lookupKind: "threadId"
  });
});

test("rejects malformed Codex references", () => {
  assert.equal(parseCodexReference("codex://workspace/session/extra"), null);
  assert.equal(parseCodexReference("codex://workspace/%2F"), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?workspace="), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?workspace=one&workspace=two"), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?other=value"), null);
  assert.equal(parseCodexReference("https://workspace/session"), null);
});
