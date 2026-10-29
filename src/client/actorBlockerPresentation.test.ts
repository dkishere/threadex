import assert from "node:assert/strict";
import test from "node:test";
import type { ActorBlocker, ActorBlockerProposal } from "../actorBlockers";
import { actorBlockers, blockerCountLabel, blockerCounts, blockerProposalState, taskBlockers, visibleBlockers } from "./actorBlockerPresentation";

const proposal = (fields: Partial<ActorBlockerProposal> = {}) => ({ id: "p1", actorId: "ui", text: "Update the test", requiresApproval: true, created: "2026-10-26T10:00:00.000Z", ...fields }) as ActorBlockerProposal;
const blocker = (id: string, fields: Partial<ActorBlocker> = {}) => ({
  id, workspaceId: "w", workItemId: "work", roundId: "round", taskSessionId: "task-1", ownerActorId: "ui", executorActorId: "ui",
  kind: "other", source: "agent", dedupeKey: id, description: id, selfClearing: false, status: "open",
  created: "2026-10-26T10:00:00.000Z", updated: "2026-10-26T10:00:00.000Z", proposals: [], history: [], ...fields
}) as ActorBlocker;

test("visible blockers hide closed and self-clearing ones and list escalations first", () => {
  const list = [
    blocker("old-open", { updated: "2026-10-26T09:00:00.000Z" }),
    blocker("new-open", { updated: "2026-10-26T11:00:00.000Z" }),
    blocker("escalated", { status: "escalated", updated: "2026-10-26T08:00:00.000Z" }),
    blocker("resolved", { status: "resolved" }),
    blocker("dismissed", { status: "dismissed" }),
    blocker("wait", { selfClearing: true })
  ];
  assert.deepEqual(visibleBlockers(list).map(entry => entry.id), ["escalated", "new-open", "old-open"]);
  assert.deepEqual(visibleBlockers(undefined), []);
});

test("task and actor levels select by session and executing actor", () => {
  const list = [blocker("a", { taskSessionId: "task-1" }), blocker("b", { taskSessionId: "task-2", executorActorId: "sub", ownerActorId: "ui" })];
  assert.deepEqual(taskBlockers(list, "task-2").map(entry => entry.id), ["b"]);
  assert.deepEqual(taskBlockers(list, null), []);
  assert.deepEqual(actorBlockers(list, "ui").map(entry => entry.id), ["a"]);
  assert.deepEqual(actorBlockers(list, "sub").map(entry => entry.id), ["b"]);
});

test("counts include escalations and proposals awaiting the user's decision", () => {
  const counts = blockerCounts([
    blocker("escalated", { status: "escalated" }),
    blocker("pending", { status: "solution_proposed", proposals: [proposal()] }),
    blocker("approved", { status: "solution_proposed", proposals: [proposal({ approval: { by: "user", at: "2026-10-26T10:05:00.000Z" } })] })
  ]);
  assert.deepEqual(counts, { active: 3, escalated: 1, pendingDecision: 1 });
  assert.equal(blockerCountLabel(counts), "3 active blockers, 1 escalated, 1 awaiting your decision");
  assert.equal(blockerCountLabel({ active: 1, escalated: 0, pendingDecision: 0 }), "1 active blocker");
});

test("proposal state reflects outcome, approval and whether approval is required", () => {
  assert.equal(blockerProposalState(proposal()), "Awaiting your approval");
  assert.equal(blockerProposalState(proposal({ requiresApproval: false })), "Proposed");
  assert.equal(blockerProposalState(proposal({ approval: { by: "user", at: "x" } })), "Approved by you");
  assert.equal(blockerProposalState(proposal({ outcome: "rejected" })), "Rejected");
  assert.equal(blockerProposalState(proposal({ outcome: "attempting", approval: { by: "user", at: "x" } })), "In progress");
});
