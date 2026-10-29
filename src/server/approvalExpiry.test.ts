import assert from "node:assert/strict";
import test from "node:test";
import { INTENT_APPROVAL_METHOD } from "../intentApproval";
import { isApprovalTurnInactive, isRunnerApprovalStale, markExpiredApprovalItems } from "./approvalExpiry";

const command = "item/commandExecution/requestApproval";

test("runner approvals expire once re-registration stops and no runner is waiting", () => {
  const now = 1_000_000;
  assert.equal(isRunnerApprovalStale({ method: command, lastSeenAt: now - 60_000 }, now, 120_000), false);
  assert.equal(isRunnerApprovalStale({ method: command, lastSeenAt: now - 121_000 }, now, 120_000), true);
  // An attached /wait, an answered request or a host-owned intention is never swept.
  assert.equal(isRunnerApprovalStale({ method: command, lastSeenAt: now - 121_000, resolve: () => undefined }, now, 120_000), false);
  assert.equal(isRunnerApprovalStale({ method: command, lastSeenAt: now - 121_000, decision: "accept" }, now, 120_000), false);
  assert.equal(isRunnerApprovalStale({ method: INTENT_APPROVAL_METHOD, lastSeenAt: now - 121_000 }, now, 120_000), false);
});

test("runner questions expire with their turn even while an orphaned runner still waits", () => {
  const input = { method: "item/tool/requestUserInput", sessionId: "s1", resolve: () => undefined, lastSeenAt: Date.now() };
  assert.equal(isApprovalTurnInactive(input, { sessionId: "s1", status: "running" }), false);
  // Stopped turns are saved as todo; finished or deleted turns cannot be answered either.
  for (const status of ["todo", "done", "error"]) assert.equal(isApprovalTurnInactive(input, { sessionId: "s1", status }), true);
  assert.equal(isApprovalTurnInactive(input, null), true);
  assert.equal(isApprovalTurnInactive(input, { sessionId: "other", status: "running" }), true);
  // Answered requests and host-owned intentions follow their own lifecycle.
  assert.equal(isApprovalTurnInactive({ ...input, decision: "cancel" }, { sessionId: "s1", status: "todo" }), false);
  assert.equal(isApprovalTurnInactive({ ...input, method: INTENT_APPROVAL_METHOD }, { sessionId: "s1", status: "todo" }), false);
});

test("persisted pending approvals the server no longer holds load as expired", () => {
  const items = [
    { id: "approval:live", itemType: "approval", approvalId: "live", status: "pending", eventType: "item.started" },
    { id: "approval:gone", itemType: "approval", approvalId: "gone", status: "pending", eventType: "item.started" },
    { id: "approval:done", itemType: "approval", approvalId: "done", status: "resolved", decision: "accept" },
    { id: "message", itemType: "agent_message", status: "pending" }
  ];
  const marked = markExpiredApprovalItems(items, (id) => id === "live") as Array<Record<string, unknown>>;
  assert.equal(marked[0].status, "pending");
  assert.deepEqual({ status: marked[1].status, eventType: marked[1].eventType }, { status: "expired", eventType: "item.completed" });
  assert.equal(marked[2], items[2]);
  assert.equal(marked[3], items[3]);
});
