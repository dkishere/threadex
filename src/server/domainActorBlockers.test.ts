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
import { actorBlockerOverview, declareActorBlockerUnresolvable, type ActorBlockerContext } from "../actorBlockers";
import { actorSummary } from "./domainActorSummary";
import { USER_INPUT_METHOD } from "../userInputRequest";

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
  return { service, store, clock, starts, create, deps };
}
const request = { workspaceId: "ws", requestId: "request", userPrompt: "Implement this", namedActorIds: ["a"] };
const userChoice = { question: "Which conflicting version should this task retain?", reason: "Both changes are intentional; the user must choose ownership.",
  options: [{ label: "Keep local", description: "Retains the user's in-progress implementation." }, { label: "Use incoming", description: "Replaces that implementation with the incoming change." }] };

test("semantic user choice is asked in the original task once as a reminder: it cannot expire or accept an unrelated answer, and never gates repair or completion", async () => {
  const sent: Parameters<NonNullable<DomainActorDependencies["requestBlockerUserInput"]>>[0][] = [];
  const t = await started({ proposeBlockerSolution: async () => ({ needsUser: userChoice }), requestBlockerUserInput: async input => { sent.push(input); return { delivery: "delivered" }; } });
  await t.emit("runner.error", { message: "Both branches intentionally change this behavior" });
  await t.service.settled();
  let blocker = (await t.blockers())[0];
  assert.equal(blocker.status, "open"); assert.equal(blocker.assessment?.classification, "needs_user");
  assert.equal(sent.length, 1); assert.equal(sent[0].workItem.taskSessionId, t.work.taskSessionId);
  assert.match(sent[0].message, /native ask-user-input tool/); assert.match(sent[0].message, /Keep local/);
  const id = blocker.userDecision!.id;
  t.clock.t += 24 * 3600_000;
  await t.service.getRoom("ws"); await t.service.settled();
  assert.equal(sent.length, 1); assert.equal((await t.blockers())[0].status, "open");
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "propose", text: "Keep both versions until the user picks one" });
  assert.equal((await t.blockers())[0].status, "solution_proposed", "a pending question never stops repair");
  assert.equal((await t.blockers())[0].userDecision!.state, "waiting");
  await t.emit("runner.result");
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed", "a pending question never holds the task's status");
  assert.equal((await t.blockers())[0].status, "solution_proposed", "runner completion cannot resolve the underlying turn error by itself");
  await t.emit("runner.approval.requested", { approvalId: "unrelated", method: USER_INPUT_METHOD, params: { questions: [{ id: "other", header: "Other", question: "Something else?" }] } });
  await t.emit("runner.approval.resolved", { approvalId: "unrelated", method: USER_INPUT_METHOD, params: { questions: [{ id: "other", header: "Other", question: "Something else?" }] }, decision: { answers: { other: { answers: ["yes"] } } } });
  assert.equal((await t.blockers())[0].userDecision!.state, "waiting");
  const params = { questions: [{ id, header: "Conflict", question: userChoice.question, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "choice", method: USER_INPUT_METHOD, params });
  await t.emit("runner.approval.resolved", { approvalId: "choice", method: USER_INPUT_METHOD, params, decision: "cancel" });
  blocker = (await t.blockers())[0]; assert.equal(blocker.userDecision!.state, "waiting"); assert.match(blocker.userDecision!.error!, /without a valid answer/);
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed", "an unanswered question no longer holds Needs you; the turn's observed result returns");
  await t.emit("runner.approval.resolved", { approvalId: "choice", method: USER_INPUT_METHOD, params, decision: { answers: { [id]: { answers: ["Keep local"] } } } });
  blocker = (await t.blockers())[0]; assert.equal(blocker.userDecision!.state, "answered"); assert.equal(blocker.status, "solution_proposed", "an answer may choose to wait; only the task can report the underlying resolution");
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed");
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "resolved", text: "Applied the chosen local version" });
  assert.equal((await t.blockers())[0].status, "resolved");
});

test("an owner needs_user assessment does not re-ask while the original task already shows a native question", async () => {
  let asked = 0;
  const t = await started({ proposeBlockerSolution: async () => ({ needsUser: userChoice }), requestBlockerUserInput: async () => { asked++; return { delivery: "delivered" }; } });
  await t.emit("runner.runner.started");
  await t.emit("runner.approval.requested", { approvalId: "in-place", method: USER_INPUT_METHOD, params: { questions: [{ id: "0", header: "Badge", question: "Which badge?" }] } });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Unclear which badge" });
  await t.service.settled();
  const saved = (await t.blockers()).find(item => item.id === blocker.id)!;
  assert.equal(saved.assessment?.classification, "remind"); assert.equal(saved.userDecision, undefined); assert.equal(asked, 0);
  assert.match(saved.history.at(-1)!.note!, /already asking the user natively/);
  // Once that question ends, a new blocker needing a choice is asked through the owner again.
  await t.emit("runner.approval.resolved", { approvalId: "in-place", method: USER_INPUT_METHOD, decision: "cancel" });
  await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Another unclear choice" });
  await t.service.settled();
  assert.equal(asked, 1);
});

test("an approval wait that is not a native question does not suppress the owner's question", async () => {
  let asked = 0;
  const t = await started({ proposeBlockerSolution: async () => ({ needsUser: userChoice }), requestBlockerUserInput: async () => { asked++; return { delivery: "delivered" }; } });
  await t.emit("runner.runner.started");
  await t.emit("runner.approval.requested", { approvalId: "command", method: "item/commandExecution/requestApproval" });
  await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  await t.service.settled();
  assert.equal(asked, 1);
});

test("a blocker assessed as a reminder asks nothing, keeps the task status and never escalates on the proposal deadline", async () => {
  let asked = 0;
  const t = await started({ proposeBlockerSolution: async () => ({ remind: { reason: "Waiting for the catalogue task to finish; the rerun follows it." } }),
    requestBlockerUserInput: async () => { asked++; return { delivery: "delivered" }; } });
  await t.emit("runner.runner.started");
  await t.emit("runner.item", { comment: { blockers: [{ issueKey: 1, blocker: "Another task is editing the catalogue; wait for it to finish." }] } });
  await t.service.settled();
  let blocker = (await t.blockers())[0];
  assert.equal(blocker.status, "open"); assert.equal(blocker.assessment?.classification, "remind");
  assert.equal(blocker.userDecision, undefined); assert.equal(asked, 0);
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "started");
  t.clock.t += 24 * 3600_000;
  await t.service.getRoom("ws"); await t.service.settled();
  blocker = (await t.blockers())[0];
  assert.equal(blocker.status, "open", "a reminder is not overdue for a proposal"); assert.equal(blocker.escalation, undefined);
});

test("cancelled native question can be explicitly reasked with a new generation and keeps the old history", async () => {
  let sent = 0;
  const t = await started({ requestBlockerUserInput: async () => { sent++; return { delivery: "delivered" }; } });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  const update = { workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options };
  await t.service.updateBlocker(update); await t.service.settled();
  const oldId = (await t.blockers())[0].userDecision!.id;
  const params = { questions: [{ id: "0", header: "Choice", question: `${userChoice.question} ${oldId}`, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "old", method: USER_INPUT_METHOD, params });
  await t.emit("runner.approval.resolved", { approvalId: "old", method: USER_INPUT_METHOD, params, expired: true, decision: "cancel" });
  await t.service.getRoom("ws"); await t.service.settled(); assert.equal(sent, 1, "reads never reask a cancelled question");
  await t.service.updateBlocker(update); await t.service.settled();
  const current = (await t.blockers())[0]; assert.notEqual(current.userDecision!.id, oldId); assert.equal(sent, 2);
  assert.equal(current.userDecisionHistory![0].id, oldId); assert.equal(current.userDecisionHistory![0].approvalId, "old");
  await t.emit("runner.approval.resolved", { approvalId: "old", method: USER_INPUT_METHOD, params, decision: { answers: { "0": { answers: ["Keep local"] } } } });
  assert.equal((await t.blockers())[0].userDecision!.state, "waiting", "late answers cannot satisfy a newer question generation");
});

test("a decision question that ends unanswered clears the Needs-you reminder while the blocker still waits; asking again restores it without changing task status", async () => {
  const t = await started({ requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  const attention = async () => actorSummary(await t.service.getRoom("ws"), []).actors.find(actor => actor.id === "a")!.counts.attention;
  await t.emit("runner.runner.started");
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  const update = { workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options };
  await t.service.updateBlocker(update); await t.service.settled();
  assert.equal(await attention(), 1);
  const params = { questions: [{ id: "0", header: "Choice", question: `${userChoice.question} ${(await t.blockers())[0].userDecision!.id}`, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "q", method: USER_INPUT_METHOD, params });
  // The runner aborts its own question while the turn keeps running.
  await t.emit("runner.approval.resolved", { approvalId: "q", method: USER_INPUT_METHOD, params, decision: "cancel" });
  let room = await t.service.getRoom("ws");
  assert.equal(room.workItems[0].status, "started"); assert.equal(await attention(), 0);
  assert.equal(room.blockers![0].userDecision!.state, "waiting"); assert.equal(room.blockers![0].userDecision!.retryable, true, "the blocker still asks to be re-asked");
  await t.emit("runner.result");
  await t.emit("runner.approval.resolved", { approvalId: "q", method: USER_INPUT_METHOD, params, expired: true, decision: "cancel" });
  room = await t.service.getRoom("ws");
  assert.equal(room.workItems[0].status, "completed"); assert.equal(await attention(), 0);
  assert.equal(room.blockers![0].status, "open", "the expired question cannot resolve the blocker");
  await t.service.updateBlocker(update); await t.service.settled();
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed"); assert.equal(await attention(), 1);
});

test("a user's follow-up prompt answers a decision whose native question was cancelled at turn end, but not a still-open question", async () => {
  const t = await started({ requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Restart needs approval" });
  const update = { workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options };
  await t.service.updateBlocker(update); await t.service.settled();
  const id = (await t.blockers())[0].userDecision!.id;
  const params = { questions: [{ id: "0", header: "Restart", question: `${userChoice.question} ${id}`, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "async", method: USER_INPUT_METHOD, params });
  t.clock.t += 1000;
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: t.work.taskSessionId, turnId: "user-early", message: "yes", runningTurnId: t.work.taskTurnId }), [],
    "an open native question of the still-running turn keeps waiting for its own answer");
  // An async question card is cancelled when its turn ends; the user then replies in chat.
  await t.emit("runner.approval.resolved", { approvalId: "async", method: USER_INPUT_METHOD, params, decision: "cancel" });
  await t.emit("runner.result");
  await assert.rejects(t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "attempting", text: "Restart" }), /no open proposal/,
    "only the missing proposal stops an attempt; the pending question does not");
  t.clock.t += 1000;
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: "other-session", turnId: "user-x", message: "yes restart" }), []);
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: t.work.taskSessionId, turnId: "user-reply", message: "yes restart !" }), [blocker.id]);
  const answered = (await t.blockers())[0];
  assert.equal(answered.userDecision!.state, "answered"); assert.equal(answered.userDecision!.answerTurnId, "user-reply");
  assert.equal(answered.userDecision!.retryable, undefined); assert.equal(answered.status, "open", "the task must still resolve the underlying blocker");
  assert.match(answered.history.at(-1)!.note!, /yes restart !.*no extra authorization/);
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: t.work.taskSessionId, turnId: "user-again", message: "go" }), [], "idempotent once answered");
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "resolved", text: "Restarted as the user answered" });
  assert.equal((await t.blockers())[0].status, "resolved");
});

test("a decision delivered into an ended turn that never asked natively is answered by the user's later follow-up", async () => {
  const t = await started({ requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Reseed needs approval" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  await t.service.settled();
  // Delivered and pinned to the task turn, but never asked natively and never marked retryable (tx_c5026edf).
  await t.store.change("ws", room => { const decision = room.blockers![0].userDecision!; decision.turnId = t.work.taskTurnId; decision.delivery = "delivered"; });
  assert.equal((await t.blockers())[0].userDecision!.retryable, undefined);
  t.clock.t += 1000;
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: t.work.taskSessionId, turnId: "queued-reply", message: "reseed", runningTurnId: t.work.taskTurnId }), [],
    "while its turn still runs, the question may still be asked there");
  assert.deepEqual(await t.service.observeUserFollowUp({ workspaceId: "ws", sessionId: t.work.taskSessionId, turnId: "user-reply", message: "reseed data and make a full run", runningTurnId: "user-reply" }), [blocker.id]);
  const answered = (await t.blockers())[0].userDecision!;
  assert.equal(answered.state, "answered"); assert.equal(answered.answerTurnId, "user-reply");
});

test("a decision steered into a turn that ends without asking natively clears the Needs-you reminder; other turns and unpinned decisions keep it", async () => {
  const t = await started({ requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  const attention = async () => actorSummary(await t.service.getRoom("ws"), []).actors.find(actor => actor.id === "a")!.counts.attention;
  await t.emit("runner.runner.started");
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "SSO expired" });
  const update = { workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options };
  await t.service.updateBlocker(update); await t.service.settled();
  // Delivery pins the decision to the running turn it steered.
  await t.store.change("ws", room => { room.blockers![0].userDecision!.turnId = t.work.taskTurnId; });
  assert.equal(await attention(), 1);
  await t.emit("runner.result", {}, t.iso(), "another-turn");
  assert.equal(await attention(), 1, "another turn ending cannot end this question");
  await t.emit("runner.result");
  let room = await t.service.getRoom("ws");
  assert.equal(room.workItems[0].status, "completed"); assert.equal(await attention(), 0);
  assert.equal(room.blockers![0].status, "open", "the turn's end cannot resolve the underlying blocker");
  assert.equal(room.blockers![0].userDecision!.state, "waiting"); assert.equal(room.blockers![0].userDecision!.retryable, true);
  await t.emit("runner.result");
  assert.equal(await attention(), 0, "a replayed turn end stays cleared");
  await t.service.updateBlocker(update); await t.service.settled();
  room = await t.service.getRoom("ws");
  assert.equal(room.workItems[0].status, "completed"); assert.equal(await attention(), 1, "asking again restores the Needs-you reminder");
  await t.emit("runner.result", {}, t.iso(-60_000));
  assert.equal(await attention(), 1, "a new question generation that was never pinned to a turn keeps waiting");
});

test("a live question after its turn ended keeps the task's completed status and only raises the Needs-you reminder", async () => {
  const t = await started({ requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  await t.emit("runner.runner.started");
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  await t.service.settled();
  const params = { questions: [{ id: "0", header: "Choice", question: `${userChoice.question} ${(await t.blockers())[0].userDecision!.id}`, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "q", method: USER_INPUT_METHOD, params });
  await t.emit("runner.result");
  const attention = async () => actorSummary(await t.service.getRoom("ws"), []).actors.find(actor => actor.id === "a")!.counts.attention;
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed", "a live question never holds the task's status");
  assert.equal(await attention(), 1, "a live question still raises the reminder");
  await t.emit("runner.approval.resolved", { approvalId: "q", method: USER_INPUT_METHOD, params, expired: true, decision: "cancel" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "completed");
  assert.equal(await attention(), 0);
});

test("native question ingress rejects another mention work, a different pinned turn, and a stale execution revision", async () => {
  const t = await started();
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  const decisionId = (await t.blockers())[0].userDecision!.id;
  const params = { questions: [{ id: decisionId, header: "Choice", question: userChoice.question, options: userChoice.options }] };
  const valid = { approvalId: "question", method: USER_INPUT_METHOD, params, decision: { answers: { [decisionId]: { answers: ["Keep local"] } } } };
  await t.store.change("ws", room => {
    const own = room.workItems[0]; own.sessionScope = "turn";
    room.workItems.push({ ...structuredClone(own), id: "other-mention", taskTurnId: "other-turn", activeTurnId: "other-turn" });
  });
  await t.emit("runner.approval.requested", valid, t.iso(), "other-turn");
  await t.emit("runner.approval.resolved", valid, t.iso(), "other-turn");
  assert.equal((await t.blockers())[0].userDecision!.approvalId, undefined);
  await t.store.change("ws", room => { room.blockers![0].userDecision!.turnId = "pinned-original-turn"; });
  await t.emit("runner.approval.requested", valid);
  assert.equal((await t.blockers())[0].userDecision!.approvalId, undefined, "a different steer pin cannot be overwritten");
  await t.store.change("ws", room => { room.blockers![0].userDecision!.turnId = t.work.taskTurnId; });
  await t.emit("runner.approval.requested", valid);
  assert.equal((await t.blockers())[0].userDecision!.approvalId, "question");
  await t.store.change("ws", room => { room.workItems[0].executionRevision++; });
  await t.emit("runner.approval.resolved", valid);
  assert.equal((await t.blockers())[0].userDecision!.state, "waiting", "an earlier execution's answer never unblocks the new one");
});

test("existing unresolvable, failed and timed-out escalations get one owner semantic reassessment", async () => {
  for (const reason of ["unresolvable", "proposal_failed", "no_proposal_timeout"] as const) {
    let assessments = 0, questions = 0;
    const t = await started();
    const result = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "error", description: "Need a choice" });
    await t.store.change("ws", room => {
      const blocker = room.blockers![0]; declareActorBlockerUnresolvable(room, blocker, "a", t.iso(), "Legacy dead end"); blocker.escalation!.reason = reason;
    });
    Object.assign(t.deps, {
      proposeBlockerSolution: async () => { assessments++; return { needsUser: userChoice }; },
      requestBlockerUserInput: async () => { questions++; return { delivery: "delivered" }; }
    });
    await t.service.getRoom("ws"); await t.service.settled();
    const blocker = (await t.blockers())[0];
    assert.equal(blocker.id, result.blocker.id); assert.equal(blocker.status, "open"); assert.equal(blocker.escalation, undefined);
    assert.ok(blocker.history.some(entry => entry.status === "escalated"), "history is retained");
    assert.deepEqual((await t.service.blockerContext("ws", "b")).escalatedBlockers, []);
    await t.service.getRoom("ws"); await t.service.settled();
    assert.equal(assessments, 1); assert.equal(questions, 1);
  }
});

test("an answered user choice is not re-asked after the proposal timeout, while a new blocker is still asked", async () => {
  let assessments = 0, questions = 0;
  const t = await started({ proposeBlockerSolution: async () => { assessments++; return { needsUser: userChoice }; },
    requestBlockerUserInput: async () => { questions++; return { delivery: "delivered" }; } });
  await t.emit("runner.error", { message: "Both branches intentionally change this behavior" }); await t.service.settled();
  const id = (await t.blockers())[0].userDecision!.id;
  const params = { questions: [{ id, header: "Conflict", question: userChoice.question, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "choice", method: USER_INPUT_METHOD, params });
  await t.emit("runner.approval.resolved", { approvalId: "choice", method: USER_INPUT_METHOD, params, decision: { answers: { [id]: { answers: ["Keep local"] } } } });
  assert.equal((await t.blockers())[0].userDecision!.state, "answered");
  for (let tick = 0; tick < 4; tick++) { t.clock.t += 31 * 60_000; await t.service.getRoom("ws"); await t.service.settled(); }
  const answered = (await t.blockers())[0];
  assert.equal(questions, 1, "the same answered decision is never delivered again"); assert.equal(assessments, 1);
  assert.equal(answered.userDecision!.id, id); assert.equal(answered.userDecision!.state, "answered");
  assert.equal(answered.status, "open", "an answered choice stays with the task instead of escalating");
  await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "design-decision", description: "A different new choice" });
  await t.service.settled();
  assert.equal(assessments, 2); assert.equal(questions, 2, "a genuinely new blocker is still asked");
});

test("an answer in the idle continuation turn is recorded even though delivery first pinned an earlier running turn", async () => {
  const t = await started({ proposeBlockerSolution: async () => ({ needsUser: userChoice }), requestBlockerUserInput: async () => ({ delivery: "delivered" }) });
  await t.emit("runner.error", { message: "Both branches intentionally change this behavior" }); await t.service.settled();
  const id = (await t.blockers())[0].userDecision!.id;
  await t.store.change("ws", room => { Object.assign(room.blockers![0].userDecision!, { turnId: "earlier-running-turn", continuationTurnId: "continuation-turn" }); });
  const params = { questions: [{ id: "0", header: "Conflict", question: `${userChoice.question} [${id}]`, options: userChoice.options }] };
  await t.emit("runner.approval.requested", { approvalId: "q", method: USER_INPUT_METHOD, params }, t.iso(), "continuation-turn");
  await t.emit("runner.approval.resolved", { approvalId: "q", method: USER_INPUT_METHOD, params, decision: { answers: { "0": { answers: ["Keep local"] } } } }, t.iso(), "continuation-turn");
  assert.equal((await t.blockers())[0].userDecision!.state, "answered");
});

test("a genuine Git-related defect retains escalation and its repair evidence", async () => {
  let questions = 0;
  const t = await started({ proposeBlockerSolution: async () => ({ unresolvable: "Git integration corrupts the saved ref; repair the ref transaction in gitService.ts, evidence: persisted ref differs after rollback; next inspect the atomic write path.", reason: "This is a reproducible transaction defect, not a user choice." }),
    requestBlockerUserInput: async () => { questions++; return { delivery: "delivered" }; } });
  await t.emit("runner.error", { message: "Git integration corrupts saved ref" }); await t.service.settled();
  const blocker = (await t.blockers())[0];
  assert.equal(blocker.status, "escalated"); assert.equal(blocker.assessment?.classification, "require_fix");
  assert.match(blocker.escalation!.note!, /gitService.ts/); assert.equal(questions, 0);
});

test("owner needs_user reclassification is idempotent, retries pending delivery and preserves uncertain receipts", async () => {
  let sends = 0;
  const t = await started({ requestBlockerUserInput: async () => { sends++; return sends === 1 ? { delivery: "pending", error: "Receipt pending" } : { delivery: "uncertain", error: "Inspect the original task before resending" }; } });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Conflict", proposal: "Review conflict" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "unresolvable", text: "Need user choice" });
  const update = { workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options };
  await t.service.updateBlocker(update); await t.service.settled();
  const decisionId = (await t.blockers())[0].userDecision!.id;
  await t.service.settled();
  await t.service.updateBlocker(update); await t.service.settled();
  await t.service.getRoom("ws"); await t.service.settled();
  assert.equal(sends, 2); assert.equal((await t.blockers())[0].userDecision!.id, decisionId);
  assert.equal((await t.blockers())[0].userDecision!.delivery, "uncertain");
  await assert.rejects(t.service.updateBlocker({ ...update, actorId: "b" }), /owner or executor/);
});

test("failed question delivery backs off across reads and service restarts without changing the room", async () => {
  let sends = 0;
  const t = await started({ requestBlockerUserInput: async () => { sends++; return { delivery: "failed", error: "Unavailable" }; } });
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Choice", proposal: "Review" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  await t.service.settled();
  const before = await t.store.getRoom("ws");
  const restarted = new DomainActorService(t.store, t.deps);
  for (let i = 0; i < 10; i++) { await restarted.getRoom("ws"); await restarted.settled(); }
  assert.equal(sends, 1);
  assert.deepEqual(await t.store.getRoom("ws"), before);
  t.clock.t += 30_000;
  await restarted.getRoom("ws"); await restarted.settled();
  assert.equal(sends, 2);
  t.clock.t += 30_000;
  await restarted.getRoom("ws"); await restarted.settled();
  assert.equal(sends, 2, "second failure waits sixty seconds");
  t.clock.t += 30_000;
  await restarted.getRoom("ws"); await restarted.settled();
  assert.equal(sends, 3);
});

test("a stale model assessment cannot ask after the execution binding or revision changes", async () => {
  for (const change of ["session", "revision"]) {
  let answer!: (value: { needsUser: typeof userChoice }) => void, sends = 0;
  const t = await started({ proposeBlockerSolution: async () => new Promise(resolve => { answer = resolve; }), requestBlockerUserInput: async () => { sends++; return { delivery: "delivered" }; } });
  await t.emit("runner.error", { message: "Need choice" });
  while (!answer) await new Promise(resolve => setImmediate(resolve));
  await t.store.change("ws", room => { if (change === "session") room.workItems[0].taskSessionId = "replacement-session"; else room.workItems[0].executionRevision++; });
  answer({ needsUser: userChoice }); await t.service.settled();
  assert.equal(sends, 0); assert.equal((await t.blockers())[0].userDecision, undefined);
  }
});

test("a decision never changes task status; dismissing one held by an older record restores its known task state but preserves real pending user waits", async () => {
  for (const original of ["assigned", "failed", "completed"] as const) {
    const t = await started({ requestBlockerUserInput: async () => ({ delivery: "failed", error: "Runner unavailable" }) });
    await t.store.change("ws", room => { room.workItems[0].status = original; });
    const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
    await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
    await t.service.settled();
    assert.equal((await t.service.getRoom("ws")).workItems[0].status, original, "asking is a reminder, not a status change");
    // Decisions recorded before reminders stopped gating still hold needs_user.
    await t.store.change("ws", room => { room.workItems[0].status = "needs_user"; });
    await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "dismiss" });
    assert.equal((await t.service.getRoom("ws")).workItems[0].status, original);
  }
  const t = await started();
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  await t.emit("runner.approval.requested", { approvalId: "still-open" });
  await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "dismiss" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "needs_user", "a real native approval still waits");
});

test("dismissing a decision held by an older record after a real runner failure restores failed rather than inventing progress", async () => {
  const t = await started();
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description: "Need choice" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  await t.emit("runner.error", { message: "Process died" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "failed", "the real failure shows while the question waits");
  await t.store.change("ws", room => { room.workItems[0].status = "needs_user"; });
  await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "dismiss" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "failed");
});

test("dismissing one of several older semantic waits keeps the held status until the last is dismissed", async () => {
  const t = await started();
  await t.store.change("ws", room => { room.workItems[0].status = "failed"; });
  const ids: string[] = [];
  for (const description of ["Choose behavior", "Choose owner"]) {
    const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "other", description }); ids.push(blocker.id);
    await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "needs_user", text: userChoice.reason, question: userChoice.question, options: userChoice.options });
  }
  await t.store.change("ws", room => { room.workItems[0].status = "needs_user"; });
  await t.service.userBlockerAction({ workspaceId: "ws", blockerId: ids[0], action: "dismiss" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "needs_user");
  await t.service.userBlockerAction({ workspaceId: "ws", blockerId: ids[1], action: "dismiss" });
  assert.equal((await t.service.getRoom("ws")).workItems[0].status, "failed");
});

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
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "dismiss" }), /already resolved/);
  assert.equal((await t.service.userBlockerAction({ workspaceId: "ws", blockerId: blocker.id, action: "resolve" })).status, "resolved", "repeating a resolve is a no-op");
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

test("reportBlocker with a proposal skips the automatic owner proposal; rejecting it only notes it", async () => {
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
  assert.equal(rejected.status, "dismissed"); assert.equal(rejected.escalation, undefined);
  await t.service.getRoom("ws"); await t.service.settled();
  assert.equal(calls, 0, "a rejection never asks the owner to reassess");
  await assert.rejects(t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "propose", text: "Try again" }), /already closed/);
});

test("a user rejection is only noted: no reassessment, question, escalation or Needs-you, history kept, replay stays dismissed", async () => {
  let assessments = 0, questions = 0;
  // The first assessment proposes a gated fix; any later one would ask the user.
  const t = await started({ proposeBlockerSolution: async () => (++assessments === 1 ? { proposal: "Retry the handoff", requiresApproval: true } : { needsUser: userChoice }),
    requestBlockerUserInput: async () => { questions++; return { delivery: "delivered" }; } });
  const event = { comment: { blockers: [{ issueKey: 1, blocker: "Retry the failed handoff?" }] } };
  const originalTimestamp = t.iso(0);
  await t.emit("runner.item", event, originalTimestamp); await t.service.settled();
  const [opened] = await t.blockers();
  assert.equal(assessments, 1); assert.equal(questions, 0); assert.equal(opened.status, "solution_proposed");
  assert.equal((await t.service.pendingBlockerDecisions(["ws"])).length, 1, "an unrejected pending proposal still needs the user");
  t.clock.t += 1000;
  const rejected = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: opened.id, action: "reject", note: "Do not retry" });
  assert.equal(rejected.status, "dismissed"); assert.equal(rejected.escalation, undefined);
  assert.equal(rejected.proposals.at(-1)!.outcome, "rejected"); assert.equal(rejected.proposals.at(-1)!.outcomeNote, "Do not retry");
  assert.deepEqual(rejected.history.slice(-2).map(entry => entry.status), ["rejected", "dismissed"]);
  assert.match(rejected.history.at(-1)!.note!, /noted without follow-up/);
  for (let tick = 0; tick < 3; tick++) { t.clock.t += 31 * 60_000; await t.service.getRoom("ws"); await t.service.settled(); }
  assert.equal(assessments, 1, "no owner reassessment after the rejection"); assert.equal(questions, 0, "no new user question");
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), [], "no Needs-you entry");
  assert.ok((await t.service.getRoom("ws")).workItems[0].status !== "needs_user");
  for (const actorId of ["a", "b"]) {
    const context = await t.service.blockerContext("ws", actorId);
    assert.deepEqual([context.ownBlockers, context.escalatedBlockers], [[], []]);
  }
  // Replaying the original commentary event never reopens the noted blocker.
  await t.emit("runner.item", event, originalTimestamp); await t.service.settled();
  const replayed = await t.blockers();
  assert.equal(replayed.length, 1); assert.equal(replayed[0].status, "dismissed"); assert.equal(assessments, 1);
});

test("escalations recorded earlier as proposal_rejected are never reassessed or shown to actors", async () => {
  let assessments = 0, questions = 0;
  const t = await started();
  await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "error", description: "Legacy rejected fix" });
  await t.store.change("ws", room => {
    const blocker = room.blockers![0]; declareActorBlockerUnresolvable(room, blocker, "a", t.iso(), "Legacy"); blocker.escalation!.reason = "proposal_rejected";
  });
  Object.assign(t.deps, {
    proposeBlockerSolution: async () => { assessments++; return { needsUser: userChoice }; },
    requestBlockerUserInput: async () => { questions++; return { delivery: "delivered" }; }
  });
  for (let tick = 0; tick < 2; tick++) { await t.service.getRoom("ws"); await t.service.settled(); }
  assert.equal(assessments, 0); assert.equal(questions, 0);
  assert.equal((await t.blockers())[0].status, "escalated", "the record is untouched for the user's cleanup");
  assert.deepEqual((await t.service.blockerContext("ws", "b")).escalatedBlockers, []);
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

test("rejecting or cancelling clears a pending decision; rejection only notes it", async () => {
  const t = await started();
  const { blocker: first } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a",
    kind: "external", description: "Vendor API outage", proposal: "Switch vendor", requiresApproval: true });
  const rejected = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: first.id, action: "reject", proposalId: first.proposals[0].id, note: "Too costly" });
  assert.equal(rejected.status, "dismissed"); assert.equal(rejected.escalation, undefined);
  assert.equal((await t.service.getRoom("ws")).blockerNotices?.length ?? 0, 0, "a rejection is not announced as an escalation");
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), []);
  const { blocker } = await t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "external", description: "Vendor API down" });
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: blocker.id, actorId: "a", action: "unresolvable", text: "Vendor outage" });
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

test("the user dismisses blockers at every status and level; dismissal is durable, idempotent and withdrawn everywhere", async () => {
  let notified = 0;
  const t = await started({ notify: async () => { notified++; } });
  const report = (description: string, extra: { proposal?: string; requiresApproval?: boolean } = {}) =>
    t.service.reportBlocker({ workspaceId: "ws", sessionId: t.work.taskSessionId, actorId: "a", kind: "external", description, ...extra }).then(result => result.blocker);
  const open = await report("Flaky upstream");
  const proposed = await report("Needs prod write", { proposal: "Grant temporary write", requiresApproval: true });
  const escalated = await report("ECONNREFUSED 127.0.0.1:5173");
  await t.service.updateBlocker({ workspaceId: "ws", blockerId: escalated.id, actorId: "a", action: "unresolvable", text: "Server is down" });
  await t.emit("runner.pending", { message: "usage limit" });
  const wait = (await t.blockers()).find(blocker => blocker.selfClearing)!;
  assert.equal((await t.service.getRoom("ws")).blockers!.find(blocker => blocker.id === escalated.id)!.status, "escalated");
  assert.equal((await t.service.pendingBlockerDecisions(["ws"])).length, 1);
  assert.equal(actorSummary(await t.service.getRoom("ws"), []).blockers.length, 3);

  for (const target of [open, proposed, escalated, wait]) {
    const before = notified;
    const dismissed = await t.service.userBlockerAction({ workspaceId: "ws", blockerId: target.id, action: "dismiss", note: "Stale" });
    assert.equal(dismissed.status, "dismissed"); assert.ok(dismissed.closedAt);
    assert.deepEqual(dismissed.history.at(-1), { status: "dismissed", at: dismissed.closedAt, by: "user", note: "Stale" });
    assert.equal(notified, before + 1, "a dismissal notifies room listeners");
    // Retrying returns the same record unchanged (the store then skips the write) and notifies nobody.
    assert.deepEqual(await t.service.userBlockerAction({ workspaceId: "ws", blockerId: target.id, action: "dismiss" }), dismissed);
    assert.deepEqual((await t.service.getRoom("ws")).blockers!.find(blocker => blocker.id === target.id), dismissed);
    assert.equal(notified, before + 1);
    await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: target.id, action: "resolve" }), /already dismissed/);
  }
  await assert.rejects(t.service.userBlockerAction({ workspaceId: "ws", blockerId: "blocker_missing", action: "dismiss" }), /Blocker not found/);

  // Every read model rebuilt from the stored room leaves the dismissed records out, while history keeps them.
  const room = await t.service.getRoom("ws");
  assert.equal(room.blockers!.length, 4);
  assert.ok(room.blockers!.every(blocker => blocker.status === "dismissed"));
  assert.ok(room.blockerNotices?.some(notice => notice.kind === "dismissed" && notice.blockerId === escalated.id), "an escalated dismissal is announced");
  for (const actorId of ["a", "b"]) assert.deepEqual(await t.service.blockerContext("ws", actorId), { ownBlockers: [], omittedOwnBlockers: 0, escalatedBlockers: [], omittedEscalatedBlockers: 0 });
  assert.deepEqual(await t.service.pendingBlockerDecisions(["ws"]), []);
  assert.deepEqual(actorSummary(room, []).blockers, []);
  const overview = actorBlockerOverview(room.blockers!, { includeSelfClearing: true });
  assert.equal(overview.counts.active, 0); assert.equal(overview.counts.escalated, 0); assert.equal(overview.counts.pendingDecision, 0);
  assert.deepEqual(overview.escalated, []);
  assert.ok(overview.actors.every(actor => actor.counts.active === 0) && overview.tasks.every(task => task.counts.active === 0));

  // A replayed signal from before the dismissal never reopens it; overdue escalation never revives it.
  await t.emit("runner.pending", { message: "usage limit" }, wait.created);
  t.clock.t += 24 * 60 * 60_000;
  assert.ok((await t.service.getRoom("ws")).blockers!.every(blocker => blocker.status === "dismissed"));
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
