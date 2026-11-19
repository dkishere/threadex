import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorRoom, type CreateDomainActor } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies, type ActorTaskStart } from "./domainActorService";
import { createDecisionPolicy } from "./decision/policy";
import { durableDecision } from "./decision/service";
import { fakeBackend } from "./decision/fake";
import type { DecisionRequest, DecisionResult } from "./decision/types";
import { actorSessionWork, actorSplitHostContext } from "./actorNativeAgents";
import { orderedMentionedActors, sessionActorMentionFailure, sessionActorMentionPayload, type SessionActorMentionResponse, type SessionMentionCandidatesResponse } from "../client/sessionActorMentions";
import { resolveSessionMentionScope, SessionMentionError, sessionMentionCandidates, sessionMentionComposerModel, sessionMentionProject, sessionMentionRequest, sessionMentionResult, sessionMentionUserPrompt } from "./sessionActorMentions";

// Routing and validation of Composer @mentions in an ordinary session (docs/session-actor-mentions.md).
const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const projects = [{ id: "web", name: "Web", roots: ["/repo"] }, { id: "api", name: "Api", roots: ["/repo/api"] }, { id: "ops", name: "Ops", roots: ["/ops"] }];
const binding = { workspaceId: "ws", cwd: "/repo", projectId: "web", source: "session" as const };
const target = { sessionId: "tx_user", projectId: "web", model: MODEL_CATALOG.luna.id };

function harness(respond?: DomainActorDependencies["respond"], planClaims?: DomainActorDependencies["planClaims"]) {
  const rooms = new Map<string, ActorRoom>();
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as Awaited<ReturnType<ActorPersistence["getWorkspace"]>> : null,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room); room.revision++; rooms.set(id, room); return result;
    },
    captureActorCostBaseline: async () => ({ capturedAt: "2026-10-28T00:00:00Z", usage: [{ model: MODEL_CATALOG.luna.id, input_tokens: 10, model_context_window: 100_000 }] }),
    getDomainActorRunningSessions: async () => [],
    getSessionTurn: async () => null
  };
  const purposes: string[] = [];
  const speakers: string[] = [];
  const starts: ActorTaskStart[] = [];
  const decision = (req: DecisionRequest): DecisionResult => {
    purposes.push(req.purpose);
    return { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
      answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
        // A sole partial claim always leaves a gap here, so coverage handling is exercised.
        : { kind: "choice", choice: q.id === "coverage" ? "gaps" : Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) };
  };
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async () => null, save: async (_key, entry) => entry, usage: async () => {} }),
    respond: async input => { speakers.push(input.actor.id); return respond ? respond(input) : { text: "Mine", claim: true, preparedPrompt: "Do the work and verify it." }; },
    ...(planClaims ? { planClaims } : {}),
    maintain: async ({ actor }) => actor.memory, listProjects: async () => projects.map(({ id, name }) => ({ id, name })),
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, updateTask: async () => {} };
  const service = new DomainActorService(new DomainActorStore(persistence), deps);
  const create = async (id: string, projectIds: string[] = ["web"], extra: Partial<CreateDomainActor> = {}) => {
    await service.createActor("ws", { id, name: `Name ${id}`, model: MODEL_CATALOG.luna.id, memory, ...extra });
    if (projectIds.length) await service.updateActor("ws", id, { projectIds });
  };
  return { service, purposes, speakers, starts, create };
}
test("a turn dispatched by a Composer @mention in this session counts as the user's own message", () => {
  const room = { rounds: [{ id: "r1", userPrompt: "@Maomao restore them", sessionTarget: { sessionId: "tx_s" } }, { id: "r2", userPrompt: "Actors room request" },
    { id: "r3", userPrompt: "@Kurumi check it", sessionTarget: { sessionId: "tx_s", hostWorkItemId: "bound" } }],
  workItems: [{ id: "host", roundId: "r3", taskSessionId: "tx_s", taskTurnId: "host-turn", sessionScope: "turn", allocationId: "session-host" },
    { id: "bound", roundId: "r2", taskSessionId: "tx_s", taskTurnId: "task-turn" }] } as never;
  const turn = (sourceRoundId: string, trigger = "decision-dispatch") => ({ requestMetadata: { promptOrigin: { kind: "inter-actor", trigger, sourceRoundId } } });
  assert.equal(sessionMentionUserPrompt(room, "tx_s", turn("r1")), "@Maomao restore them");
  assert.equal(sessionMentionUserPrompt(room, "tx_other", turn("r1")), undefined, "only a mention made in this session");
  assert.equal(sessionMentionUserPrompt(room, "tx_s", turn("r2")), undefined, "a round without a session target is not a mention here");
  assert.equal(sessionMentionUserPrompt(room, "tx_s", turn("r1", "handoff")), undefined, "actor-written prompts never qualify");
  assert.equal(sessionMentionUserPrompt(room, "tx_s", { id: "host-turn", requestMetadata: { backgroundTask: true } }), "@Kurumi check it",
    "an in-place mention host turn has no origin and is found by its reserved turn");
  assert.equal(sessionMentionUserPrompt(room, "tx_other", { id: "host-turn" }), undefined);
  assert.equal(sessionMentionUserPrompt(room, "tx_s", { id: "task-turn" }), undefined, "the task's own turns are not mention turns");
});

test("a mention send uses the Composer's gear, else the session's saved selection", () => {
  const saved = { model: MODEL_CATALOG.luna.id, effort: "high" };
  assert.deepEqual(sessionMentionComposerModel({ model: MODEL_CATALOG.sol.id, modelReasoningEffort: "low" }, saved), { model: MODEL_CATALOG.sol.id, effort: "low" });
  assert.deepEqual(sessionMentionComposerModel({ model: MODEL_CATALOG.sol.id }, saved), { model: MODEL_CATALOG.sol.id });
  assert.deepEqual(sessionMentionComposerModel({ model: "auto", modelReasoningEffort: "low" }, saved), saved, "Auto or an unknown model keeps the saved selection");
  assert.deepEqual(sessionMentionComposerModel(undefined, saved), saved);
});

const scopeOf = async (service: DomainActorService, session = { id: "tx_user", workspaceId: "ws", cwd: "/repo/web-ui" }) =>
  resolveSessionMentionScope({ session, projects, room: await service.getRoom("ws"), model: MODEL_CATALOG.luna.id });
const body = (mentionedActorIds: unknown, extra: Record<string, unknown> = {}) => ({ requestId: "req-1", message: "@a @b fix the API and UI", mentionedActorIds, ...extra });
const rejects = (fn: () => unknown, status: number, code: string) => assert.throws(fn, (error: unknown) =>
  error instanceof SessionMentionError && error.status === status && error.code === code);

test("the session project is the most specific registered root containing its cwd, or a clear error", () => {
  assert.equal(sessionMentionProject("/repo/api/src", projects).id, "api");
  assert.equal(sessionMentionProject("/repo", projects).id, "web");
  rejects(() => sessionMentionProject("/elsewhere", projects), 409, "session_project_unresolved");
  rejects(() => sessionMentionProject("/repository", projects), 409, "session_project_unresolved");
  rejects(() => sessionMentionProject("/shared/x", [{ id: "one", name: "One", roots: ["/shared"] }, { id: "two", name: "Two", roots: ["/shared"] }]), 409, "session_project_unresolved");
});

test("candidates are the permitted workers of the session's project only", async () => {
  const h = harness();
  await h.create("a"); await h.create("multi", ["ops", "web"]); await h.create("other", ["ops"]); await h.create("loose", []);
  await h.create("claude", ["web"], { model: MODEL_CATALOG.claudeSonnet.id, allowedModels: [MODEL_CATALOG.claudeSonnet.id] });
  await h.service.createActor("ws", { id: "a-sub", name: "Sub", model: MODEL_CATALOG.luna.id, memory, parentActorId: "a" });
  const scope = await scopeOf(h.service);
  assert.equal(scope.project.id, "web");
  assert.deepEqual(sessionMentionCandidates(scope).map(actor => actor.id).sort(), ["a", "a-sub", "multi"]);
});

test("invalid mentions fail with a clear error and never fall back", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("other", ["ops"]); await h.create("loose", []);
  await h.create("claude", ["web"], { model: MODEL_CATALOG.claudeSonnet.id, allowedModels: [MODEL_CATALOG.claudeSonnet.id] });
  const scope = await scopeOf(h.service);
  rejects(() => sessionMentionRequest(scope, body(["ghost"])), 400, "mention_actor_not_found");
  rejects(() => sessionMentionRequest(scope, body(["a", "other"])), 400, "mention_actor_wrong_project");
  rejects(() => sessionMentionRequest(scope, body(["loose"])), 400, "mention_actor_wrong_project");
  rejects(() => sessionMentionRequest(scope, body(["claude"])), 400, "mention_actor_not_permitted");
  rejects(() => sessionMentionRequest(scope, body([])), 400, "mention_invalid");
  rejects(() => sessionMentionRequest(scope, body(["a", "a"])), 400, "mention_invalid");
  rejects(() => sessionMentionRequest(scope, body(Array.from({ length: 9 }, (_, i) => `x${i}`))), 400, "mention_limit");
  rejects(() => sessionMentionRequest(scope, body(["a"], { attachments: [{ name: "x.png" }] })), 400, "mention_attachments_unsupported");
  rejects(() => sessionMentionRequest(scope, body(["a"], { requestId: "" })), 400, "mention_invalid");
  const error = (() => { try { sessionMentionRequest(scope, body(["a", "other"])); } catch (caught) { return caught as SessionMentionError; } })()!;
  assert.deepEqual(error.toJSON(), { error: "Name other does not belong to project Web.", code: "mention_actor_wrong_project", actorIds: ["other"] });
  const { request, binding: resolved } = sessionMentionRequest(scope, body(["b", "a"]));
  assert.deepEqual(request.namedActorIds, ["b", "a"], "appearance order is kept");
  assert.deepEqual(request.sessionTarget, { sessionId: "tx_user", projectId: "web", model: MODEL_CATALOG.luna.id });
  assert.deepEqual(resolved, { workspaceId: "ws", cwd: "/repo/web-ui", projectId: "web", source: "session" });
  rejects(() => resolveSessionMentionScope({ session: null, projects, room: scope.room, model: "" }), 404, "session_not_found");
});

test("an actor task session takes mentions of other workers; its own actor stays the host", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const scope = await scopeOf(h.service, { id: bound.taskSessionId, workspaceId: "ws", cwd: "/repo" });
  assert.deepEqual(scope.host, { workItemId: bound.id, actorId: "a" });
  assert.deepEqual(sessionMentionCandidates(scope).map(actor => actor.id), ["b"], "the session's own actor is not a candidate");
  rejects(() => sessionMentionRequest(scope, body(["a"])), 400, "mention_invalid");
  assert.equal(sessionMentionRequest(scope, body(["b"])).request.sessionTarget?.hostWorkItemId, bound.id);
});

test("a mention in an actor task session runs the mentioned actor as the session actor's native sub-agent", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const scope = await scopeOf(h.service, { id: bound.taskSessionId, workspaceId: "ws", cwd: "/repo" });
  const { request } = sessionMentionRequest(scope, body(["b"], { requestId: "in-task", message: "@b check the API" }));
  const before = { speakers: h.speakers.length, purposes: h.purposes.length };
  const round = await h.service.submit(request, binding);
  assert.equal(h.speakers.length, before.speakers, "the named actor is not asked to reply or claim");
  assert.equal(h.purposes.length, before.purposes, "no Decision runs");
  assert.equal(round.status, "awaiting_pickup");
  assert.equal(h.starts.length, 2);
  const start = h.starts[1];
  assert.equal(start.executor.id, "a", "the session's actor runs the mention turn");
  assert.equal(start.sessionId, bound.taskSessionId);
  assert.equal(start.workItem.sessionScope, "turn");
  const room = await h.service.getRoom("ws");
  const host = room.workItems.find(work => work.roundId === round.id && !work.hostWorkItemId)!;
  const child = room.workItems.find(work => work.roundId === round.id && work.hostWorkItemId)!;
  assert.equal(host.id, start.workItem.id);
  assert.equal(child.hostWorkItemId, host.id);
  assert.equal(child.executorActorId, "b");
  assert.equal(child.model, MODEL_CATALOG.luna.id);
  assert.equal(child.taskSessionId, bound.taskSessionId, "the mentioned actor never gets its own session");
  assert.equal((await h.service.submit(request, binding)).id, round.id, "a retry of the same request reuses its round");
  assert.equal(h.starts.length, 2);
  assert.equal(actorSessionWork(room, bound.taskSessionId, host.taskTurnId)?.id, host.id, "the mention turn binds its host");
  assert.equal(actorSessionWork(room, bound.taskSessionId, bound.taskTurnId)?.id, bound.id, "other turns keep the task binding");
  assert.equal(actorSessionWork(room, bound.taskSessionId)?.id, bound.id);
  assert.deepEqual(sessionMentionResult(room, round, bound.taskSessionId).turnIds, [host.taskTurnId]);
  const split = await actorSplitHostContext({ room, host, hostActor: { name: "Name a" }, turnId: host.taskTurnId, runningSessions: [],
    contextWindow: async () => 100_000, issue: async () => "token" });
  assert.match(split?.instructions ?? "", /@mention host/);
  assert.match(split?.instructions ?? "", /never actor_handoff/, "the actor context, not the message, tells the host to start them");
  const listed = JSON.parse(split!.instructions.split("Split children (system data): ")[1]).children as { workItemId: string; name: string }[];
  assert.deepEqual(listed.map(item => [item.workItemId, item.name]), [[child.id, child.nativeAgent!.name]]);
  // In place: the host turn is the user's own message, verbatim, with no server-written brief or inter-actor origin.
  assert.equal(start.userPrompt, "@b check the API");
  assert.equal(host.preparedPrompt, "", "no template brief is generated for the host turn");
  assert.equal(start.promptOrigin, undefined, "the host turn keeps the user's prompt identity");
});

test("a mention host turn runs with the session's selected effort; the mentioned sub-agent keeps its actor effort", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const scope = resolveSessionMentionScope({ session: { id: bound.taskSessionId, workspaceId: "ws", cwd: "/repo" }, projects,
    room: await h.service.getRoom("ws"), model: MODEL_CATALOG.luna.id, effort: "max" });
  const { request } = sessionMentionRequest(scope, body(["b"], { requestId: "gear", message: "@b verify it" }));
  assert.equal(request.sessionTarget?.effort, "max");
  const round = await h.service.submit(request, binding);
  const room = await h.service.getRoom("ws");
  const host = room.workItems.find(work => work.roundId === round.id && !work.hostWorkItemId)!;
  const child = room.workItems.find(work => work.roundId === round.id && work.hostWorkItemId)!;
  assert.equal(host.executionEffort, "max", "the user's session gear, not the actor's effort rule");
  assert.notEqual(child.executionEffort, "max");
});

test("a mention host hands off to its mentioned actor without an authorization judgment, and keeps it for other actors", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("c");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const scope = await scopeOf(h.service, { id: bound.taskSessionId, workspaceId: "ws", cwd: "/repo" });
  const round = await h.service.submit(sessionMentionRequest(scope, body(["b"], { requestId: "in-task", message: "@b restore the stash" })).request, binding);
  const host = (await h.service.getRoom("ws")).workItems.find(work => work.roundId === round.id && !work.hostWorkItemId)!;
  assert.equal(host.sessionScope, "turn");
  const handoff = (executorActorId: string, requestId: string) => h.service.delegateParallel({ workspaceId: "ws", workItemId: host.id, sourceActorId: "a",
    sourceSessionId: bound.taskSessionId, priorUserPrompts: ["Earlier follow-up"], requestId, kind: "handoff", tasks: [{ executorActorId, task: "Restore the stash" }] });
  // The harness Decision answers "deny" to every authorization question; a hosted handoff to the mentioned actor never asks one.
  const result = await handoff("b", "to-mentioned");
  assert.match(String(result.note), /native sub-agent of this session/, "a mention host hosts the handoff in this session");
  const room = await h.service.getRoom("ws");
  const saved = room.workItems.find(work => work.id === host.id)!.parallelRequests![0];
  assert.equal(saved.userNamedExecutors, true);
  assert.equal(saved.decision?.ok && saved.decision.answers.authorization, undefined, "no authorization question was asked");
  assert.deepEqual(saved.userMessages, ["Fix it", "Earlier follow-up", "@b restore the stash"], "oldest first: the mention is the latest message");
  const child = room.workItems.find(work => work.id === result.workItems[0].id)!;
  assert.equal(child.hostWorkItemId, host.id); assert.equal(child.taskSessionId, bound.taskSessionId);
  await assert.rejects(handoff("c", "to-other"), /Handoff was not authorized/, "an actor the user did not name still needs the request-scope judgment");
  const parallel = (executorActorId: string, requestId: string) => h.service.delegateParallel({ workspaceId: "ws", workItemId: host.id, sourceActorId: "a",
    sourceSessionId: bound.taskSessionId, requestId, tasks: [{ executorActorId, task: "Check the stash in parallel" }] });
  assert.equal((await parallel("b", "parallel-mentioned")).status, "assigned", "concurrent work for the mentioned actor needs no authorization judgment either");
  await assert.rejects(parallel("c", "parallel-other"), /Parallel delegation was not authorized/);
});

test("several mentions in an actor task session run directly as the session actor's sub-agents, without claims or allocation", async () => {
  const h = harness();
  await h.create("host"); await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["host"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const scope = await scopeOf(h.service, { id: bound.taskSessionId, workspaceId: "ws", cwd: "/repo" });
  const round = await h.service.submit(sessionMentionRequest(scope, body(["a", "b"], { requestId: "in-task-multi" })).request, binding);
  assert.deepEqual(h.speakers, ["host"], "only the earlier group round asked an actor to reply");
  assert.equal(round.allocation, undefined);
  assert.deepEqual(h.starts.slice(1).map(start => start.executor.id), ["host"], "only the session actor's turn is queued");
  const room = await h.service.getRoom("ws");
  const host = room.workItems.find(work => work.roundId === round.id && !work.hostWorkItemId)!;
  assert.equal(host.executorActorId, "host");
  assert.deepEqual(room.workItems.filter(work => work.hostWorkItemId === host.id).map(work => work.executorActorId), ["a", "b"]);
});

test("a hosted mention refuses the session's own actor and a stale host", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const bound = (await h.service.getRoom("ws")).workItems[0];
  const hosted = (requestId: string, namedActorIds: string[], hostWorkItemId = bound.id) => h.service.submit({ workspaceId: "ws", requestId, userPrompt: "@x do it", namedActorIds,
    sessionTarget: { sessionId: bound.taskSessionId, projectId: "web", model: MODEL_CATALOG.luna.id, hostWorkItemId } }, binding);
  await assert.rejects(hosted("self", ["a"]), /already runs this session/);
  await assert.rejects(hosted("stale", ["b"], "actor_work_missing"), /no longer hosts its task/);
  assert.equal(h.starts.length, 1);
});

test("a mention in a session the actor task has moved away from is refused", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const room = await h.service.getRoom("ws");
  const moved = { ...room, workItems: room.workItems.map(work => ({ ...work, taskSessionId: "tx_new", executionHistory: [{ ...work, taskSessionId: "tx_old" }] as never })) };
  await assert.rejects(Promise.resolve().then(() => resolveSessionMentionScope({ session: { id: "tx_old", workspaceId: "ws", cwd: "/repo" }, projects, room: moved, model: MODEL_CATALOG.luna.id })),
    (error: unknown) => error instanceof SessionMentionError && error.code === "session_actor_bound");
});

test("a single @mention skips picking, fixes the executor and still produces an execution brief", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "single", userPrompt: "@a fix it", namedActorIds: ["a"], sessionTarget: target }, binding);
  assert.deepEqual(h.speakers, ["a"]);
  assert.ok(!h.purposes.includes("sh_pick"), "no stakeholder picking");
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].executor.id, "a");
  assert.equal(h.starts[0].sessionId, "tx_user");
  assert.equal(h.starts[0].workItem.preparedPrompt, "Do the work and verify it.");
  const room = await h.service.getRoom("ws");
  assert.deepEqual(sessionMentionResult(room, round, "tx_user").turnIds, [h.starts[0].turnId]);
  assert.equal(round.sessionTarget?.sessionId, "tx_user");
});

test("a single @mention the actor declines reports it and runs nothing", async () => {
  const h = harness(async () => ({ text: "This is not my role.", claim: false, intent: "work", inRole: false }));
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "declined", userPrompt: "@a fix it", namedActorIds: ["a"], sessionTarget: target }, binding);
  assert.equal(round.status, "no_claims");
  assert.match(round.error ?? "", /@Name a did not take this prompt; nothing ran in this session and no other actor was added/);
  assert.deepEqual(h.speakers, ["a"]);
  assert.equal(h.starts.length, 0);
  assert.deepEqual(sessionMentionResult(await h.service.getRoom("ws"), round, "tx_user").turnIds, []);
});

test("multiple @mentions split only among the mentioned actors and report unclaimed work", async () => {
  const h = harness(async ({ actor }) => actor.id === "c"
    ? { text: "Not mine.", claim: false, intent: "work", inRole: false }
    : { text: "Part", claim: true, claimKind: "partial", claimScope: `${actor.id} part`, preparedPrompt: `Do ${actor.id}` },
  async () => ({
    requirements: [{ id: "r1", messageIndex: 0, start: 0, end: 10, description: "API" }, { id: "r2", messageIndex: 0, start: 10, end: 20, description: "UI" }],
    assignments: [{ id: "A", actorId: "a", requirementIds: ["r1"], brief: "API", dependsOn: [] }, { id: "B", actorId: "b", requirementIds: ["r2"], brief: "UI", dependsOn: [] }],
    review: { overlaps: [], conflicts: [], uncovered: ["Docs update"] }, integrationAssignmentId: "A" }));
  await h.create("a"); await h.create("b"); await h.create("c"); await h.create("bystander");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "multi", userPrompt: "@a @b @c API UI docs", namedActorIds: ["a", "b", "c"], sessionTarget: target }, binding);
  assert.deepEqual([...h.speakers].sort(), ["a", "b", "c"], "the bystander never speaks");
  assert.ok(!h.purposes.includes("sh_pick"));
  assert.deepEqual(round.candidateSnapshots.map(snapshot => snapshot.actorId), ["a", "b", "c"]);
  assert.match(round.error ?? "", /@Name c did not claim any part of this prompt/);
  assert.match(round.error ?? "", /Work no mentioned actor claimed \(not run; no other actor was added\): Docs update/);
  const room = await h.service.getRoom("ws");
  const host = room.workItems.find(work => work.allocationId === "A")!;
  const child = room.workItems.find(work => work.allocationId === "B")!;
  assert.equal(host.taskSessionId, "tx_user");
  assert.equal(host.sessionScope, "turn");
  assert.equal(child.hostWorkItemId, host.id, "the other assignment is a native sub-agent of the session's host turn");
  assert.equal(actorSessionWork(room, "tx_user", host.taskTurnId)?.id, host.id);
});

test("multiple @mentions where nobody claims stay unpicked instead of picking other actors", async () => {
  const h = harness(async () => ({ text: "Not mine.", claim: false, intent: "work", inRole: false }));
  await h.create("a"); await h.create("b"); await h.create("bystander");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "none", userPrompt: "@a @b do it", namedActorIds: ["a", "b"], sessionTarget: target }, binding);
  assert.equal(round.status, "no_claims");
  assert.deepEqual([...h.speakers].sort(), ["a", "b"]);
  assert.ok(!h.purposes.includes("sh_pick"));
  assert.equal(h.starts.length, 0);
});

test("a sole partial claim among mentions executes only its scope and reports the rest", async () => {
  const h = harness(async ({ actor }) => actor.id === "a"
    ? { text: "API only", claim: true, claimKind: "partial", claimScope: "API", preparedPrompt: "Do API" }
    : { text: "Not mine.", claim: false, intent: "work", inRole: false });
  await h.create("a"); await h.create("b"); await h.create("bystander");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "sole", userPrompt: "@a @b API and UI", namedActorIds: ["a", "b"], sessionTarget: target }, binding);
  assert.deepEqual([...h.speakers].sort(), ["a", "b"], "coverage gaps never repick other actors");
  assert.equal(round.coverageGap?.uncovered, true);
  assert.match(round.error ?? "", /remains unpicked/);
  assert.match(round.error ?? "", /@Name b did not claim/);
  assert.match(h.starts[0].workItem.preparedPrompt ?? "", /Execute ONLY your claimed scope/);
});

test("the service rejects a mention whose actor left the session's project", async () => {
  const h = harness();
  await h.create("a"); await h.create("other", ["ops"]);
  await assert.rejects(h.service.submit({ workspaceId: "ws", requestId: "x", userPrompt: "@other go", namedActorIds: ["other"], sessionTarget: target }, binding),
    /Mentioned actors must belong to this session's project/);
  await assert.rejects(h.service.submit({ workspaceId: "ws", requestId: "y", userPrompt: "@a go", namedActorIds: ["a"], sessionTarget: target,
    attachments: [{ name: "x" } as never] }, binding), /carries no task reference, attachments or reply gear/);
  assert.equal(h.speakers.length, 0);
});

test("without a mention a group round still picks among all project workers", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "fix it", chatProjectId: "web" }, binding);
  assert.ok(h.purposes.includes("sh_pick"));
  assert.equal(round.sessionTarget, undefined);
  assert.deepEqual(round.candidateSnapshots.map(snapshot => snapshot.actorId).sort(), ["a", "b"]);
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(work.sessionScope, undefined);
  assert.notEqual(work.taskSessionId, "tx_user");
});

test("the Composer payload, candidates and results match the server contract", async () => {
  const h = harness(async ({ actor }) => actor.id === "a" ? { text: "Mine", claim: true, preparedPrompt: "Do it." } : { text: "No", claim: false });
  await h.create("a"); await h.create("b");
  const scope = await scopeOf(h.service);
  const candidates: SessionMentionCandidatesResponse = { projectId: scope.project.id, projectName: scope.project.name, actors: sessionMentionCandidates(scope) };
  const mentioned = orderedMentionedActors("@Name b and @Name a, then @Name b again", candidates.actors);
  const payload = sessionActorMentionPayload("req-ui", "@Name b and @Name a, then @Name b again", mentioned);
  const { request, binding: resolved } = sessionMentionRequest(scope, JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(request.namedActorIds, ["b", "a"]);
  const round = await h.service.submit(request, resolved);
  const response: SessionActorMentionResponse = JSON.parse(JSON.stringify(sessionMentionResult(await h.service.getRoom("ws"), round, scope.sessionId)));
  assert.equal(sessionActorMentionFailure(response, candidates.actors), null);
  const declined = await h.service.submit({ ...sessionMentionRequest(scope, { ...payload, requestId: "req-ui-2", mentionedActorIds: ["b"] }).request }, resolved);
  const failed: SessionActorMentionResponse = sessionMentionResult(await h.service.getRoom("ws"), declined, scope.sessionId);
  assert.match(sessionActorMentionFailure(failed, candidates.actors) ?? "", /@Name b did not take this prompt/);
});

test("mention work cannot be continued through an actor chat task reference", async () => {
  const h = harness();
  await h.create("a");
  await h.service.submit({ workspaceId: "ws", requestId: "single", userPrompt: "@a fix", namedActorIds: ["a"], sessionTarget: target }, binding);
  const work = (await h.service.getRoom("ws")).workItems[0];
  await assert.rejects(h.service.submit({ workspaceId: "ws", requestId: "ref", userPrompt: "more", namedActorIds: ["a"], taskReference: work.id }),
    /ran as an @mention in an ordinary session/);
});
