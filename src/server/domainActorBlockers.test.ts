import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorRoom, type CreateDomainActor } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies, type ActorTaskStart } from "./domainActorService";
import { createDecisionPolicy, type DecisionAudit } from "./decision/policy";
import { durableDecision } from "./decision/service";
import { fakeBackend } from "./decision/fake";
import type { DecisionRequest, DecisionResult } from "./decision/types";
import type { RingEvent } from "./eventRingLog";
import { boundedActorContext } from "./domainActorContext";
import type { ActorBlockerContext } from "../actorBlockers";
import { actorSummary } from "./domainActorSummary";

// Harness copied from domainActorService.test.ts (not exported there), plus a controllable clock.
const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const T0 = Date.parse("2026-10-22T22:00:00Z");
function harness(overrides: Partial<DomainActorDependencies> = {}) {
  const rooms = new Map<string, ActorRoom>();
  const clock = { t: T0 };
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as Awaited<ReturnType<ActorPersistence["getWorkspace"]>> : null,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room); room.revision++; rooms.set(id, room); return result;
    },
    captureActorCostBaseline: async () => ({ capturedAt: "2026-10-22T00:00:00Z", usage: [{ model: MODEL_CATALOG.luna.id, input_tokens: 10, model_context_window: 100_000 }] }),
    getDomainActorRunningSessions: async () => [],
    getSessionTurn: async () => null
  };
  const store = new DomainActorStore(persistence);
  const starts: ActorTaskStart[] = [];
  const saved = new Map<string, DecisionAudit>();
  const decision = (req: DecisionRequest): DecisionResult => ({ ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
    answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
      : { kind: "choice", choice: Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) });
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async key => saved.get(key) ?? null, save: async (key, entry) => { saved.set(key, saved.get(key) ?? entry); return saved.get(key)!; }, usage: async () => {} }),
    respond: async () => ({ text: "I can do this", claim: true, preparedPrompt: "Implement the requested change; preserve the existing contract and verify the result." }),
    maintain: async ({ actor }) => actor.memory, now: () => clock.t,
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, ...overrides };
  const service = new DomainActorService(store, deps);
  const create = (id: string, extra: Partial<CreateDomainActor> = {}) => service.createActor("ws", { id, name: id, model: MODEL_CATALOG.luna.id, memory, ...extra });
  return { service, store, clock, starts, create };
}
const request = { workspaceId: "ws", requestId: "request", userPrompt: "Implement this", namedActorIds: ["a"] };

/** Harness with owner "a" (and optional bystander "b") and one started task. */
async function started(overrides: Partial<DomainActorDependencies> = {}) {
  const h = harness(overrides);
  await h.create("a"); await h.create("b");
  await h.service.submit(request);
  const work = (await h.service.getRoom("ws")).workItems[0];
  let n = 0;
  const iso = (offsetMs = 0) => new Date(h.clock.t + offsetMs).toISOString();
  const emit = (type: string, payload: unknown = {}, timestamp = iso(), turnId: string | null = work.taskTurnId) =>
    h.service.observe({ type, workspaceId: "ws", sessionId: work.taskSessionId, turnId, eventId: `e${++n}`, timestamp, payload } as Omit<RingEvent, "pos">);
  const blockers = async () => (await h.service.getRoom("ws")).blockers ?? [];
  return { ...h, work, emit, blockers, iso };
}

test("approval requested opens one self-clearing blocker, resolves, and a replayed older request never reopens it", async () => {
  const t = await started();
  await t.emit("runner.approval.requested", { approvalId: "x" }, t.iso(0));
  let blockers = await t.blockers();
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, "approval"); assert.equal(blockers[0].status, "open"); assert.equal(blockers[0].selfClearing, true);
  assert.equal(blockers[0].taskSessionId, t.work.taskSessionId);
  await t.emit("runner.approval.requested", { approvalId: "x" }, t.iso(1000));
  assert.equal((await t.blockers()).length, 1, "the same approval never opens a second blocker");
  await t.emit("runner.approval.requested", { approvalId: "y" }, t.iso(1500));
  assert.equal((await t.blockers()).length, 2, "a different approval is a different blocker");
  await t.emit("runner.approval.resolved", { approvalId: "x" }, t.iso(2000));
  blockers = await t.blockers();
  assert.equal(blockers.find(b => b.evidence === "approval x")!.status, "resolved");
  assert.equal(blockers.find(b => b.evidence === "approval y")!.status, "open");
  await t.emit("runner.approval.requested", { approvalId: "x" }, t.iso(500)); // replay with an older timestamp
  blockers = await t.blockers();
  assert.equal(blockers.length, 2);
  assert.equal(blockers.find(b => b.evidence === "approval x")!.status, "resolved", "replay is safe");
});

test("a runner error asks the owner once for a proposal and a later result resolves the blocker", async () => {
  const calls: Array<{ actorId: string; blockerId: string; request: string }> = [];
  const t = await started({ proposeBlockerSolution: async ({ actor, blocker, originalRequest }) => {
    calls.push({ actorId: actor.id, blockerId: blocker.id, request: originalRequest });
    return { proposal: "Retry with a smaller batch", requiresApproval: false };
  } });
  await t.emit("runner.error", { message: "boom" });
  await t.service.settled();
  assert.equal(calls.length, 1); assert.equal(calls[0].actorId, "a"); assert.equal(calls[0].request, "Implement this");
  const [blocker] = await t.blockers();
  assert.equal(blocker.kind, "error"); assert.equal(blocker.selfClearing, false);
  assert.equal(blocker.status, "solution_proposed");
  assert.equal(blocker.proposals[0].actorId, "a"); assert.equal(blocker.proposals[0].requiresApproval, false);
  await t.emit("runner.error", { message: "boom" }, t.iso(10)); // same turn and cause: no new blocker, no new proposal
  await t.service.settled();
  assert.equal(calls.length, 1); assert.equal((await t.blockers()).length, 1);
  await t.emit("runner.result", {}, t.iso(1000));
  assert.equal((await t.blockers())[0].status, "resolved");
});

test("an unresolvable owner escalates to every actor until the user resolves it", async () => {
  const t = await started({ proposeBlockerSolution: async () => ({ unresolvable: "Needs a production credential" }) });
  await t.emit("runner.error", { message: "403 forbidden" });
  await t.service.settled();
  const [blocker] = await t.blockers();
  assert.equal(blocker.status, "escalated"); assert.equal(blocker.escalation?.reason, "unresolvable");
  let room = await t.service.getRoom("ws");
  assert.ok(room.blockerNotices?.some(notice => notice.kind === "escalated" && notice.blockerId === blocker.id));
  const other = await t.service.blockerContext("ws", "b");
  assert.deepEqual(other.escalatedBlockers.map(entry => entry.id), [blocker.id]);
  assert.deepEqual(other.ownBlockers, []);
  const closed = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "resolve", note: "Credential added" });
  assert.equal(closed.status, "resolved");
  assert.deepEqual((await t.service.blockerContext("ws", "b")).escalatedBlockers, [], "a resolved escalation is withdrawn");
  room = await t.service.getRoom("ws");
  assert.ok(room.blockerNotices?.some(notice => notice.kind === "resolved" && notice.blockerId === blocker.id));
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "dismiss" }), /already closed/);
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "bogus" }), /Choose a blocker action/);
});

test("an overdue blocker without a proposal escalates lazily on read, but waits never do", async () => {
  const t = await started({ blockerProposalTimeoutMs: 1000, proposeBlockerSolution: () => new Promise(() => {}) });
  await t.emit("runner.error", { message: "stuck" });
  await t.emit("runner.pending", { message: "usage limit" });
  let blockers = await t.blockers();
  assert.deepEqual(blockers.map(b => b.status), ["open", "open"]);
  t.clock.t += 500;
  assert.deepEqual((await t.service.getRoom("ws")).blockers!.map(b => b.status), ["open", "open"], "not overdue yet");
  t.clock.t += 5000;
  blockers = (await t.service.getRoom("ws")).blockers!;
  const error = blockers.find(b => b.kind === "error")!, wait = blockers.find(b => b.kind === "rate-limit")!;
  assert.equal(error.status, "escalated"); assert.equal(error.escalation?.reason, "no_proposal_timeout");
  assert.equal(wait.status, "open"); assert.equal(wait.selfClearing, true, "a rate-limit wait is never escalated");
  assert.deepEqual((await t.service.blockerContext("ws", "b")).escalatedBlockers.map(e => e.id), [error.id]);
  const summaryBlockers = actorSummary(await t.service.getRoom("ws"), []).blockers;
  assert.deepEqual(summaryBlockers.map(b => [b.id, b.status]), [[error.id, "escalated"]], "the summary lists the escalated blocker, never the self-clearing wait");
  await t.emit("runner.runner.started", {}, new Date(t.clock.t).toISOString());
  assert.equal((await t.blockers()).find(b => b.kind === "rate-limit")!.status, "resolved", "the wait ends when the turn starts again");
});

test("a failing proposal helper leaves the blocker open for its deadline", async () => {
  const t = await started({ blockerProposalTimeoutMs: 1000, proposeBlockerSolution: async () => { throw new Error("helper down"); } });
  const warn = console.warn; console.warn = () => {};
  try { await t.emit("runner.error", { message: "x" }); await t.service.settled(); } finally { console.warn = warn; }
  assert.equal((await t.blockers())[0].status, "open");
  t.clock.t += 2000;
  assert.equal((await t.service.getRoom("ws")).blockers![0].escalation?.reason, "no_proposal_timeout");
});

test("reportBlocker with a proposal skips the automatic owner proposal; rejecting it escalates", async () => {
  let calls = 0;
  const t = await started({ proposeBlockerSolution: async () => { calls++; return { proposal: "unused", requiresApproval: false }; } });
  const { blocker, created } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a",
    kind: "external", description: "API key missing", proposal: "Ask ops for a key" });
  await t.service.settled();
  assert.equal(created, true); assert.equal(calls, 0);
  assert.equal(blocker.status, "solution_proposed"); assert.equal(blocker.source, "agent");
  assert.equal((await t.blockers())[0].proposals[0].text, "Ask ops for a key");
  await assert.rejects(t.service.reportBlocker({ workspaceId: "ws", sessionId: "not-a-task", actorId: "a", kind: "external", description: "x" }), /no system-owned actor binding/);
  await assert.rejects(t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "nonsense", description: "x" }), /Choose a blocker kind/);

  // A non-owner cannot touch an unescalated blocker.
  await assert.rejects(t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "b", action: "propose", text: "Try X" }), /Only the blocker's owner or executor/);
  const rejected = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "reject", note: "No" });
  assert.equal(rejected.status, "escalated"); assert.equal(rejected.escalation?.reason, "proposal_rejected");
  // Once escalated, any workspace actor may propose, but still cannot resolve it.
  const proposed = await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "b", action: "propose", text: "Use the staging key" });
  assert.equal(proposed.status, "escalated"); assert.equal(proposed.proposals.at(-1)!.actorId, "b");
  await assert.rejects(t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "b", action: "resolved" }), /Only the blocker's owner or executor/);
});

test("a proposal that requires approval cannot be attempted by the actor", async () => {
  const t = await started();
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a",
    kind: "permission", description: "Needs prod write", proposal: "Drop the table", requiresApproval: true });
  assert.equal(blocker.proposals[0].requiresApproval, true);
  await assert.rejects(t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "attempting" }), /requires user approval/);
  assert.equal((await t.blockers())[0].status, "solution_proposed");
  const safe = await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "propose", text: "Use a read replica", requiresApproval: false });
  const attempting = await t.service.updateBlocker({ workspaceId: "ws", blockerId: safe.id, actorId: "a", action: "attempting" });
  assert.equal(attempting.status, "attempting");
});

test("the user approves a pending proposal from the cross-workspace list; stale or repeated decisions are refused", async () => {
  let notified = 0;
  const t = await started({ notify: async () => { notified++; } });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a",
    kind: "permission", description: "Needs prod write", proposal: "Grant temporary write", requiresApproval: true });
  const pending = await t.service.pendingBlockerDecisions(["ws", "missing-workspace"]);
  assert.deepEqual(pending.map(item => item.id), [blocker.id]);
  assert.equal(pending[0].ownerActorName, "a");
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "approve", proposalId: "stale" }), /not found/);
  const before = notified;
  const approved = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "approve", proposalId: blocker.proposals[0].id, note: "OK for staging" });
  assert.equal(notified, before + 1, "approval notifies room listeners");
  assert.equal(approved.status, "solution_proposed");
  assert.equal(approved.proposals[0].approval?.by, "user");
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), []);
  assert.match((await t.service.blockerContext("ws", "a")).ownBlockers[0].latestProposal!, /\[approved by user\]/);
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "approve" }), /already approved/);
  const attempting = await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "attempting" });
  assert.equal(attempting.status, "attempting");
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "succeeded" });
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "approve" }), /already resolved/);
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "bogus" }), /approve, reject, resolve or dismiss/);
});

test("rejecting or cancelling clears a pending decision; rejection escalates to the workspace", async () => {
  const t = await started();
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a",
    kind: "external", description: "Vendor API down", proposal: "Switch vendor", requiresApproval: true });
  const rejected = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "reject", proposalId: blocker.proposals[0].id, note: "Too costly" });
  assert.equal(rejected.status, "escalated"); assert.equal(rejected.escalation?.reason, "proposal_rejected");
  assert.equal((await t.service.getRoom("ws")).blockerNotices?.at(-1)?.kind, "escalated");
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), []);
  assert.equal((await t.service.blockerContext("ws", "b")).escalatedBlockers[0].id, blocker.id, "every workspace actor sees the escalation");
  // Another actor proposes a gated fix while escalated; cancelling the task withdraws it from the list.
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "b", action: "propose", text: "Use the mirror", requiresApproval: true });
  assert.equal((await t.service.pendingBlockerDecisions(["ws"])).length, 1);
  await t.emit("runner.error", { message: "crashed" });
  await t.service.cancelWork("ws", t.work.id);
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), [], "a cancelled task leaves no needs-you entry");
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "approve" }), /already dismissed/);
});

test("commentary blockers open records, a same-turn solution resolves them, plain items change nothing", async () => {
  const t = await started();
  await t.emit("runner.item", { item: { type: "text" } });
  await t.emit("runner.item", { comment: { blockers: [], solutions: [] } });
  const untouched = (await t.service.getRoom("ws")).blockers;
  assert.ok(!untouched || untouched.length === 0, "items without an issue ledger never create blockers");

  await t.emit("runner.item", { comment: { blockers: [{ issueKey: 1, blocker: "Tests need a database" }] } });
  let blockers = await t.blockers();
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, "other"); assert.equal(blockers[0].source, "commentary"); assert.equal(blockers[0].description, "Tests need a database");
  assert.equal(blockers[0].selfClearing, false);
  await t.emit("runner.item", { comment: { solutions: [{ issueKey: 2, solution: "Other issue" }] } }, t.iso(10));
  assert.equal((await t.blockers())[0].status, "open", "a different issue key does not resolve it");
  await t.emit("runner.item", { comment: { solutions: [{ issueKey: 1, solution: "Started a container" }] } }, t.iso(20), "another-turn");
  assert.equal((await t.blockers())[0].status, "open", "a solution from another turn does not resolve it");
  await t.emit("runner.item", { comment: { solutions: [{ issueKey: 1, solution: "Started a container" }] } }, t.iso(30));
  blockers = await t.blockers();
  assert.equal(blockers[0].status, "resolved");
  assert.equal(blockers[0].history.at(-1)!.note, "Commentary reported a solution: Started a container");
});

test("cancelling a failed task dismisses its active blockers", async () => {
  const t = await started();
  await t.emit("runner.error", { message: "crashed" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "failed");
  assert.equal((await t.blockers())[0].status, "open");
  await t.service.cancelWork("ws", t.work.id);
  const [blocker] = await t.blockers();
  assert.equal(blocker.status, "dismissed"); assert.ok(blocker.closedAt);
  assert.deepEqual((await t.service.blockerContext("ws", "a")).ownBlockers, []);
});

test("boundedActorContext adds blockers only when the context has content", () => {
  const base = { userPrompt: "Do it", memory, runningSessions: [], modelContextWindow: null as number | null };
  const empty: ActorBlockerContext = { ownBlockers: [], omittedOwnBlockers: 0, escalatedBlockers: [], omittedEscalatedBlockers: 0 };
  assert.equal("blockers" in boundedActorContext({ ...base, modelContextWindow: 200_000, blockers: empty }), false);
  assert.equal("blockers" in boundedActorContext({ ...base, modelContextWindow: 200_000 }), false);
  const entry = { id: "b1", kind: "error" as const, status: "escalated" as const, taskSessionId: "s", ownerActorId: "a", description: "Broken", escalationReason: "unresolvable" as const, updated: "2026-10-22T22:00:00Z" };
  const context = boundedActorContext({ ...base, modelContextWindow: 200_000, blockers: { ...empty, escalatedBlockers: [entry] } });
  assert.deepEqual((context as { blockers?: ActorBlockerContext }).blockers?.escalatedBlockers, [entry]);
});
