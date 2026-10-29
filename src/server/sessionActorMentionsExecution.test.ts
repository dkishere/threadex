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
import type { RingEvent } from "./eventRingLog";
import { actorSessionWork } from "./actorNativeAgents";
import { actorModelHooks } from "./domainActorRunner";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";

// Execution layer of Composer @mentions: mention work runs as turns of the user's own session.
const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const target = { sessionId: "tx_user", projectId: "project", model: MODEL_CATALOG.luna.id };
const binding = { workspaceId: "ws", cwd: "/repo", projectId: "project", source: "session" as const };

function harness(overrides: Partial<DomainActorDependencies> = {}) {
  const rooms = new Map<string, ActorRoom>();
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
  const decision = (req: DecisionRequest): DecisionResult => ({ ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
    answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
      : { kind: "choice", choice: Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) });
  const saved = new Map<string, never>();
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async key => saved.get(key) ?? null, save: async (key, entry) => entry, usage: async () => {} }),
    respond: async () => ({ text: "I can do this", claim: true, preparedPrompt: "Implement the requested change and verify it." }),
    maintain: async ({ actor }) => actor.memory, listProjects: async () => [{ id: "project", name: "Project" }],
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, ...overrides };
  const service = new DomainActorService(store, deps);
  const create = async (id: string, extra: Partial<CreateDomainActor> = {}) => {
    await service.createActor("ws", { id, name: id, model: MODEL_CATALOG.luna.id, memory, ...extra });
    // Root workers join the mentioning session's project; sub-workers inherit their root's projects.
    if (!extra.parentActorId) await service.updateActor("ws", id, { projectIds: ["project"] });
  };
  return { service, store, starts, deps, create };
}
const mention = (requestId: string, namedActorIds: string[]) => ({ workspaceId: "ws", requestId, userPrompt: "API and UI all!", namedActorIds, sessionTarget: target });
const event = (type: string, sessionId: string, turnId: string, eventId: string, timestamp = "2026-10-22T22:00:00Z"): Omit<RingEvent, "pos"> =>
  ({ type, workspaceId: "ws", sessionId, turnId, eventId, timestamp, payload: {} });
const partialReply = { text: "I can own a portion", claim: true, claimKind: "partial" as const, claimScope: "API only", preparedPrompt: "Implement the API only." };
const partialPlan = () => ({
  requirements: [{ id: "api", messageIndex: 0, start: 0, end: 7, description: "Implement API" }, { id: "ui", messageIndex: 0, start: 7, end: 15, description: "Implement UI and integration" }],
  assignments: [{ id: "api-work", actorId: "a", requirementIds: ["api"], brief: "Implement API; own the shared contract.", dependsOn: [] as string[] },
    { id: "ui-work", actorId: "b", requirementIds: ["ui"], brief: "Implement UI using a's contract.", dependsOn: [] as string[] }],
  review: { overlaps: [], conflicts: [], uncovered: [] }
});

test("a single @mention runs as one new turn of the mentioning session and binds only that turn", async () => {
  const h = harness();
  await h.create("a"); await h.create("b");
  await h.service.submit(mention("one", ["a"]), binding);
  assert.equal(h.starts.length, 1);
  const start = h.starts[0];
  assert.equal(start.sessionId, target.sessionId, "no new task session");
  assert.equal(start.workItem.sessionScope, "turn");
  assert.equal(start.workItem.executorActorId, "a");
  assert.equal(start.taskBinding?.cwd, "/repo");
  const room = await h.service.getRoom("ws");
  const work = room.workItems[0];
  assert.equal(actorSessionWork(room, target.sessionId, work.taskTurnId)?.id, work.id);
  assert.equal(actorSessionWork(room, target.sessionId, "user-turn"), undefined, "the user's own turns carry no actor binding");
  assert.equal(actorSessionWork(room, target.sessionId), undefined, "no turn, no binding");
  // An ordinary turn of the same session reports in: the mention work never records it.
  await h.service.observe(event("runner.result", target.sessionId, "user-turn", "user-done"));
  assert.equal((await h.service.getRoom("ws")).events.some(item => item.id === "task:user-done"), false);
  await h.service.observe(event("runner.runner.started", target.sessionId, work.taskTurnId, "mention-started"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "started");
  await h.service.settled();
});

test("multiple @mentions split among only the mentioned actors inside the mentioning session", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan() });
  await h.create("a"); await h.create("b"); await h.create("c");
  const round = await h.service.submit(mention("many", ["a", "b"]), binding);
  assert.deepEqual(round.stakeholderIds.sort(), ["a", "b"], "an unmentioned actor never joins");
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  assert.equal(h.starts.length, 1, "only the integration owner opens a turn; the other assignment is its native sub-agent");
  assert.equal(host.taskSessionId, target.sessionId); assert.equal(host.sessionScope, "turn");
  assert.equal(child.hostWorkItemId, host.id); assert.equal(child.taskSessionId, target.sessionId); assert.equal(child.taskTurnId, host.taskTurnId);
  assert.ok(child.nativeAgent);
  await h.service.settled();
});

test("Cancel of a failed @mention stops only its own turn, never the user's session or another mention", async () => {
  const sessionStops: string[] = [], turnStops: Array<[string, string]> = [];
  const h = harness({ stopTaskSession: async id => { sessionStops.push(id); }, stopTaskTurn: async (id, turnId) => { turnStops.push([id, turnId]); } });
  await h.create("a"); await h.create("b");
  await h.service.submit(mention("first", ["a"]), binding);
  await h.service.submit(mention("second", ["b"]), binding);
  const [first, second] = (await h.service.getRoom("ws")).workItems;
  await h.service.observe(event("runner.runner.started", target.sessionId, first.taskTurnId, "first-started"));
  await h.service.observe(event("runner.runner.started", target.sessionId, second.taskTurnId, "second-started"));
  await h.service.observe(event("runner.error", target.sessionId, first.taskTurnId, "first-failed", "2026-10-22T22:01:00Z"));
  const cancelled = await h.service.cancelWork("ws", first.id);
  assert.ok(cancelled.cancelledAt); assert.equal(cancelled.status, "failed", "the failure stays as history");
  assert.deepEqual(sessionStops, [], "the mentioning session is never stopped as a whole");
  assert.deepEqual(turnStops, [[target.sessionId, first.taskTurnId]]);
  const other = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(other.cancelledAt, undefined); assert.equal(other.status, "started", "the other mention keeps running");
  assert.equal((await h.service.cancelWork("ws", first.id)).cancelledAt, cancelled.cancelledAt, "repeating Cancel is idempotent");
  assert.deepEqual(turnStops, [[target.sessionId, first.taskTurnId], [target.sessionId, first.taskTurnId]], "and only re-attempts its own turn");
  await h.service.settled();
});

test("Cancel refuses a session @mention when no per-turn stop exists, leaving the task and session untouched", async () => {
  const sessionStops: string[] = [];
  const h = harness({ stopTaskSession: async id => { sessionStops.push(id); } });
  await h.create("a");
  await h.service.submit(mention("one", ["a"]), binding);
  const work = (await h.service.getRoom("ws")).workItems[0];
  await h.service.observe(event("runner.error", target.sessionId, work.taskTurnId, "failed"));
  await assert.rejects(h.service.cancelWork("ws", work.id), /single session turn is unavailable/);
  assert.deepEqual(sessionStops, []);
  assert.equal((await h.service.getRoom("ws")).workItems[0].cancelledAt, undefined);
  await h.service.settled();
});

test("reassigning a session @mention keeps the user's session with a new bound turn", async () => {
  const h = harness();
  await h.create("a"); await h.create("sub", { parentActorId: "a" });
  await h.service.submit(mention("one", ["a"]), binding);
  const before = (await h.service.getRoom("ws")).workItems[0];
  const after = await h.service.assign({ workspaceId: "ws", workItemId: before.id, executorActorId: "sub", requestId: "reassign" });
  assert.equal(after.taskSessionId, target.sessionId, "never moved to a new tx_ session");
  assert.notEqual(after.taskTurnId, before.taskTurnId);
  assert.equal(h.starts.at(-1)!.sessionId, target.sessionId); assert.equal(h.starts.at(-1)!.turnId, after.taskTurnId);
  const room = await h.service.getRoom("ws");
  assert.equal(actorSessionWork(room, target.sessionId, after.taskTurnId)?.executorActorId, "sub");
  assert.equal(actorSessionWork(room, target.sessionId, before.taskTurnId), undefined, "the previous executor's turn is no longer bound");
  await h.service.settled();
});

test("a native child recovery of a session @mention host binds the recovery turn in the same session", async () => {
  const updates: Array<{ sessionId: string; requestId: string }> = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan(),
    updateTask: async input => { updates.push({ sessionId: input.workItem.taskSessionId, requestId: input.requestId }); } });
  await h.create("a"); await h.create("b");
  const input = mention("many", ["a", "b"]);
  await h.service.submit(input, binding);
  let [host] = (await h.service.getRoom("ws")).workItems;
  // The host turn ends without starting the child: the child stays retryable.
  await h.service.observe(event("runner.result", target.sessionId, host.taskTurnId, "host-done", "2026-10-22T22:05:00Z"));
  let child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(child.dispatched, false);
  await new DomainActorService(h.store, h.deps).submit(input, binding);
  const room = await h.service.getRoom("ws");
  [host, child] = room.workItems;
  const recovery = child.nativeAgent!.recovery!;
  assert.deepEqual(updates.map(update => update.sessionId), [target.sessionId], "recovery queues a turn in the user's session");
  assert.equal(host.activeTurnId, recovery.turnId);
  assert.equal(actorSessionWork(room, target.sessionId, recovery.turnId)?.id, host.id, "the recovery turn keeps the host binding");
  await h.service.settled();
});

test("without a mention, actor work keeps its own task session and Cancel stops that session", async () => {
  const sessionStops: string[] = [], turnStops: string[] = [];
  const h = harness({ stopTaskSession: async id => { sessionStops.push(id); }, stopTaskTurn: async (_id, turnId) => { turnStops.push(turnId); } });
  await h.create("a");
  await h.service.submit({ workspaceId: "ws", requestId: "plain", userPrompt: "Implement this", namedActorIds: ["a"] });
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.match(work.taskSessionId, /^tx_/); assert.notEqual(work.taskSessionId, target.sessionId);
  assert.equal(work.sessionScope, undefined);
  assert.equal(actorSessionWork(await h.service.getRoom("ws"), work.taskSessionId)?.id, work.id, "an actor task session binds every turn");
  await h.service.observe(event("runner.error", work.taskSessionId, work.taskTurnId, "failed"));
  await h.service.cancelWork("ws", work.id);
  assert.deepEqual(sessionStops, [work.taskSessionId]); assert.deepEqual(turnStops, []);
  await h.service.settled();
});

// Runner adapter: a turn-scoped start never creates, retitles or re-models the user's session.
function runnerStore(session: { id: string; workspaceId: string; cwd: string } | null, approvalPolicy: string | null = "on-request") {
  const calls = { upserts: 0, prefs: 0, queued: null as Record<string, unknown> | null };
  const store = {
    getWorkspace: async () => ({ cwd: "/repo" }),
    getSession: async () => session,
    normalizeMetadata: () => ({ title: "task" }),
    upsertSession: async (input: unknown) => { calls.upserts++; return input; },
    getSessionModelPreferences: async () => { calls.prefs++; return { activeGearIndex: 0, gearProfiles: [] }; },
    setSessionModelPreferences: async () => { calls.prefs++; },
    resolveApprovalPolicy: async () => approvalPolicy,
    getSessionTurn: async () => calls.queued ? { id: "turn", sessionId: calls.queued.sessionId } : null
  } as unknown as SessionStore;
  return { store, calls };
}
const startInput = (extra: Record<string, unknown> = {}) => ({ workspaceId: "ws", sessionId: "tx_user", turnId: "turn", requestId: "request",
  userPrompt: "Do it", executor: { id: "a", name: "A", rootActorId: "a", effort: "medium" }, approvalPolicy: "never",
  taskBinding: binding, workItem: { model: MODEL_CATALOG.luna.id, preparedPrompt: "Brief", sessionScope: "turn", executionEffort: "high" },
  advisories: [], memory, ...extra }) as unknown as ActorTaskStart;

test("a turn-scoped start queues one turn in the existing session with the session's own approval policy", async () => {
  const originalFetch = globalThis.fetch;
  const { store, calls } = runnerStore({ id: "tx_user", workspaceId: "ws", cwd: "/repo" });
  globalThis.fetch = async (_url, init) => { calls.queued = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); };
  try {
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost");
    assert.deepEqual(await hooks.startTask(startInput()), { sessionId: "tx_user", turnId: "turn" });
    assert.equal(calls.upserts, 0, "the session is neither created nor retitled");
    assert.equal(calls.prefs, 0, "the session's model preferences are untouched");
    const body = calls.queued as Record<string, unknown>;
    assert.equal(body.sessionId, "tx_user"); assert.equal(body.turnId, "turn");
    assert.equal(body.model, MODEL_CATALOG.luna.id); assert.equal(body.modelReasoningEffort, "high");
    assert.equal(body.approvalPolicy, "on-request", "the session's policy wins over the round's");
    assert.equal(body.backgroundTask, true); assert.equal(body.requireIdleSession, undefined, "a busy session queues the turn behind its work");
    assert.match(String(body.developerInstructions), /You are domain actor A \(a\)/);
  } finally { globalThis.fetch = originalFetch; }
});

test("a turn-scoped start refuses a missing, foreign or moved session without queueing", async () => {
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts++; return new Response("{}", { status: 200 }); };
  try {
    for (const [session, pattern] of [[null, /no longer exists/], [{ id: "tx_user", workspaceId: "other", cwd: "/repo" }, /another workspace/],
      [{ id: "tx_user", workspaceId: "ws", cwd: "/elsewhere" }, /project changed/]] as const) {
      const { store, calls } = runnerStore(session);
      await assert.rejects(actorModelHooks(store, {} as SessionSummarizer, "http://localhost").startTask(startInput()), pattern);
      assert.equal(calls.upserts, 0); assert.equal(calls.prefs, 0);
    }
    assert.equal(posts, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("an ordinary actor task start still creates its own session and records its model", async () => {
  const originalFetch = globalThis.fetch;
  const { store, calls } = runnerStore(null, null);
  (store as unknown as { upsertSession: (input: Record<string, unknown>) => Promise<unknown> }).upsertSession = async input => { calls.upserts++; return { ...input, workspaceId: "ws" }; };
  globalThis.fetch = async (_url, init) => { calls.queued = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); };
  try {
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost");
    await hooks.startTask(startInput({ sessionId: "tx_task", workItem: { model: MODEL_CATALOG.luna.id, preparedPrompt: "Brief" } }));
    assert.equal(calls.upserts, 1); assert.equal(calls.prefs, 2);
    assert.equal((calls.queued as Record<string, unknown>).approvalPolicy, "never");
  } finally { globalThis.fetch = originalFetch; }
});
