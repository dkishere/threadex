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
import { actorSessionWork } from "./actorNativeAgents";
import { orderedMentionedActors, sessionActorMentionFailure, sessionActorMentionPayload, type SessionActorMentionResponse, type SessionMentionCandidatesResponse } from "../client/sessionActorMentions";
import { resolveSessionMentionScope, SessionMentionError, sessionMentionCandidates, sessionMentionProject, sessionMentionRequest, sessionMentionResult } from "./sessionActorMentions";

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

test("a session already bound to an actor task cannot take mentions", async () => {
  const h = harness();
  await h.create("a");
  await h.service.submit({ workspaceId: "ws", requestId: "group", userPrompt: "Fix it", namedActorIds: ["a"] }, binding);
  const taskSession = (await h.service.getRoom("ws")).workItems[0].taskSessionId;
  await assert.rejects(scopeOf(h.service, { id: taskSession, workspaceId: "ws", cwd: "/repo" }), (error: unknown) =>
    error instanceof SessionMentionError && error.code === "session_actor_bound");
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
