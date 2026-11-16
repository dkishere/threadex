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
import { GroupChatPostError, groupChatPostRequest, type GroupChatPostInput } from "./sessionGroupChatPost";

// session-inspector post_group_chat: an agent posts to a group chat, which routes it as usual.
const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
const projects = [{ id: "web", name: "Web", roots: ["/repo"] }, { id: "ops", name: "Ops", roots: ["/ops"] }];
const session = { id: "tx_source", workspaceId: "ws", cwd: "/repo/ui", title: "Source task" };

function harness() {
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
  const prompts: string[] = [];
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async () => null, save: async (_key, entry) => entry, usage: async () => {} }),
    respond: async input => { prompts.push(input.round.userPrompt);
      return { text: "I will do it", claim: true, claimKind: "full", claimScope: "The whole request", preparedPrompt: "Do the work." }; },
    maintain: async ({ actor }) => actor.memory, listProjects: async () => projects.map(({ id, name }) => ({ id, name })),
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, updateTask: async () => {} };
  const service = new DomainActorService(new DomainActorStore(persistence), deps);
  const create = async (id: string, projectIds: string[] = ["web"], extra: Partial<CreateDomainActor> = {}) => {
    await service.createActor("ws", { id, name: `Name ${id}`, model: MODEL_CATALOG.luna.id, memory, ...extra });
    if (projectIds.length) await service.updateActor("ws", id, { projectIds });
  };
  const input = async (body: unknown, extra: Partial<GroupChatPostInput> = {}): Promise<GroupChatPostInput> =>
    ({ session, projects, room: await service.getRoom("ws"), body, ...extra });
  return { service, starts, create, input, prompts };
}
const rejects = (fn: () => unknown, status: number) => assert.throws(fn, (error: unknown) => error instanceof GroupChatPostError && error.status === status);

test("a post targets the session's project group chat and is labelled as agent-written", async () => {
  const h = harness();
  rejects(() => groupChatPostRequest({ session, projects, room: emptyActorRoom("ws"), body: {} }), 400);
  rejects(() => groupChatPostRequest({ session, projects, room: emptyActorRoom("ws"), body: { requestId: "bad id", message: "Hi" } }), 400);
  rejects(() => groupChatPostRequest({ session, projects, room: emptyActorRoom("ws"), body: { requestId: "p1", message: " " } }), 400);
  const unknownProject = await h.input({ requestId: "p1", message: "Hi", projectId: "gone" });
  rejects(() => groupChatPostRequest(unknownProject), 400);
  const request = groupChatPostRequest(await h.input({ requestId: "p1", message: "Review the login flow", sourceTurnId: "turn-1" }));
  assert.equal(request.chatProjectId, "web");
  assert.equal(request.namedActorIds, undefined, "the tool never names an owner");
  assert.equal(request.sessionTarget, undefined);
  assert.deepEqual(request.sessionOrigin, { sourceSessionId: "tx_source", sourceSessionTitle: "Source task", sourceTurnId: "turn-1", sideChat: false, sourceRequestId: "p1" });
  assert.ok(request.userPrompt.startsWith("Review the login flow\n"));
  assert.match(request.userPrompt, /agent-written, not the user's own words/);
  assert.match(request.userPrompt, /threadex:\/\/ws\/tx_source/);
  assert.equal(groupChatPostRequest(await h.input({ requestId: "p1", message: "Review the login flow", sourceTurnId: "turn-1" })).requestId, request.requestId, "a retry is idempotent");
  assert.notEqual(groupChatPostRequest(await h.input({ requestId: "p1", message: "Hi" }, { session: { ...session, id: "tx_other" } })).requestId, request.requestId);
  const side = groupChatPostRequest(await h.input({ requestId: "p2", message: "Hi", sideChat: true }));
  assert.equal(side.sessionOrigin?.sideChat, true);
  assert.match(side.userPrompt, /from the side chat of an existing session/);
  assert.equal(groupChatPostRequest(await h.input({ requestId: "p3", message: "Hi", projectId: "ops" })).chatProjectId, "ops");
  assert.equal(groupChatPostRequest(await h.input({ requestId: "p4", message: "Hi", projectId: null })).chatProjectId, null);
  assert.equal(groupChatPostRequest(await h.input({ requestId: "p5", message: "Hi" }, { session: { ...session, cwd: "/elsewhere" } })).chatProjectId, null,
    "a session outside every project posts to the Unassigned chat");
  assert.equal(groupChatPostRequest(await h.input({ requestId: "p6", message: "Hi" }, { roundtableChatProjectId: "ops" })).chatProjectId, "ops");
});

test("the post runs the group chat's normal claim and Decision routing into a new task", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("other", ["ops"]);
  const request = groupChatPostRequest(await h.input({ requestId: "p1", message: "Review the login flow", sideChat: true }));
  const round = await h.service.submit(request);
  assert.ok(actorRoundInGroupChat(round, "web"));
  assert.deepEqual(round.candidateSnapshots.map(entry => entry.actorId).sort(), ["a", "b"], "every project worker is a candidate");
  assert.equal(round.sessionOrigin?.sourceSessionId, "tx_source");
  // Dispatched; the round becomes assigned once the task reports started.
  assert.equal(round.status, "awaiting_pickup");
  assert.ok(round.ownerActorId);
  assert.equal(h.starts.length, 1);
  assert.notEqual(h.starts[0].sessionId, "tx_source", "the work runs in a new task, not the posting session");
  assert.match(h.prompts[0], /Review the login flow/);
});

test("a task started from an agent's post cannot post again; an ordinary actor task is named as the source", async () => {
  const h = harness();
  await h.create("a");
  const first = await h.service.submit(groupChatPostRequest(await h.input({ requestId: "p1", message: "Review the login flow" })));
  const room = await h.service.getRoom("ws");
  const child = room.workItems.find(item => item.roundId === first.id)!;
  const childSession = { ...session, id: child.taskSessionId! };
  rejects(() => groupChatPostRequest({ session: childSession, projects, room, body: { requestId: "p2", message: "Again" } }), 409);
  // A task from an ordinary group chat message may post, and its actor is recorded.
  // A fresh room: a follow-up round in the same chat may continue the previous task instead.
  const g = harness();
  await g.create("a");
  const plain = await g.service.submit({ workspaceId: "ws", requestId: "user-1", userPrompt: "Build the page", chatProjectId: "web" });
  const after = await g.service.getRoom("ws");
  const work = after.workItems.find(item => item.roundId === plain.id)!;
  const post = groupChatPostRequest({ session: { ...session, id: work.taskSessionId! }, projects, room: after, body: { requestId: "p3", message: "Need review" } });
  assert.equal(post.sessionOrigin?.sourceActorId, "a");
  assert.match(post.userPrompt, /Actor: Name a/);
});
