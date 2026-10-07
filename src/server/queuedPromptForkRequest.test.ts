import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { queuedPromptForkRequestTarget, sessionTaskRequestSessionId } from "./queuedPromptForkRequest";

const requestId = `qfork_${"a".repeat(48)}`;
const ordinary = {
  parentSessionId: "ordinary-task",
  managerSessionId: "workspace-manager",
  requestId,
  cwd: "/Volumes/dev"
};

test("ordinary queue forks omit Manager-only cwd even when their workspace has a Manager", () => {
  const target = queuedPromptForkRequestTarget(ordinary, "workspace-manager");
  assert.deepEqual(target.request, {
    parentSessionId: "ordinary-task", sourceSessionId: "ordinary-task",
    queueForkRequestId: requestId, contextFork: true
  });
  assert.equal(Object.hasOwn(target.request, "cwd"), false);
  assert.equal(Object.hasOwn(target.request, "managerRequestId"), false);
});

test("ordinary queue fork recovery looks up the API's source-task identity, not its workspace Manager", () => {
  const target = queuedPromptForkRequestTarget(ordinary, "workspace-manager");
  const createdSessionId = sessionTaskRequestSessionId(target.request.sourceSessionId, requestId);
  assert.equal(target.sessionId, createdSessionId);
  assert.equal(target.turnId, `manager_task_${createdSessionId}`);
  assert.notEqual(target.sessionId, sessionTaskRequestSessionId("workspace-manager", requestId));
  assert.deepEqual(queuedPromptForkRequestTarget(ordinary, "workspace-manager"), target,
    "retry must locate the same child");
});

test("a workspace without a Manager still forks an ordinary task", () => {
  const target = queuedPromptForkRequestTarget({ ...ordinary, managerSessionId: ordinary.parentSessionId }, null);
  assert.ok("queueForkRequestId" in target.request);
  assert.equal(target.request.queueForkRequestId, requestId);
  assert.equal(Object.hasOwn(target.request, "cwd"), false);
  assert.equal(target.sessionId, sessionTaskRequestSessionId(ordinary.parentSessionId, requestId));
});

test("Manager-owned queue forks keep cwd validation and Manager request identity", () => {
  const target = queuedPromptForkRequestTarget({ ...ordinary, parentSessionId: "workspace-manager" }, "workspace-manager");
  assert.deepEqual(target.request, {
    parentSessionId: "workspace-manager", sourceSessionId: "workspace-manager",
    managerRequestId: requestId, cwd: "/Volumes/dev"
  });
  assert.equal(Object.hasOwn(target.request, "contextFork"), false);
  assert.equal(target.sessionId, sessionTaskRequestSessionId("workspace-manager", requestId));
});

test("task identity remains compatible with previously created children", () => {
  for (const source of ["ordinary-task", "workspace-manager"]) {
    assert.equal(sessionTaskRequestSessionId(source, requestId),
      `tx_${createHash("sha256").update(`${source}:${requestId}`).digest("hex").slice(0, 32)}`);
  }
  assert.notEqual(sessionTaskRequestSessionId("ordinary-task", requestId),
    sessionTaskRequestSessionId("another-task", requestId));
});
