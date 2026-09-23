import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexReference, parseCodexReference } from "../codexReference.js";

test("numbered turn fragments sort and deduplicate while rejecting malformed numbers", () => {
  assert.deepEqual(parseCodexReference("threadex://MyWorkspace/tx_task#3/1/2/1"), {
    uri: "threadex://MyWorkspace/tx_task#1/2/3", workspaceId: "MyWorkspace", target: "tx_task",
    lookupKind: "sessionId", turnNumbers: [1, 2, 3]
  });
  for (const suffix of ["0", "-1", "01", "1/", "1//2", "9007199254740992", "1?x=y"]) {
    assert.equal(parseCodexReference(`threadex://ws/tx_task#${suffix}`), null);
  }
});

test("builds and parses workspace-scoped Threadex references", () => {
  const uri = buildCodexReference("my-workspace", "local_session-1");
  assert.equal(uri, "threadex://my-workspace/tx_session-1");
  assert.deepEqual(parseCodexReference(uri), {
    uri,
    workspaceId: "my-workspace",
    target: "tx_session-1",
    lookupKind: "sessionId"
  });
});

test("keeps legacy Codex references compatible", () => {
  assert.deepEqual(parseCodexReference("codex://thread-1"), {
    uri: "threadex://default/thread-1",
    target: "thread-1",
    lookupKind: "threadId"
  });
  assert.deepEqual(parseCodexReference("codex://old-workspace/local_session-1"), {
    uri: "threadex://old-workspace/tx_session-1",
    workspaceId: "old-workspace",
    target: "tx_session-1",
    lookupKind: "sessionId"
  });
});

test("parses unscoped standard Codex thread references", () => {
  assert.deepEqual(parseCodexReference("codex://threads/01a04e5a-d906-7282-b8a9-124c122f3de2"), {
    uri: "threadex://default/01a04e5a-d906-7282-b8a9-124c122f3de2",
    target: "01a04e5a-d906-7282-b8a9-124c122f3de2",
    lookupKind: "threadId"
  });
});

test("rejects malformed Codex references", () => {
  assert.equal(parseCodexReference("threadex://ws/tx_task/turn/extra"), null);
  assert.equal(parseCodexReference("threadex://ws/tx_task?turn=x"), null);
  assert.equal(parseCodexReference("codex://workspace/session/extra"), null);
  assert.equal(parseCodexReference("codex://workspace/%2F"), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?workspace="), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?workspace=one&workspace=two"), null);
  assert.equal(parseCodexReference("codex://threads/thread-1?other=value"), null);
  assert.equal(parseCodexReference("https://workspace/session"), null);
});

test("canonical turn references preserve workspace case and encoded turn IDs", () => {
  for (const target of ["tx_task", "native-thread-id"]) {
    const uri = buildCodexReference("My Workspace", target, "turn/8");
    assert.equal(uri, `threadex://My%20Workspace/${target}/turn%2F8`);
    assert.deepEqual(parseCodexReference(uri), { uri, workspaceId: "My Workspace", target, turnId: "turn/8",
      lookupKind: target.startsWith("tx_") ? "sessionId" : "threadId" });
  }
});
