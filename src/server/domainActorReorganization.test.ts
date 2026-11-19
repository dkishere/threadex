import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { createDomainActorRouter } from "./domainActorRoutes";
import type { CollaborationService } from "./collaborationService";
import { SessionStore } from "./sessionStore";
import { emptyActorRoom, type ActorRoom, type ActorRunningSession, type ActorWorkItem } from "../domainActors";
import { MODEL_CATALOG, MODEL_OPTIONS } from "../modelCatalog";
import { ActorDeletionConflict, ActorHierarchyConflict, ActorMemoryConflict, DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies } from "./domainActorService";
import { parseActorReorganizationRequest } from "./domainActorReorganization";
import { actorSummary } from "./domainActorSummary";
import { createDecisionPolicy, type DecisionAudit } from "./decision/policy";
import { durableDecision } from "./decision/service";
import { fakeBackend } from "./decision/fake";
import type { DecisionRequest, DecisionResult } from "./decision/types";

const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const luna = MODEL_CATALOG.luna.id;
function work(extra: Partial<ActorWorkItem> = {}): ActorWorkItem {
  return { id: "work", roundId: "round", ownerActorId: "sakura", executorActorId: "hatsune", model: luna,
    dispatchKey: "dispatch", taskSessionId: "session", taskTurnId: "turn", status: "completed", dispatchError: null,
    created: "2020-01-01T00:00:00Z", updated: "2020-01-01T00:00:00Z", dispatched: true, dispatchLease: null,
    executionRevision: 1, executionHistory: [], assignmentRequests: [], ...extra };
}

/** Workers shaped like the tx_84280d5d review: two busy roots with sub-actors that should become roots. */
async function harness() {
  let saved = emptyActorRoom("ws");
  let running: ActorRunningSession[] = [];
  let notified = 0;
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as NonNullable<Awaited<ReturnType<ActorPersistence["getWorkspace"]>>> : null,
    getDomainActorRoom: async () => structuredClone(saved),
    changeDomainActorRoom: async (_id, mutate, options) => {
      // A throwing change persists nothing, as the PostgreSQL transaction does.
      const room = structuredClone(saved);
      const result = mutate(room, options?.actorLifecycleLock ? running : undefined);
      saved = room;
      return result;
    },
    getDomainActorRunningSessions: async () => running,
    getSessionTurn: async () => null,
    captureActorCostBaseline: async () => ({ capturedAt: "2020-01-01", usage: [] })
  };
  const store = new DomainActorStore(persistence);
  const authorizations: DecisionRequest[] = [];
  let authorization = "deny";
  const decision = (req: DecisionRequest): DecisionResult => {
    if (req.questions.some(q => q.id === "authorization")) authorizations.push(req);
    return { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
      answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
        : { kind: "choice", choice: q.id === "authorization" ? authorization : Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) };
  };
  const decisions = new Map<string, DecisionAudit>();
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async key => decisions.get(key) ?? null, save: async (key, entry) => { decisions.set(key, decisions.get(key) ?? entry); return decisions.get(key)!; }, usage: async () => {} }),
    respond: async () => ({ text: "Opinion only", claim: false, intent: "discussion" }), maintain: async ({ actor }) => actor.memory,
    startTask: async input => ({ sessionId: input.sessionId, turnId: input.turnId }),
    listProjects: async () => [{ id: "threadex", name: "Threadex" }, { id: "other", name: "Other" }],
    notify: async () => { notified++; } };
  const service = new DomainActorService(store, deps);
  for (const [id, parentActorId] of [["sakura", null], ["hatsune", "sakura"], ["anya", null], ["usagi", "anya"], ["chisato", null]] as const)
    await store.create("ws", { id, name: id, parentActorId, model: luna, memory });
  saved.actors.filter(actor => !actor.parentActorId).forEach(actor => { actor.projectIds = ["threadex"]; });
  saved.workItems.push(work(), work({ id: "anya-work", ownerActorId: "anya", executorActorId: "usagi" }));
  return { service, store, read: () => structuredClone(saved), seed: (mutate: (room: ActorRoom) => void) => mutate(saved),
    running: (sessions: ActorRunningSession[]) => { running = sessions; }, notified: () => notified,
    authorizations, authorize: (choice: "allow" | "deny") => { authorization = choice; } };
}
const reorganize = (h: Awaited<ReturnType<typeof harness>>, operations: unknown[], extra: Record<string, unknown> = {}) =>
  h.service.reorganizeActors("ws", { requestId: "reorg-1", reason: "Spread work held by busy roots", operations, ...extra });

const reviewReorganization = [
  { op: "move", actorId: "hatsune", parentActorId: null, expectedParentActorId: "sakura" },
  { op: "move", actorId: "usagi", parentActorId: null, expectedParentActorId: "anya" },
  { op: "memory", actorId: "hatsune", expectedVersion: 0, memory: { rolePrompt: "Actor collaboration only", roleSummary: "Actors" } },
  { op: "memory", actorId: "usagi", expectedVersion: 0, memory: { rolePrompt: "Manager workspace UI", roleSummary: "Workspace UI" } },
  { op: "memory", actorId: "anya", expectedVersion: 0, memory: { rolePrompt: "Composer input only" } },
  { op: "memory", actorId: "chisato", expectedVersion: 0, memory: { longTerm: "Restored knowledge" } },
  { op: "create", actor: { id: "blockers", name: "Blockers", model: luna, parentActorId: null, projectIds: ["threadex"],
    memory: { rolePrompt: "Blocker lifecycle", roleSummary: "Blockers", longTerm: "", rolling: "" } } }
];

test("a review-driven reorganization applies atomically and keeps identity, memory, work and history", async () => {
  const h = await harness();
  const before = h.read();
  const preview = await reorganize(h, reviewReorganization, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(h.read(), before, "a dry run persists nothing");
  assert.deepEqual(preview.reorganization.changes.map(change => change.actorId).sort(), ["anya", "blockers", "chisato", "hatsune", "usagi"]);

  const { reorganization } = await reorganize(h, reviewReorganization);
  const room = h.read();
  assert.equal(h.notified(), 1);
  const hatsune = room.actors.find(actor => actor.id === "hatsune")!;
  assert.deepEqual({ parent: hatsune.parentActorId, root: hatsune.rootActorId, projects: hatsune.projectIds }, { parent: null, root: "hatsune", projects: ["threadex"] });
  assert.equal(hatsune.created, before.actors.find(actor => actor.id === "hatsune")!.created);
  assert.deepEqual(hatsune.memory, { ...memory, rolePrompt: "Actor collaboration only", roleSummary: "Actors", version: 1, sourceEventIds: ["reorganization:reorg-1"] });
  assert.equal(room.actors.find(actor => actor.id === "anya")!.memory.longTerm, "Knowledge", "unnamed memory fields stay");
  assert.equal(room.actors.find(actor => actor.id === "chisato")!.memory.longTerm, "Restored knowledge");
  assert.deepEqual(room.workItems, before.workItems, "work ownership and executors never move");
  assert.deepEqual(room.reorganizations, [reorganization]);
  assert.deepEqual(reorganization.initiator, { kind: "user" });
  const change = reorganization.changes.find(entry => entry.actorId === "hatsune")!;
  assert.equal(change.before!.parentActorId, "sakura");
  assert.equal(change.after!.parentActorId, null);
  assert.equal(reorganization.changes.find(entry => entry.actorId === "blockers")!.before, null);

  // Retrying the same request is idempotent; reusing its ID for other operations is refused.
  assert.deepEqual((await reorganize(h, reviewReorganization)).reorganization, reorganization);
  assert.deepEqual(h.read(), room);
  await assert.rejects(reorganize(h, reviewReorganization.slice(0, 1)), /already used/);

  // Decision, pickup and summaries read the registry: promoted actors are root candidates in their project.
  const summary = actorSummary(room, [], new Map(), [{ id: "threadex", name: "Threadex" }]);
  assert.deepEqual(summary.groups!.find(group => group.key === "threadex")!.actorIds.sort(), ["anya", "blockers", "chisato", "hatsune", "sakura", "usagi"]);
  const round = await h.service.submit({ workspaceId: "ws", requestId: "after", userPrompt: "Who owns actor memory?", chatProjectId: "threadex" });
  assert.deepEqual(round.candidateSnapshots.map(candidate => candidate.actorId).sort(), ["anya", "blockers", "chisato", "hatsune", "sakura", "usagi"]);
  assert.deepEqual(round.actorSnapshots.filter(actor => actor.rootActorId === "sakura").map(actor => actor.id), ["sakura"], "sakura's treeActors no longer include hatsune");
});

test("a failing operation anywhere rolls the whole request back", async () => {
  const h = await harness();
  const before = h.read();
  await assert.rejects(reorganize(h, [...reviewReorganization, { op: "memory", actorId: "sakura", expectedVersion: 3, memory: { longTerm: "" } }]),
    error => error instanceof ActorMemoryConflict && /Operation 8/.test(error.message));
  await assert.rejects(reorganize(h, [{ op: "move", actorId: "hatsune", parentActorId: null, expectedParentActorId: "anya" }]), ActorHierarchyConflict);
  await assert.rejects(reorganize(h, [...reviewReorganization.slice(0, 2), { op: "update", actorId: "usagi", changes: { name: "Anya" } }]), /already exists/);
  assert.deepEqual(h.read(), before);
});

test("only the final registry must be valid, so a root with sub-actors can move after them", async () => {
  const h = await harness();
  const demoteFirst = [{ op: "move", actorId: "anya", parentActorId: "sakura", expectedParentActorId: null },
    { op: "move", actorId: "usagi", parentActorId: "chisato", expectedParentActorId: "anya" }];
  await assert.rejects(reorganize(h, [demoteFirst[0]]), /only one sub-actor level|must belong/);
  const { reorganization } = await reorganize(h, demoteFirst);
  const room = h.read();
  assert.deepEqual(room.actors.map(actor => [actor.id, actor.parentActorId, actor.rootActorId, actor.projectIds]), [
    ["sakura", null, "sakura", ["threadex"]], ["hatsune", "sakura", "sakura", undefined], ["anya", "sakura", "sakura", undefined],
    ["usagi", "chisato", "chisato", undefined], ["chisato", null, "chisato", ["threadex"]]]);
  assert.equal(reorganization.changes.length, 2);
});

test("hierarchy changes wait only for live activity; idle unfinished work keeps its owner and executor", async () => {
  const h = await harness();
  h.seed(room => { room.workItems.push(work({ id: "open", ownerActorId: "sakura", executorActorId: "hatsune", status: "started" })); });
  h.running([{ actorId: "hatsune", sessionId: "s", turnId: "t", workItemId: "open", status: "running" }]);
  const before = h.read();
  await assert.rejects(reorganize(h, reviewReorganization.slice(0, 1)), /running task/);
  assert.deepEqual(h.read(), before);
  // Profile and memory changes never wait.
  await h.service.reorganizeActors("ws", { requestId: "profile", reason: "Rename", operations: [reviewReorganization[2], { op: "update", actorId: "sakura", changes: { name: "Sakura" } }] });
  assert.equal(h.read().actors[0].name, "Sakura");

  const blocked = async (mutate: (room: ActorRoom) => void, pattern: RegExp) => {
    const saved = h.read();
    h.seed(mutate);
    await assert.rejects(h.service.reorganizeActors("ws", { requestId: "blocked", reason: "Promote", operations: [reviewReorganization[0]] }), pattern);
    h.seed(room => { Object.assign(room, structuredClone(saved)); });
  };
  h.running([]);
  await blocked(room => { room.workItems.find(item => item.id === "open")!.assignmentRequests.push({ status: "pending", executorActorId: "hatsune" } as never); }, /pending task operation/);
  await blocked(room => { room.workItems.find(item => item.id === "open")!.dispatchLease = { owner: "x", until: Date.now() + 1000 } as never; }, /pending task operation/);
  await blocked(room => { room.rounds.push({ id: "round", status: "awaiting_pickup", lease: { owner: "x", until: 1 }, actorSnapshots: [], candidateSnapshots: [],
    namedActorIds: ["hatsune"], stakeholderIds: [], replies: [], ownerActorId: null } as never); }, /active discussion/);

  const { reorganization } = await h.service.reorganizeActors("ws", { requestId: "promote", reason: "Promote", operations: [{ ...reviewReorganization[0] }] });
  assert.equal(reorganization.changes.length, 1);
  assert.deepEqual(h.read().actors.find(actor => actor.id === "hatsune")!.rootActorId, "hatsune");
  assert.deepEqual(h.read().workItems.find(item => item.id === "open"), before.workItems.find(item => item.id === "open"));
});

test("moves cannot widen project or model permissions unless the request sets them explicitly", async () => {
  const h = await harness();
  h.seed(room => { room.actors.find(actor => actor.id === "chisato")!.projectIds = ["other"]; });
  const moveToChisato = { op: "move", actorId: "hatsune", parentActorId: "chisato", expectedParentActorId: "sakura" };
  await assert.rejects(reorganize(h, [moveToChisato]), /changes hatsune's projects/);
  await assert.rejects(reorganize(h, [moveToChisato, { op: "update", actorId: "chisato", changes: { projectIds: ["unknown"] } }]), /not registered/);
  await reorganize(h, [moveToChisato, { op: "update", actorId: "chisato", changes: { projectIds: ["threadex", "other"] } }]);
  assert.equal(h.read().actors.find(actor => actor.id === "hatsune")!.rootActorId, "chisato");

  h.seed(room => { room.actors.find(actor => actor.id === "anya")!.allowedModelTiers = ["codex-luna"]; room.actors.find(actor => actor.id === "anya")!.model = luna; });
  assert.ok(MODEL_OPTIONS.length > 1);
  await assert.rejects(h.service.reorganizeActors("ws", { requestId: "models", reason: "Move", operations: [
    { op: "move", actorId: "hatsune", parentActorId: "anya", expectedParentActorId: "chisato" },
    { op: "update", actorId: "anya", changes: { projectIds: ["threadex", "other"] } }] }), /does not allow/);
  await assert.rejects(h.service.reorganizeActors("ws", { requestId: "sub-projects", reason: "Bad", operations: [
    { op: "update", actorId: "usagi", changes: { projectIds: ["threadex"] } }] }), /root actor's projects/);
});

test("archiving keeps the entry as history and requires its sub-actors to move first", async () => {
  const h = await harness();
  await assert.rejects(reorganize(h, [{ op: "archive", actorId: "anya" }]), ActorDeletionConflict);
  await reorganize(h, [{ op: "move", actorId: "usagi", parentActorId: null, expectedParentActorId: "anya" },
    { op: "archive", actorId: "anya" }]);
  const room = h.read();
  assert.equal(room.actors.some(actor => actor.id === "anya"), false);
  assert.equal(room.deletedActors?.find(actor => actor.id === "anya")?.deletedAt, room.reorganizations![0].created);
  assert.equal(room.reorganizations![0].changes.find(change => change.actorId === "anya")!.after, null);
  assert.deepEqual(room.workItems.find(item => item.id === "anya-work"), h.read().workItems.find(item => item.id === "anya-work"));
  await assert.rejects(h.service.reorganizeActors("ws", { requestId: "again", reason: "Reuse", operations: [
    { op: "create", actor: { id: "anya", name: "New", model: luna, memory } }] }), /already exists/);
});

test("signed-in HTTP reorganization commits or rolls back as one PostgreSQL transaction and survives reopening", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/actor-reorganization-route-${randomUUID()}`;
  let sessions = new SessionStore(path);
  let server: ReturnType<express.Express["listen"]> | undefined;
  const start = async () => {
    await sessions.ready();
    const store = new DomainActorStore(sessions);
    const service = new DomainActorService(store, { listProjects: async () => [{ id: "threadex", name: "Threadex" }] } as unknown as DomainActorDependencies);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
    app.use(createDomainActorRouter(service, store, sessions, {} as CollaborationService, { verify: async () => false }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    return { store, base: `http://127.0.0.1:${address.port}/default` };
  };
  const closeServer = async () => { server!.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; };
  const headers = { "Content-Type": "application/json", "x-test-user": "signed-in" };
  try {
    const first = await start();
    for (const [id, parentActorId] of [["sakura", null], ["hatsune", "sakura"], ["anya", null], ["usagi", "anya"], ["chisato", null]] as const)
      await first.store.create("default", { id, name: id, parentActorId, model: luna, memory });
    const post = (body: unknown, signedIn = true) => fetch(`${first.base}/reorganizations`, { method: "POST",
      headers: signedIn ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const actors = async () => (await (await fetch(`${first.base}/actors`, { headers })).json()).actors as Array<{ id: string; parentActorId: string | null; memory: { version: number } }>;
    const body = { requestId: "http-reorg", reason: "Spread work", operations: reviewReorganization };
    assert.equal((await post(body, false)).status, 403);
    const before = await actors();
    const failed = await post({ ...body, requestId: "http-fail", operations: [...reviewReorganization, { op: "memory", actorId: "sakura", expectedVersion: 5, memory: { longTerm: "" } }] });
    assert.equal(failed.status, 409);
    assert.deepEqual(await actors(), before, "the database keeps no part of a failed request");
    assert.equal((await post(body)).status, 200);
    const after = await actors();
    assert.deepEqual(after.filter(actor => actor.parentActorId === null).map(actor => actor.id).sort(), ["anya", "blockers", "chisato", "hatsune", "sakura", "usagi"]);
    const room = await (await fetch(`${first.base}/room`, { headers })).json();
    assert.equal("reorganizations" in room, false, "the polled room omits the audit");
    await closeServer(); await sessions.close();
    sessions = new SessionStore(path);
    const reopened = await start();
    const audit = await (await fetch(`${reopened.base}/reorganizations`, { headers })).json();
    assert.deepEqual(audit.map((record: { requestId: string }) => record.requestId), ["http-reorg"]);
    assert.deepEqual(await (await fetch(`${reopened.base}/actors`, { headers })).json().then(result => result.actors), after);
  } finally {
    if (server) await closeServer();
    await sessions.close();
  }
});

test("actor_reorganize previews freely, applies only with Decision authorization and exempts the caller's own task", async () => {
  const h = await harness();
  h.seed(room => { room.workItems.push(work({ id: "own", ownerActorId: "sakura", executorActorId: "hatsune", status: "started",
    canonicalUserMessages: ["Review actor workload"], taskSessionId: "own-session", taskTurnId: "own-turn" })); });
  h.running([{ actorId: "hatsune", sessionId: "own-session", turnId: "own-turn", workItemId: "own", status: "running" }]);
  const asActor = (body: Record<string, unknown>) => h.service.reorganizeActorsAsActor({ workspaceId: "ws", workItemId: "own", actorId: "hatsune",
    sessionId: "own-session", turnId: "own-turn", body: { requestId: "actor-reorg", reason: "User asked to promote", operations: reviewReorganization.slice(0, 1), ...body },
    priorUserPrompts: ["Earlier follow-up"], currentUserPrompt: "Promote hatsune to a root as proposed", currentTurnUserMessages: ["Mid-turn steer"] });
  const before = h.read();

  const preview = await asActor({ dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(h.authorizations.length, 0, "previews need no authorization");
  assert.deepEqual(h.read(), before);

  await assert.rejects(asActor({}), /not authorized.*nothing changed/);
  assert.deepEqual(h.read(), before);
  const state = JSON.parse(h.authorizations[0].state);
  assert.deepEqual(state.userMessages, ["Review actor workload", "Earlier follow-up", "Promote hatsune to a root as proposed", "Mid-turn steer"]);
  assert.deepEqual(state.operations, reviewReorganization.slice(0, 1));
  assert.equal(state.actor.id, "hatsune");

  h.authorize("allow");
  const { reorganization } = await asActor({ requestId: "actor-reorg-2" });
  assert.deepEqual(reorganization.initiator, { kind: "actor", actorId: "hatsune", workItemId: "own", sessionId: "own-session", turnId: "own-turn" });
  const room = h.read();
  assert.equal(room.actors.find(actor => actor.id === "hatsune")!.parentActorId, null, "the caller's own running task does not block");
  assert.deepEqual(room.workItems.find(item => item.id === "own"), before.workItems.find(item => item.id === "own"));
  const checks = h.authorizations.length;
  assert.deepEqual((await asActor({ requestId: "actor-reorg-2" })).reorganization, reorganization);
  assert.equal(h.authorizations.length, checks, "a retry returns the saved record without a new check");

  // Any other live session in an affected tree still blocks, even when authorized.
  h.running([{ actorId: "hatsune", sessionId: "own-session", turnId: "own-turn", workItemId: "own", status: "running" },
    { actorId: "sakura", sessionId: "other-session", turnId: "other-turn", workItemId: "work", status: "running" }]);
  await assert.rejects(asActor({ requestId: "actor-reorg-3", operations: [{ op: "move", actorId: "hatsune", parentActorId: "sakura", expectedParentActorId: null }] }), /running task/);
});

test("request parsing copies only known fields and rejects malformed operations", () => {
  const parsed = parseActorReorganizationRequest({ requestId: "r", reason: " Why ", extra: 1, operations: [
    { op: "update", actorId: "a", changes: { name: "A", permissions: "all" } },
    { op: "create", actor: { name: "B", model: luna, memory: { ...memory, version: 9 }, workspaceId: "other", rootActorId: "x" } }] });
  assert.deepEqual(parsed, { requestId: "r", reason: "Why", operations: [{ op: "update", actorId: "a", changes: { name: "A" } },
    { op: "create", actor: { name: "B", model: luna, parentActorId: null, memory } }] });
  for (const body of [null, { requestId: "r", reason: "x", operations: [] }, { requestId: "", reason: "x", operations: [{ op: "archive", actorId: "a" }] },
    { requestId: "r", reason: "", operations: [{ op: "archive", actorId: "a" }] }, { requestId: "r", reason: "x", operations: [{ op: "delete", actorId: "a" }] },
    { requestId: "r", reason: "x", operations: [{ op: "move", actorId: "a", parentActorId: null }] },
    { requestId: "r", reason: "x", operations: [{ op: "memory", actorId: "a", expectedVersion: 0, memory: {} }] },
    { requestId: "r", reason: "x", operations: [{ op: "update", actorId: "a", changes: {} }] }])
    assert.throws(() => parseActorReorganizationRequest(body));
});
