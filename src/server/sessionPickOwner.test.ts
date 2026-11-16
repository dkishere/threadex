import assert from "node:assert/strict";
import test from "node:test";
import { actorRoundInGroupChat, emptyActorRoom, type ActorRoom, type CreateDomainActor } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies, type ActorTaskStart } from "./domainActorService";
import { createDecisionPolicy } from "./decision/policy";
import { durableDecision } from "./decision/service";
import { fakeBackend } from "./decision/fake";
import type { DecisionRequest, DecisionResult } from "./decision/types";
import { actorSessionWork } from "./actorNativeAgents";
import { PickOwnerError, pickOwnerMessage, pickOwnerRequest, pickOwnerStatus, type PickOwnerInput } from "./sessionPickOwner";

// Pick owner of an unowned session (docs/session-pick-owner.md).
const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const projects = [{ id: "web", name: "Web", roots: ["/repo"] }, { id: "ops", name: "Ops", roots: ["/ops"] }];
const session = { id: "tx_user", workspaceId: "ws", cwd: "/repo/ui", title: "Share context pool", description: "Round table about a context pool" };

function harness(respond?: DomainActorDependencies["respond"]) {
  const rooms = new Map<string, ActorRoom>();
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as Awaited<ReturnType<ActorPersistence["getWorkspace"]>> : null,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room); room.revision++; rooms.set(id, room); return result;
    },
    captureActorCostBaseline: async () => ({ capturedAt: "2026-11-03T00:00:00Z", usage: [{ model: MODEL_CATALOG.luna.id, input_tokens: 10, model_context_window: 100_000 }] }),
    getDomainActorRunningSessions: async () => [],
    getSessionTurn: async () => null
  };
  const starts: ActorTaskStart[] = [];
  const decision = (req: DecisionRequest): DecisionResult => ({ ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
    answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
      : { kind: "choice", choice: Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) });
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async () => null, save: async (_key, entry) => entry, usage: async () => {} }),
    respond: async input => respond ? respond(input) : { text: "I will take it over", claim: true, claimKind: "full", claimScope: "The whole session", preparedPrompt: "Review the session and report." },
    maintain: async ({ actor }) => actor.memory, listProjects: async () => projects.map(({ id, name }) => ({ id, name })),
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, updateTask: async () => {} };
  const service = new DomainActorService(new DomainActorStore(persistence), deps);
  const create = async (id: string, projectIds: string[] = ["web"], extra: Partial<CreateDomainActor> = {}) => {
    await service.createActor("ws", { id, name: `Name ${id}`, model: MODEL_CATALOG.luna.id, memory, ...extra });
    if (projectIds.length) await service.updateActor("ws", id, { projectIds });
  };
  const input = async (extra: Partial<PickOwnerInput> = {}): Promise<PickOwnerInput> =>
    ({ session, projects, room: await service.getRoom("ws"), model: MODEL_CATALOG.luna.id, ...extra });
  return { service, starts, create, input };
}
const rejects = (fn: () => unknown, status: number, code: string) => assert.throws(fn, (error: unknown) =>
  error instanceof PickOwnerError && error.status === status && error.code === code);

test("Pick owner needs one registered project with a permitted worker", async () => {
  const h = harness();
  assert.deepEqual(pickOwnerStatus(await h.input()), { eligible: false, reason: "project_has_no_actors", projectId: "web", projectName: "Web", actorCount: 0, pending: null });
  await h.create("other", ["ops"]);
  await h.create("claude", ["web"], { model: MODEL_CATALOG.claudeSonnet.id, allowedModels: [MODEL_CATALOG.claudeSonnet.id] });
  assert.equal(pickOwnerStatus(await h.input()).reason, "project_has_no_actors", "workers of other projects or providers do not count");
  await h.create("a");
  assert.deepEqual(pickOwnerStatus(await h.input()), { eligible: true, reason: null, projectId: "web", projectName: "Web", actorCount: 1, pending: null });
  assert.equal(pickOwnerStatus(await h.input({ session: { ...session, cwd: "/elsewhere" } })).reason, "session_project_unresolved");
  // A round table follows the group chat it was opened in, not its folder.
  assert.equal(pickOwnerStatus(await h.input({ roundtableChatProjectId: "ops" })).projectId, "ops");
  assert.equal(pickOwnerStatus(await h.input({ roundtableChatProjectId: "gone" })).reason, "session_project_unresolved");
  assert.equal(pickOwnerStatus(await h.input({ roundtableChatProjectId: null })).projectId, "web", "an Unassigned round table falls back to its folder");
  const outside = await h.input({ session: { ...session, cwd: "/elsewhere" } });
  rejects(() => pickOwnerRequest({ ...outside, body: { requestId: "r1", message: "Continue the MVP" } }), 409, "session_project_unresolved");
});

test("the request targets the project group chat and describes the session", async () => {
  const h = harness();
  const empty = await h.input();
  rejects(() => pickOwnerRequest({ ...empty, body: { requestId: "r1", message: "Continue the MVP" } }), 409, "project_has_no_actors");
  await h.create("a");
  const input = await h.input();
  rejects(() => pickOwnerRequest({ ...input, body: {} }), 400, "pick_owner_invalid");
  rejects(() => pickOwnerRequest({ ...input, body: { requestId: "bad id", message: "Continue the MVP" } }), 400, "pick_owner_invalid");
  rejects(() => pickOwnerRequest({ ...input, body: { requestId: "r1", message: "  " } }), 400, "pick_owner_invalid");
  rejects(() => pickOwnerRequest({ ...input, body: { requestId: "r1", message: "Continue", attachments: [{ name: "x.png" }] } }), 400, "pick_owner_invalid");
  rejects(() => pickOwnerRequest({ ...input, body: { requestId: "r1", message: "Continue", chatProjectId: "ops" } }), 409, "session_project_unresolved");
  const { request, binding } = pickOwnerRequest({ ...input, body: { requestId: "r1", message: "Continue the MVP", chatProjectId: "web" }, latestRequest: "Design the MVP" });
  assert.equal(request.chatProjectId, "web");
  assert.equal(request.namedActorIds, undefined);
  assert.deepEqual(request.sessionTarget, { sessionId: "tx_user", projectId: "web", model: MODEL_CATALOG.luna.id, takeover: true });
  assert.deepEqual(binding, { workspaceId: "ws", cwd: "/repo/ui", projectId: "web", source: "session" });
  assert.match(request.userPrompt, /threadex:\/\/ws\/tx_user/);
  assert.match(request.userPrompt, /Share context pool/);
  assert.match(request.userPrompt, /Design the MVP/);
  assert.ok(request.userPrompt.startsWith("Continue the MVP\n"), "the user's follow-up comes first, verbatim");
  assert.equal(request.userPrompt, pickOwnerMessage(session, "Continue the MVP", "Design the MVP"));
});

test("a repeated click is rejected while a request is pending; its own retry is accepted", async () => {
  const h = harness();
  await h.create("a");
  const input = await h.input({ inFlightRequestId: "r1" });
  assert.deepEqual(pickOwnerStatus(input).pending, { requestId: "r1", roundId: null, status: "queued" });
  assert.equal(pickOwnerStatus(input).reason, "pick_owner_pending");
  rejects(() => pickOwnerRequest({ ...input, body: { requestId: "r2", message: "Continue the MVP" } }), 409, "pick_owner_pending");
  assert.equal(pickOwnerRequest({ ...input, body: { requestId: "r1", message: "Continue the MVP" } }).request.requestId, "r1");
});

test("the claimant takes over the same session as its owner, picked from the whole group chat", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("other", ["ops"]);
  const { request, binding } = pickOwnerRequest({ ...await h.input(), body: { requestId: "r1", message: "Continue the MVP" } });
  const round = await h.service.submit(request, binding);
  const room = await h.service.getRoom("ws");
  assert.ok(actorRoundInGroupChat(round, "web"), "the round is shown in the session's project group chat");
  assert.deepEqual(round.candidateSnapshots.map(entry => entry.actorId).sort(), ["a", "b"], "every project worker is a candidate");
  const work = room.workItems.find(item => item.roundId === round.id)!;
  assert.equal(work.taskSessionId, "tx_user", "no new session is created");
  assert.equal(work.sessionTakeover, true);
  assert.equal(work.sessionScope, undefined, "the binding covers the whole session, not one turn");
  assert.equal(actorSessionWork(room, "tx_user")?.id, work.id, "later turns of the session run with the owner's binding");
  assert.equal(actorSessionWork(room, "tx_user", "any-later-turn")?.id, work.id);
  assert.deepEqual(h.starts.map(start => start.sessionId), ["tx_user"]);
  assert.equal(pickOwnerStatus(await h.input()).reason, "session_actor_bound", "an owned session no longer offers Pick owner");
  const owned = await h.input();
  rejects(() => pickOwnerRequest({ ...owned, body: { requestId: "r2", message: "Continue the MVP" } }), 409, "session_actor_bound");
});

test("when nobody claims, the session keeps no owner and can be offered again", async () => {
  const h = harness(async () => ({ text: "Busy elsewhere", claim: false, intent: "work", inRole: true }));
  await h.create("a");
  const { request, binding } = pickOwnerRequest({ ...await h.input(), body: { requestId: "r1", message: "Continue the MVP" } });
  const round = await h.service.submit(request, binding);
  assert.equal(round.status, "no_claims", round.error ?? "");
  assert.match(round.error ?? "", /No actor took over this session/);
  assert.equal(h.starts.length, 0);
  assert.equal(pickOwnerStatus(await h.input()).eligible, true);
});

test("when every worker reports the session unrelated, the group chat's usual repick ends without an owner", async () => {
  const h = harness(async () => ({ text: "Not mine", claim: false, intent: "work", inRole: false }));
  await h.create("a");
  const { request, binding } = pickOwnerRequest({ ...await h.input(), body: { requestId: "r1", message: "Continue the MVP" } });
  const round = await h.service.submit(request, binding);
  assert.equal(round.status, "routing_failed");
  assert.equal(h.starts.length, 0);
  assert.equal(pickOwnerStatus(await h.input()).eligible, true);
});

test("a takeover target names nobody and carries no task reference", async () => {
  const h = harness();
  await h.create("a");
  const target = { sessionId: "tx_user", projectId: "web", model: MODEL_CATALOG.luna.id, takeover: true as const };
  await assert.rejects(h.service.submit({ workspaceId: "ws", requestId: "x1", userPrompt: "Take it", namedActorIds: ["a"], sessionTarget: target }), /names no actor/);
  await assert.rejects(h.service.submit({ workspaceId: "ws", requestId: "x2", userPrompt: "Take it", sessionTarget: { ...target, hostWorkItemId: "w" } }), /Invalid actor session target/);
});
