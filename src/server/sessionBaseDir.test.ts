import assert from "node:assert/strict";
import test from "node:test";
import { resolveNewSessionCwd } from "./sessionBaseDir";

const workspace = { id: "threadex", cwd: "/Volumes/dev/tools/session-manager" };

test("uses a trusted base session cwd even when it is outside the workspace root", () => {
  assert.equal(resolveNewSessionCwd({
    workspace,
    reusableSession: null,
    baseSession: { workspaceId: workspace.id, cwd: "/Users/dillionkum/workflow-test" },
    requestedBaseSessionId: "local_workflow"
  }), "/Users/dillionkum/workflow-test");
});

test("a trusted base session cwd takes precedence over a selected project", () => {
  assert.equal(resolveNewSessionCwd({
    workspace,
    reusableSession: null,
    baseSession: { workspaceId: workspace.id, cwd: "/Users/dillionkum/workflow-test" },
    requestedBaseSessionId: "local_workflow",
    requestedNewSessionCwd: "/Volumes/dev/tools/session-manager/project"
  }), "/Users/dillionkum/workflow-test");
});

test("rejects a base session from another workspace", () => {
  assert.throws(() => resolveNewSessionCwd({
    workspace,
    reusableSession: null,
    baseSession: { workspaceId: "other", cwd: "/Users/dillionkum/other" },
    requestedBaseSessionId: "local_other"
  }), /active workspace/);
});

test("falls back to the workspace cwd without a base session", () => {
  assert.equal(resolveNewSessionCwd({
    workspace,
    reusableSession: null,
    baseSession: null,
    requestedBaseSessionId: undefined
  }), workspace.cwd);
});

test("uses the server-resolved Codex project cwd when creating a session without a base session", () => {
  assert.equal(resolveNewSessionCwd({
    workspace,
    reusableSession: null,
    baseSession: null,
    requestedBaseSessionId: undefined,
    requestedNewSessionCwd: "/Users/dillionkum/project"
  }), "/Users/dillionkum/project");
});

test("keeps the stored cwd when an existing session is reused", () => {
  assert.equal(resolveNewSessionCwd({
    workspace,
    reusableSession: { workspaceId: workspace.id, cwd: "/Users/dillionkum/existing" },
    baseSession: null,
    requestedBaseSessionId: undefined,
    requestedNewSessionCwd: "/Users/dillionkum/project"
  }), "/Users/dillionkum/existing");
});
