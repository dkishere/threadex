import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTOR_BLOCKER_CONTEXT_LIMIT, ACTOR_BLOCKER_TEXT_CHARS, actorBlockerContext, actorBlockerContextDigest, actorBlockerNote,
  actorBlockerOverview, actorBlockerPendingDecision, approveActorBlockerProposal,
  closeActorBlocker, declareActorBlockerUnresolvable, escalateOverdueActorBlockers, openActorBlocker, proposeActorBlockerSolution,
  recordActorBlockerAttempt, rejectActorBlockerProposal, resolveActorBlockersWhere, transitionActorBlocker
} from "../actorBlockers";
import type { ActorBlockerRoom, OpenActorBlockerInput } from "../actorBlockers";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const T4 = "2026-01-01T00:04:00.000Z";

function makeRoom(): ActorBlockerRoom { return { workspaceId: "ws1", blockers: [], blockerNotices: [] }; }
function input(overrides: Partial<OpenActorBlockerInput> = {}): OpenActorBlockerInput {
  return { workItemId: "wi1", roundId: "round1", taskSessionId: "task1", ownerActorId: "owner1", executorActorId: "exec1",
    kind: "error", source: "agent", description: "Build fails with missing module", by: "owner1", ...overrides };
}
function open(room: ActorBlockerRoom, overrides: Partial<OpenActorBlockerInput> = {}, at = T0) {
  return openActorBlocker(room, input(overrides), at);
}
/** Opens a non-self-clearing blocker and escalates it as unresolvable. */
function escalated(room: ActorBlockerRoom, description: string, at = T1, overrides: Partial<OpenActorBlockerInput> = {}) {
  const { blocker } = open(room, { description, ...overrides }, T0);
  declareActorBlockerUnresolvable(room, blocker, "owner1", at, "dead end");
  return blocker;
}

test("dedupe: same session, kind and normalized description opens one blocker", () => {
  const room = makeRoom();
  const first = open(room);
  assert.equal(first.created, true);
  const second = open(room, { description: "  BUILD fails   with\nmissing MODULE " }, T1);
  assert.equal(second.created, false);
  assert.equal(second.blocker, first.blocker);
  assert.equal(room.blockers!.length, 1);
});

test("dedupe: different session, kind or a resolved blocker allows a new one", () => {
  const room = makeRoom();
  const first = open(room).blocker;
  assert.equal(open(room, { taskSessionId: "task2" }, T1).created, true);
  assert.equal(open(room, { kind: "external" }, T1).created, true);
  closeActorBlocker(room, first, "resolved", "owner1", T2);
  const again = open(room, {}, T3);
  assert.equal(again.created, true);
  assert.notEqual(again.blocker.id, first.id);
  assert.equal(room.blockers!.length, 4);
});

test("dedupe refreshes evidence of the existing blocker", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  open(room, { evidence: "stack trace" }, T1);
  assert.equal(blocker.evidence, "stack trace");
  assert.equal(blocker.updated, T1);
});

test("status flow open -> solution_proposed -> attempting -> resolved with full history", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  assert.equal(blocker.status, "open");
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Install the module" }, T1);
  assert.equal(blocker.status, "solution_proposed");
  recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T2);
  assert.equal(blocker.status, "attempting");
  recordActorBlockerAttempt(room, blocker, "succeeded", "owner1", T3, "installed");
  assert.equal(blocker.status, "resolved");
  assert.equal(blocker.closedAt, T3);
  assert.deepEqual(blocker.history.map(entry => entry.status), ["open", "solution_proposed", "attempting", "resolved"]);
  assert.equal(blocker.proposals[0].outcome, "succeeded");
  assert.equal(room.blockerNotices!.length, 0, "non-escalated blockers produce no notice");
});

test("illegal transitions throw", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  assert.throws(() => transitionActorBlocker(blocker, "attempting", "x", T1), /cannot move from open to attempting/);
  closeActorBlocker(room, blocker, "resolved", "owner1", T1);
  assert.throws(() => transitionActorBlocker(blocker, "open", "x", T2), /cannot move from resolved/);
  assert.throws(() => transitionActorBlocker(blocker, "dismissed", "x", T2), /cannot move from resolved/);
  assert.throws(() => proposeActorBlockerSolution(blocker, { actorId: "a", text: "late" }, T2), /already closed/);
});

test("a requiresApproval proposal cannot be attempted by the actor", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Delete the prod table", requiresApproval: true }, T1);
  assert.throws(() => recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T2), /requires user approval/);
  assert.equal(blocker.status, "solution_proposed");
  assert.equal(blocker.proposals[0].outcome, undefined);
});

test("escalation: a failed attempt escalates with proposal_failed and a notice", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Retry" }, T1);
  recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T2);
  recordActorBlockerAttempt(room, blocker, "failed", "owner1", T3, "still broken");
  assert.equal(blocker.status, "escalated");
  assert.equal(blocker.escalation!.reason, "proposal_failed");
  assert.deepEqual(blocker.history.map(entry => entry.status), ["open", "solution_proposed", "attempting", "failed", "escalated"]);
  assert.deepEqual(room.blockerNotices!.map(entry => [entry.blockerId, entry.kind]), [[blocker.id, "escalated"]]);
});

test("escalation: rejecting the proposal escalates with proposal_rejected", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Force push", requiresApproval: true }, T1);
  rejectActorBlockerProposal(room, blocker, "user", T2, "no");
  assert.equal(blocker.status, "escalated");
  assert.equal(blocker.escalation!.reason, "proposal_rejected");
  assert.equal(blocker.proposals[0].outcome, "rejected");
  assert.equal(room.blockerNotices![0].kind, "escalated");
});

test("escalation: declaring unresolvable escalates and needs a reason", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  assert.throws(() => declareActorBlockerUnresolvable(room, blocker, "owner1", T1, "  "), /reason is required/);
  assert.equal(blocker.status, "open");
  assert.equal(declareActorBlockerUnresolvable(room, blocker, "owner1", T1, "needs a human"), true);
  assert.equal(blocker.status, "escalated");
  assert.equal(blocker.escalation!.reason, "unresolvable");
  assert.equal(declareActorBlockerUnresolvable(room, blocker, "owner1", T2, "again"), false, "already escalated is a no-op");
  assert.equal(room.blockerNotices!.length, 1);
});

test("escalation: overdue open blockers escalate only after the timeout and only without a proposal", () => {
  const room = makeRoom();
  const waiting = open(room, { description: "waiting for a proposal" }).blocker;
  const proposed = open(room, { description: "has a proposal" }).blocker;
  proposeActorBlockerSolution(proposed, { actorId: "owner1", text: "Try X" }, T1);
  const timeoutMs = 10 * 60_000;
  const early = Date.parse(T0) + timeoutMs - 1;
  assert.deepEqual(escalateOverdueActorBlockers(room, early, timeoutMs), []);
  assert.equal(waiting.status, "open");
  const late = Date.parse(T0) + timeoutMs;
  const result = escalateOverdueActorBlockers(room, late, timeoutMs);
  assert.deepEqual(result.map(entry => entry.id), [waiting.id]);
  assert.equal(waiting.status, "escalated");
  assert.equal(waiting.escalation!.reason, "no_proposal_timeout");
  assert.equal(proposed.status, "solution_proposed");
  assert.deepEqual(room.blockerNotices!.map(entry => entry.kind), ["escalated"]);
  assert.deepEqual(escalateOverdueActorBlockers(room, late + 1, timeoutMs), [], "already escalated blockers are not escalated twice");
});

test("self-clearing: default for approval, rate-limit and dependency-task, never escalated by timeout", () => {
  const room = makeRoom();
  const kinds = ["approval", "rate-limit", "dependency-task"] as const;
  const blockers = kinds.map(kind => open(room, { kind, description: `wait ${kind}` }).blocker);
  assert.ok(blockers.every(blocker => blocker.selfClearing));
  assert.equal(open(room, { kind: "error", description: "boom" }).blocker.selfClearing, false);
  assert.equal(open(room, { kind: "approval", description: "explicit", selfClearing: false }).blocker.selfClearing, false);
  const result = escalateOverdueActorBlockers(room, Date.parse(T0) + 24 * 60 * 60_000);
  assert.deepEqual(result.map(entry => entry.description), ["boom", "explicit"]);
  assert.ok(blockers.every(blocker => blocker.status === "open"));
});

test("self-clearing: cannot be declared unresolvable", () => {
  const room = makeRoom();
  const { blocker } = open(room, { kind: "rate-limit", description: "usage limit" });
  assert.throws(() => declareActorBlockerUnresolvable(room, blocker, "owner1", T1, "give up"), /clears itself/);
  assert.equal(blocker.status, "open");
});

test("self-clearing: rejected or failed proposals reopen it instead of escalating", () => {
  const room = makeRoom();
  const rejected = open(room, { kind: "approval", description: "needs approval A" }).blocker;
  proposeActorBlockerSolution(rejected, { actorId: "owner1", text: "Ask again" }, T1);
  rejectActorBlockerProposal(room, rejected, "user", T2);
  assert.equal(rejected.status, "open");
  assert.equal(rejected.escalation, undefined);
  assert.deepEqual(rejected.history.map(entry => entry.status), ["open", "solution_proposed", "rejected", "open"]);

  const failed = open(room, { kind: "dependency-task", description: "wait for task B" }).blocker;
  proposeActorBlockerSolution(failed, { actorId: "owner1", text: "Poll" }, T1);
  recordActorBlockerAttempt(room, failed, "attempting", "owner1", T2);
  recordActorBlockerAttempt(room, failed, "failed", "owner1", T3);
  assert.equal(failed.status, "open");
  assert.equal(failed.escalation, undefined);
  assert.deepEqual(failed.history.map(entry => entry.status), ["open", "solution_proposed", "attempting", "failed", "open"]);
  assert.equal(room.blockerNotices!.length, 0);
});

test("self-clearing: resolveActorBlockersWhere closes it without a notice", () => {
  const room = makeRoom();
  const wait = open(room, { kind: "rate-limit", description: "usage limit" }).blocker;
  const other = open(room, { taskSessionId: "task2", kind: "rate-limit", description: "usage limit" }).blocker;
  const closed = resolveActorBlockersWhere(room, blocker => blocker.taskSessionId === "task1" && blocker.selfClearing, "system", T1, "wait ended");
  assert.deepEqual(closed.map(entry => entry.id), [wait.id]);
  assert.equal(wait.status, "resolved");
  assert.equal(other.status, "open");
  assert.equal(room.blockerNotices!.length, 0);
  assert.deepEqual(resolveActorBlockersWhere(room, blocker => blocker.taskSessionId === "task1", "system", T2, "again"), []);
});

test("withdrawal: resolving or dismissing an escalated blocker removes it from context and announces it", () => {
  const room = makeRoom();
  const a = escalated(room, "blocker A");
  const b = escalated(room, "blocker B");
  assert.equal(actorBlockerContext(room, "someone").escalatedBlockers.length, 2);
  assert.equal(closeActorBlocker(room, a, "resolved", "user", T2, "fixed by hand"), true);
  assert.deepEqual(actorBlockerContext(room, "someone").escalatedBlockers.map(entry => entry.id), [b.id]);
  assert.equal(closeActorBlocker(room, b, "dismissed", "user", T3), true);
  assert.deepEqual(actorBlockerContext(room, "someone").escalatedBlockers, []);
  const kinds = room.blockerNotices!.map(entry => `${entry.blockerId}:${entry.kind}`).sort();
  assert.deepEqual(kinds, [`${a.id}:escalated`, `${a.id}:resolved`, `${b.id}:dismissed`, `${b.id}:escalated`].sort());
  assert.ok(room.blockerNotices!.find(entry => entry.kind === "resolved")!.text.includes("fixed by hand"));
});

test("withdrawal: notices are not duplicated", () => {
  const room = makeRoom();
  const blocker = escalated(room, "blocker A");
  assert.equal(closeActorBlocker(room, blocker, "resolved", "user", T2), true);
  assert.equal(closeActorBlocker(room, blocker, "resolved", "user", T3), false);
  assert.equal(closeActorBlocker(room, blocker, "dismissed", "user", T3), false);
  escalateOverdueActorBlockers(room, Date.parse(T4) + 24 * 60 * 60_000);
  const counts = new Map<string, number>();
  for (const entry of room.blockerNotices!) counts.set(`${entry.blockerId}:${entry.kind}`, (counts.get(`${entry.blockerId}:${entry.kind}`) ?? 0) + 1);
  assert.deepEqual([...counts.values()], [1, 1]);
  assert.equal(new Set(room.blockerNotices!.map(entry => entry.id)).size, room.blockerNotices!.length);
});

test("context: escalated list is bounded and reports omitted count", () => {
  const room = makeRoom();
  for (let index = 0; index < 8; index += 1) escalated(room, `distinct escalated blocker ${index}`, `2026-01-01T00:0${index}:30.000Z`);
  assert.equal(ACTOR_BLOCKER_CONTEXT_LIMIT, 5);
  const context = actorBlockerContext(room, "anyone");
  assert.equal(context.escalatedBlockers.length, 5);
  assert.equal(context.omittedEscalatedBlockers, 3);
  assert.equal(context.escalatedBlockers[0].description, "distinct escalated blocker 7", "newest first");
  assert.equal(new Set(context.escalatedBlockers.map(entry => entry.id)).size, 5);
});

test("context: long descriptions are clipped", () => {
  const room = makeRoom();
  escalated(room, `${"very long words ".repeat(500)}`);
  const [entry] = actorBlockerContext(room, "anyone").escalatedBlockers;
  assert.ok(entry.description.length <= ACTOR_BLOCKER_TEXT_CHARS);
  assert.ok(entry.description.endsWith("…"));
});

test("context: own blockers cover only owned or executed, unescalated, non-self-clearing ones", () => {
  const room = makeRoom();
  const owned = open(room, { description: "owned open" }).blocker;
  const executed = open(room, { description: "executed open", ownerActorId: "other", executorActorId: "owner1" }).blocker;
  open(room, { description: "someone else's", ownerActorId: "other", executorActorId: "other2" });
  open(room, { description: "owned wait", kind: "approval" });
  const esc = escalated(room, "owned but escalated");
  const own = actorBlockerContext(room, "owner1");
  assert.deepEqual(own.ownBlockers.map(entry => entry.id).sort(), [owned.id, executed.id].sort());
  assert.equal(own.omittedOwnBlockers, 0);
  assert.deepEqual(own.escalatedBlockers.map(entry => entry.id), [esc.id]);
  const stranger = actorBlockerContext(room, "stranger");
  assert.deepEqual(stranger.ownBlockers, []);
  assert.deepEqual(stranger.escalatedBlockers.map(entry => entry.id), [esc.id]);
});

test("context digest is stable without change and differs on new proposals or status changes", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  const base = actorBlockerContextDigest(actorBlockerContext(room, "owner1"));
  assert.equal(actorBlockerContextDigest(actorBlockerContext(room, "owner1")), base);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "First idea" }, T1);
  const proposed = actorBlockerContextDigest(actorBlockerContext(room, "owner1"));
  assert.notEqual(proposed, base);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Second idea" }, T2);
  const second = actorBlockerContextDigest(actorBlockerContext(room, "owner1"));
  assert.notEqual(second, proposed);
  recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T3);
  const attempting = actorBlockerContextDigest(actorBlockerContext(room, "owner1"));
  assert.notEqual(attempting, second);
  recordActorBlockerAttempt(room, blocker, "failed", "owner1", T4);
  assert.notEqual(actorBlockerContextDigest(actorBlockerContext(room, "owner1")), attempting);
});

test("blocker note reports no active blockers for an empty context and embeds state otherwise", () => {
  const room = makeRoom();
  assert.match(actorBlockerNote(actorBlockerContext(room, "owner1")), /No active blockers/);
  const { blocker } = open(room);
  const note = actorBlockerNote(actorBlockerContext(room, "owner1"));
  assert.doesNotMatch(note, /No active blockers/);
  assert.ok(note.includes(blocker.id));
});

test("proposing while escalated keeps it escalated and supersedes the pending proposal", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Original plan" }, T1);
  declareActorBlockerUnresolvable(room, blocker, "owner1", T2, "stuck");
  assert.equal(blocker.status, "escalated");
  const proposal = proposeActorBlockerSolution(blocker, { actorId: "helper", text: "Alternative plan" }, T3);
  assert.equal(blocker.status, "escalated");
  assert.equal(blocker.updated, T3);
  assert.equal(blocker.proposals.length, 2);
  assert.equal(blocker.proposals[0].outcome, "failed");
  assert.match(blocker.proposals[0].outcomeNote!, /Superseded/);
  assert.equal(proposal.outcome, undefined);
  assert.equal(blocker.history.at(-1)!.status, "escalated");
  assert.equal(blocker.history.at(-1)!.by, "helper");
  assert.equal(actorBlockerContext(room, "anyone").escalatedBlockers[0].latestProposal, "Alternative plan");
});

test("pending decision: only the latest unapproved, undecided requiresApproval proposal of an active blocker", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  assert.equal(actorBlockerPendingDecision(blocker), null, "no proposal yet");
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Retry the build" }, T1);
  assert.equal(actorBlockerPendingDecision(blocker), null, "a proposal without requiresApproval needs no user decision");
  const gated = proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Rotate the prod key", requiresApproval: true }, T2);
  assert.equal(actorBlockerPendingDecision(blocker), gated);
  assert.match(actorBlockerContext(room, "owner1").ownBlockers[0].latestProposal!, /\[awaiting user approval\]$/);
  closeActorBlocker(room, blocker, "dismissed", "user", T3);
  assert.equal(actorBlockerPendingDecision(blocker), null, "a closed blocker never needs a decision");
});

test("approve records the user's approval, clears the pending decision and unlocks attempting exactly that proposal", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  const first = proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Old idea", requiresApproval: true }, T1);
  const latest = proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Grant write access", requiresApproval: true }, T2);
  assert.throws(() => recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T2), /requires user approval/);
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T3, { proposalId: first.id }), /superseded/);
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T3, { proposalId: "nope" }), /not found/);
  const before = actorBlockerContextDigest(actorBlockerContext(room, "owner1"));
  approveActorBlockerProposal(blocker, "user", T3, { proposalId: latest.id, note: "Only for staging" });
  assert.deepEqual(latest.approval, { by: "user", at: T3, note: "Only for staging" });
  assert.equal(blocker.status, "solution_proposed", "approval keeps the status until the actor acts");
  assert.equal(blocker.updated, T3);
  assert.equal(actorBlockerPendingDecision(blocker), null);
  assert.match(actorBlockerContext(room, "owner1").ownBlockers[0].latestProposal!, /\[approved by user\]$/);
  assert.notEqual(actorBlockerContextDigest(actorBlockerContext(room, "owner1")), before, "the actor is re-notified of the approval");
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T3), /already approved/);
  recordActorBlockerAttempt(room, blocker, "attempting", "owner1", T4);
  assert.equal(blocker.status, "attempting");
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T4), /already approved/);
});

test("approve refuses closed, decided and ungated proposals; reject validates the proposal ID and clears the decision", () => {
  const room = makeRoom();
  const { blocker } = open(room);
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T1), /no proposal/);
  proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Plain retry" }, T1);
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T2), /does not need user approval/);
  const gated = proposeActorBlockerSolution(blocker, { actorId: "owner1", text: "Delete cache bucket", requiresApproval: true }, T2);
  assert.throws(() => rejectActorBlockerProposal(room, blocker, "user", T3, "no", "blocker:other"), /not found/);
  rejectActorBlockerProposal(room, blocker, "user", T3, "Too risky", gated.id);
  assert.equal(actorBlockerPendingDecision(blocker), null);
  assert.equal(blocker.status, "escalated");
  assert.equal(blocker.escalation?.reason, "proposal_rejected");
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T4), /already rejected/);
  closeActorBlocker(room, blocker, "resolved", "owner1", T4);
  assert.throws(() => approveActorBlockerProposal(blocker, "user", T4), /already resolved/);
});

test("overview groups task > actor > project, counting each blocker once under its executing actor", () => {
  const room = makeRoom();
  // Root actor owns a split; its sub-actor executes task2. Each blocker counts only under its executor.
  const a = open(room, { taskSessionId: "task1", ownerActorId: "root", executorActorId: "root", description: "Root blocker" }, T0).blocker;
  const b = open(room, { taskSessionId: "task2", ownerActorId: "root", executorActorId: "sub", description: "Sub blocker" }, T1).blocker;
  const c = open(room, { taskSessionId: "task2", ownerActorId: "root", executorActorId: "sub", description: "Gated blocker" }, T1).blocker;
  open(room, { taskSessionId: "task2", ownerActorId: "root", executorActorId: "sub", kind: "approval", source: "approval", description: "Waiting" }, T1);
  declareActorBlockerUnresolvable(room, a, "root", T2, "stuck");
  proposeActorBlockerSolution(c, { actorId: "sub", text: "Needs prod", requiresApproval: true }, T3);
  closeActorBlocker(room, b, "resolved", "sub", T4);
  const overview = actorBlockerOverview(room.blockers!);
  assert.deepEqual(overview.escalated.map(blocker => blocker.id), [a.id]);
  assert.equal(overview.counts.total, 3, "self-clearing waits are left out by default");
  assert.deepEqual({ ...overview.counts }, { open: 0, proposed: 1, rejected: 0, escalated: 1, resolved: 1, total: 3, active: 2, pendingDecision: 1 });
  const root = overview.actors.find(actor => actor.actorId === "root")!;
  const sub = overview.actors.find(actor => actor.actorId === "sub")!;
  assert.equal(root.counts.total, 1, "the parent does not also count its sub-actor's blockers");
  assert.equal(root.counts.escalated, 1);
  assert.deepEqual(sub.taskSessionIds, ["task2"]);
  assert.equal(sub.counts.total, 2); assert.equal(sub.counts.pendingDecision, 1); assert.equal(sub.counts.resolved, 1);
  const task2 = overview.tasks.find(task => task.taskSessionId === "task2")!;
  assert.deepEqual(task2.blockers.map(blocker => blocker.id), [b.id, c.id], "newest first");
  assert.equal(task2.ownerActorId, "root"); assert.equal(task2.actorId, "sub");
  assert.equal(actorBlockerOverview(room.blockers!, { includeSelfClearing: true }).counts.total, 4);
});
