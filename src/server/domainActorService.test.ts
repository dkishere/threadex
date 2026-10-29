import assert from "node:assert/strict";
import test from "node:test";
import { actorPublishableConclusions, actorRoomForChat, emptyActorRoom, type ActorRoom, type ActorRound, type CreateDomainActor, type SubmitActorRequest } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore, ActorMemoryConflict, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, acceptedRoleChange, type DomainActorDependencies, type ActorTaskStart } from "./domainActorService";
import { createDecisionPolicy, type DecisionAudit } from "./decision/policy";
import { durableDecision } from "./decision/service";
import { fakeBackend } from "./decision/fake";
import { llmBackend } from "./decision/llm";
import type { DecisionRequest, DecisionResult } from "./decision/types";
import type { RingEvent } from "./eventRingLog";
import type { DiscussionJobs } from "./discussionJobs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveActorAttachments } from "./domainActorAttachments";
import { actorModelHooks } from "./domainActorRunner";
import { actorFollowupTurnId } from "./domainActorContext";
import { actorSummary } from "./domainActorSummary";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";

test("actor attachments reach responders and tasks, survive retries, and reject changed bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "actor-files-"));
  const seen: ActorRound[] = [];
  try {
    const h = harness({ saveAttachments: (ws, id, files) => saveActorAttachments(directory, ws, id, files),
      respond: async ({ round }) => { seen.push(round); assert.equal(readFileSync(round.attachments![0].path!, "utf8"), "attached requirements");
        return { text: "Implement it", claim: true, preparedPrompt: "Use the attached requirements" }; } });
    await h.create("a"); await h.create("b");
    for (const namedActorIds of [["a"], ["a", "b"]]) {
      const input = { ...request, requestId: `files-${namedActorIds.length}`, userPrompt: "", namedActorIds,
        attachments: [{ id: "file", name: "requirements.txt", type: "text/plain", size: 21, dataUrl: `data:text/plain;base64,${Buffer.from("attached requirements").toString("base64")}` }] };
      const round = await h.service.submit(input);
      assert.equal(round.attachments?.[0].dataUrl, undefined);
      assert.equal(readFileSync(h.starts.at(-1)!.attachments![0].path!, "utf8"), "attached requirements");
      const starts = h.starts.length;
      await h.service.submit(input);
      await h.service.submit({ ...input, attachments: round.attachments });
      assert.equal(h.starts.length, starts, "raw and saved-file retries do not dispatch twice");
      await assert.rejects(h.service.submit({ ...input, attachments: [{ ...input.attachments[0], dataUrl: "data:text/plain;base64,Y2hhbmdlZA==" }] }), /different input/);
    }
    assert.equal(seen.length, 3);
    await assert.rejects(h.service.submit({ ...request, requestId: "bad-upload", attachments: [{ id: "bad", name: "bad.txt", type: "text/plain", size: 1, path: "/etc/passwd" }] }), /Invalid upload/);
    assert.equal((await h.service.getRoom("ws")).rounds.length, 2, "invalid files never create a message");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const memory = { rolePrompt: "Build products", roleSummary: "Product", longTerm: "Promise", rolling: "Recent" };
const policy = { order: ["fake" as const], threshold: { fake: 0.5 } };
function harness(overrides: Partial<DomainActorDependencies> = {}) {
  const rooms = new Map<string, ActorRoom>();
  let captures = 0;
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" || id === "other" ? { id } as Awaited<ReturnType<ActorPersistence["getWorkspace"]>> : null,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room); room.revision++; rooms.set(id, room); return result;
    },
    captureActorCostBaseline: async () => { captures++; return { capturedAt: "2026-10-22T00:00:00Z", usage: [{ model: MODEL_CATALOG.luna.id, input_tokens: 10, model_context_window: 100_000 }] }; },
    getDomainActorRunningSessions: async () => [],
    getSessionTurn: async () => null
  };
  const store = new DomainActorStore(persistence);
  const starts: ActorTaskStart[] = [];
  const decisions: DecisionRequest[] = [];
  const saved = new Map<string, DecisionAudit>();
  const decision = (req: DecisionRequest): DecisionResult => {
    decisions.push(req);
    return { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
      answers: Object.fromEntries(req.questions.map(q => [q.id, q.kind === "predicate" ? { kind: "predicate", probability: 0.8 }
        : { kind: "choice", choice: Object.keys(q.kind === "choice" ? q.options : {})[0], confidence: 0.9 }])) };
  };
  const deps: DomainActorDependencies = { policy: () => policy,
    decide: durableDecision(audit => createDecisionPolicy({ backends: [fakeBackend(decision)], policy: () => policy, audit }), {
      load: async key => saved.get(key) ?? null, save: async (key, entry) => { saved.set(key, saved.get(key) ?? entry); return saved.get(key)!; }, usage: async () => {} }),
    respond: async () => ({ text: "I can do this", claim: true, preparedPrompt: "Implement the requested change; preserve the existing contract and verify the result." }), maintain: async ({ actor }) => actor.memory,
    startTask: async input => { starts.push(input); return { sessionId: input.sessionId, turnId: input.turnId }; }, ...overrides };
  const service = new DomainActorService(store, deps);
  const create = (id: string, extra: Partial<CreateDomainActor> = {}) => service.createActor("ws", { id, name: id, model: MODEL_CATALOG.luna.id, memory, ...extra });
  return { service, store, rooms, starts, decisions, deps, create, captures: () => captures };
}
const request = { workspaceId: "ws", requestId: "request", userPrompt: "Implement this" };
test("deleting workers archives their full identity, reserves IDs and preserves task and discussion history", async () => {
  const h = harness(); await h.create("a"); await h.create("child", { parentActorId: "a" });
  await assert.rejects(h.service.deleteActor("ws", "a"), /sub-workers first/);
  const round = await h.service.submit({ ...request, namedActorIds: ["child"] });
  await h.service.settled();
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  const before = await h.service.getRoom("ws");
  assert.deepEqual(await h.service.deleteActor("ws", "child"), { deletedActorId: "child" });
  const after = await h.service.getRoom("ws");
  assert.deepEqual(after.workItems, before.workItems); assert.deepEqual(after.rounds, before.rounds);
  assert.deepEqual(after.events, before.events);
  const archived = after.deletedActors![0]; const { deletedAt, ...snapshot } = archived;
  assert.ok(Number.isFinite(Date.parse(deletedAt)));
  assert.deepEqual(snapshot, before.actors.find(actor => actor.id === "child"));
  await assert.rejects(h.create("child"), /already exists/);
  await h.create("new-child", { name: "child", parentActorId: "a" });
  await assert.rejects(h.service.retryReply("ws", round.id, "child"), /not found/);
  await assert.rejects(h.service.submit({ ...request, requestId: "deleted", namedActorIds: ["child"] }), /not found/);
  assert.equal(await h.service.recoverMemory("ws"), 0);
  await h.service.deleteActor("ws", "new-child"); await h.service.deleteActor("ws", "a");
  assert.equal((await h.service.listActors("ws")).length, 0);
  await assert.rejects(h.service.deleteActor("ws", "a"), /not found/);
  await assert.rejects(h.service.deleteActor("missing", "a"), /workspace not found/);
  await assert.rejects(h.service.deleteActor("other", "a"), /not found/);
});

test("worker deletion refuses unfinished work including failed and needs-user tasks and live completed follow-ups", async () => {
  const h = harness(); await h.create("a"); await h.service.submit({ ...request, namedActorIds: ["a"] });
  for (const status of ["claimed", "assigned", "started", "failed", "needs_user"] as const) {
    await h.store.change("ws", room => { room.workItems[0].status = status; });
    await assert.rejects(h.service.deleteActor("ws", "a"), /unfinished work/);
  }
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  h.deps.runningSessions = async () => [{ actorId: "a", sessionId: "followup", turnId: "live", workItemId: (h.rooms.get("ws")!).workItems[0].id, status: "running" }];
  await assert.rejects(h.service.deleteActor("ws", "a"), /running task or follow-up/);
  h.deps.runningSessions = async () => [];
  await h.service.deleteActor("ws", "a");
});

test("worker deletion checks current transactional state for discussions, pending operations and active blockers", async () => {
  const h = harness(); await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  const base = structuredClone(h.rooms.get("ws")!);
  const cases: Array<(room: ActorRoom) => void> = [
    room => { room.rounds[0].status = "responding"; },
    room => { room.rounds[0].status = "awaiting_pickup"; room.workItems[0].executorActorId = "b"; room.workItems[0].ownerActorId = "b"; room.workItems[0].status = "claimed"; },
    room => { room.workItems[0].dispatchLease = { owner: "inflight", until: Date.now() + 60_000 }; },
    room => { room.workItems[0].assignmentRequests.push({ requestId: "assign", executorActorId: "b", model: MODEL_CATALOG.luna.id, status: "pending" }); },
    room => { room.workItems[0].parallelRequests = [{ requestId: "parallel", sourceActorId: "b", sourceSessionId: "session", tasks: [{ executorActorId: "a", task: "work" }], sourceSnapshot: room.actors[1], executorSnapshots: [room.actors[0]], userMessages: [], status: "pending", workItemIds: [], lease: null }]; },
    room => { room.taskUpdates = [{ requestId: "update", workItemId: room.workItems[0].id, workItem: structuredClone(room.workItems[0]), userPrompt: "next", namedActorIds: [], status: "pending", lease: null }]; },
    room => { room.workItems[0].completionReviews = [{ id: "review", workItemId: room.workItems[0].id, actorId: "a", ownerActorId: "a", roundId: room.rounds[0].id, taskSessionId: "session", taskTurnId: "turn", executionRevision: 0, status: "pending", issues: [], created: new Date().toISOString(), lease: { owner: "live", until: Date.now() + 60_000 } }]; },
    room => { room.blockers = [{ id: "blocker", workspaceId: "ws", workItemId: room.workItems[0].id, roundId: room.rounds[0].id, taskSessionId: "session", ownerActorId: "a", executorActorId: "a", kind: "other", source: "agent", dedupeKey: "blocker", description: "wait", selfClearing: true, status: "open", created: new Date().toISOString(), updated: new Date().toISOString(), proposals: [], history: [] }]; }
  ];
  for (const mutate of cases) {
    h.rooms.set("ws", structuredClone(base)); await h.store.change("ws", mutate);
    await assert.rejects(h.service.deleteActor("ws", "a"), error => error instanceof Error && error.constructor.name === "ActorDeletionConflict");
    assert.equal(h.rooms.get("ws")!.deletedActors, undefined);
  }
  h.rooms.set("ws", structuredClone(base));
  // Simulate an operation arriving after the service read but before its transactional delete.
  h.deps.runningSessions = async () => { await h.store.change("ws", room => { room.workItems[0].status = "failed"; }); return []; };
  await assert.rejects(h.service.deleteActor("ws", "a"), /unfinished work/);
});

test("deleted worker events are skipped by startup memory recovery and frozen reply retries cannot revive them", async () => {
  let maintains = 0;
  const h = harness({ respond: async () => { throw new Error("reply failed"); }, maintain: async ({ actor }) => { maintains++; return actor.memory; } });
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] }); await h.service.settled();
  await h.service.deleteActor("ws", "a");
  await h.store.change("ws", room => { room.events.push({ id: "old-event", workspaceId: "ws", actorIds: ["a"], roundId: round.id, type: "sh.completed", summary: "historical", created: "2020-01-01T00:00:00Z" }); });
  const count = maintains;
  assert.equal(await h.service.recoverMemory("ws"), 0); assert.equal(maintains, count);
  await assert.rejects(h.service.retryReply("ws", round.id, "b"), /deleted worker/);
  assert.equal(h.starts.length, 0);
});
test("a Decision dispatch records the owner and round as the inter-actor origin of the task's first prompt", async () => {
  const h = harness(); await h.create("a");
  const round = await h.service.submit(request);
  assert.equal(h.starts.length, 1);
  const origin = h.starts[0].promptOrigin;
  assert.equal(origin?.kind, "inter-actor"); assert.equal(origin?.trigger, "decision-dispatch");
  assert.equal(origin?.sourceActorId, h.starts[0].workItem.ownerActorId); assert.equal(origin?.sourceActorName, "a");
  assert.equal(origin?.sourceRoundId, round.id); assert.equal(origin?.sourceSessionId, undefined);
});

test("chat Stop persists across service instances, aborts only the targeted reply and discards late claims", async () => {
  const signals = new Map<string, AbortSignal>();
  const finish = new Map<string, (value: { text: string; claim: boolean; preparedPrompt?: string }) => void>();
  const h = harness({ respond: ({ actor, round, signal }) => new Promise(resolve => {
    const key = `${round.requestId}:${actor.id}`; signals.set(key, signal); finish.set(key, resolve);
  }) });
  await h.create("a"); await h.create("b");
  const first = h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  const second = h.service.submit({ ...request, requestId: "another", namedActorIds: ["a"] });
  while (signals.size < 3) await new Promise(resolve => setTimeout(resolve, 5));
  const room = await h.store.getRoom("ws");
  const id = room.rounds.find(round => round.requestId === "request")!.id;
  // The API instance is separate from the worker holding the AbortSignal.
  const api = new DomainActorService(h.store, h.deps);
  assert.equal((await api.stopReply("ws", id, "a")).status, "stopped");
  assert.equal((await api.stopReply("ws", id, "a")).status, "stopped");
  await assert.rejects(api.stopReply("other", id, "a"), /not found/);
  await assert.rejects(api.stopReply("ws", id, "absent"), /not found/);
  while (!signals.get("request:a")!.aborted) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(signals.get("request:b")!.aborted, false);
  assert.equal(signals.get("another:a")!.aborted, false);
  finish.get("request:a")!({ text: "Late claim", claim: true, preparedPrompt: "Must never run" });
  finish.get("request:b")!({ text: "Other actor continues", claim: false });
  finish.get("another:a")!({ text: "Other round continues", claim: false });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.replies.find(reply => reply.actorId === "a")!.status, "stopped");
  assert.equal(one.replies.find(reply => reply.actorId === "b")!.text, "Other actor continues");
  assert.equal(two.replies[0].text, "Other round continues");
  assert.equal(h.starts.length, 0);
  assert.equal((await api.stopReply("ws", two.id, "a")).status, "opinion", "completion wins if saved first");
});

test("request Stop ends the whole round before any reply or task is saved", async () => {
  const signals: AbortSignal[] = [];
  const finish: Array<(value: { text: string; claim: boolean; preparedPrompt?: string }) => void> = [];
  const h = harness({ respond: ({ signal }) => new Promise(resolve => { signals.push(signal); finish.push(resolve); }) });
  await h.create("a"); await h.create("b");
  const api = new DomainActorService(h.store, h.deps);
  assert.equal(await api.stopRequest("ws", "request"), null, "an unsaved request is reported, not failed");
  const pending = h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  while (signals.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  const stopped = await api.stopRequest("ws", "request");
  assert.ok(stopped?.stoppedAt);
  assert.equal(stopped.status, "no_claims");
  assert.equal((await api.stopRequest("ws", "request"))?.stoppedAt, stopped.stoppedAt, "repeating Stop is safe");
  while (!signals.every(signal => signal.aborted)) await new Promise(resolve => setTimeout(resolve, 5));
  for (const resolve of finish) resolve({ text: "Late claim", claim: true, preparedPrompt: "Must never run" });
  const round = await pending;
  assert.equal(round.status, "no_claims");
  assert.deepEqual(round.replies, []);
  assert.equal(h.starts.length, 0);
  assert.equal((await h.store.getRoom("ws")).workItems.length, 0);
});

test("chat reply Retry reruns only the failed speaker, keeps history, guards duplicates and can retry again", async () => {
  const calls: string[] = [];
  const outcomes: Array<"fail" | "opinion" | "claim"> = ["fail", "fail", "claim"];
  let hold: Promise<void> | undefined;
  const h = harness({ respond: async ({ actor }) => {
    calls.push(actor.id);
    if (actor.id === "b") return { text: "B opinion", claim: false };
    await hold;
    const outcome = outcomes.shift();
    if (outcome === "fail") throw new Error("Claude API error (authentication_failed): OAuth session expired");
    return outcome === "claim" ? { text: "A takes it", claim: true, preparedPrompt: "Implement the requested change." } : { text: "A opinion", claim: false };
  } });
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.status, "no_claims");
  assert.match(round.replies.find(reply => reply.actorId === "a")!.error!, /Stakeholder response failed: .*OAuth/);
  await assert.rejects(h.service.retryReply("ws", round.id, "b"), /Only a failed/, "successful replies are not retried");
  await assert.rejects(h.service.retryReply("ws", round.id, "absent"), /not found/);

  // A concurrent second click is rejected while the first retry is running.
  let release!: () => void;
  hold = new Promise(resolve => { release = resolve; });
  const first = h.service.retryReply("ws", round.id, "a");
  while ((await h.store.getRoom("ws")).rounds[0].status !== "responding") await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(h.service.retryReply("ws", round.id, "a"), /still responding/);
  release();
  const failedAgain = await first;
  hold = undefined;
  assert.equal(failedAgain.status, "no_claims");
  assert.equal(failedAgain.replies.find(reply => reply.actorId === "a")!.status, "error", "a new failure is saved");
  assert.equal(failedAgain.retriedReplies?.length, 1);
  assert.equal(failedAgain.replies.find(reply => reply.actorId === "b")!.text, "B opinion");

  const succeeded = await h.service.retryReply("ws", round.id, "a");
  assert.deepEqual(calls.filter(id => id === "b"), ["b"], "other actors never answer again");
  assert.equal(succeeded.replies.find(reply => reply.actorId === "a")!.status, "claimed");
  assert.equal(succeeded.retriedReplies?.length, 2, "failed attempts stay in history");
  assert.equal(succeeded.status, "awaiting_pickup");
  assert.equal(h.starts.length, 1);
  await assert.rejects(h.service.retryReply("ws", round.id, "a"), /Only a failed/);
});

test("an interrupted chat reply Retry restores a retryable failed reply", async () => {
  const h = harness({ respond: async () => { throw new Error("boom"); } });
  await h.create("a");
  const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => {
    const saved = room.rounds[0];
    // Simulates a retry whose worker died after the reservation.
    saved.retriedReplies = [{ ...saved.replies[0], retriedAt: "2026-10-24T00:00:00Z" }];
    saved.replies = []; saved.status = "responding"; saved.lease = { owner: "dead", until: 0 };
  });
  const retried = await h.service.retryReply("ws", round.id, "a");
  assert.equal(retried.status, "no_claims");
  assert.match(retried.replies[0].error!, /Stakeholder response failed: boom/);
  assert.match(retried.retriedReplies![1].error!, /retry was interrupted/, "the interruption is kept in history");
});

test("chat reply Retry is refused once the round reserved work", async () => {
  const h = harness({ respond: async ({ actor }) => {
    if (actor.id === "b") throw new Error("boom");
    return { text: "A takes it", claim: true, preparedPrompt: "Implement the requested change." };
  } });
  await h.create("a"); await h.create("b");
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.replies.find(reply => reply.actorId === "b")!.status, "error");
  await assert.rejects(h.service.retryReply("ws", round.id, "b"), /already reserved or started work/);
  assert.equal((await h.store.getRoom("ws")).rounds[0].replies.find(reply => reply.actorId === "b")!.status, "error", "the failed reply is kept");
});

test("chat Stop skips a speaker still waiting in a sequential response profile", async () => {
  let release!: () => void;
  const started: string[] = [];
  const h = harness({ respond: async ({ actor }) => { started.push(actor.id); await new Promise<void>(resolve => { release = resolve; }); return { text: "Done", claim: false }; } });
  await h.create("a"); await h.create("b");
  const pending = h.service.submit({ ...request, namedActorIds: ["a", "b"], responseProfile: { model: MODEL_CATALOG.luna.id, effort: "medium" } });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  const id = (await h.store.getRoom("ws")).rounds[0].id;
  await h.service.stopReply("ws", id, "b"); release();
  const result = await pending;
  assert.deepEqual(started, ["a"]);
  assert.equal(result.replies.find(reply => reply.actorId === "b")!.status, "stopped");
});

test("group fast track queues same-context work before picking and keeps only three task user prompts", async () => {
  const h = harness(); await h.create("a");
  for (let i = 0; i < 4; i++) await h.service.submit({ ...request, requestId: `seed-${i}`, userPrompt: `Composer edit ${i}` });
  // Private prompts and assistant output must never reach this Decision.
  await h.service.submit({ ...request, requestId: "private", userPrompt: "PRIVATE SECRET", namedActorIds: ["a"] });
  const previous = h.starts[3].workItem;
  await h.store.change("ws", room => { room.workItems.find(work => work.id === previous.id)!.status = "started"; });
  const updates: Parameters<NonNullable<DomainActorDependencies["updateTask"]>>[0][] = [];
  h.deps.updateTask = async input => { updates.push(input); };
  h.deps.respond = async () => { throw new Error("Fast track must bypass SH replies"); };
  const decide = h.deps.decide;
  let fastCalls = 0;
  h.deps.decide = async req => {
    fastCalls++;
    assert.equal(req.purpose, "sh_pick"); assert.equal(req.questions[0].id, "fastTrack");
    assert.deepEqual(JSON.parse(req.state), { userPrompt: fastCalls === 1 ? "Also remove the adjacent Composer hint" : "One more Composer edit",
      recentTaskUserPrompts: ["Composer edit 1", "Composer edit 2", fastCalls === 1 ? "Composer edit 3" : "Also remove the adjacent Composer hint"] });
    const result = await decide(req);
    assert.ok(result.ok);
    return { ...result, answers: { fastTrack: { kind: "choice", choice: "continue", confidence: 0.99 } } };
  };
  const input = { ...request, requestId: "fast", userPrompt: "Also remove the adjacent Composer hint" };
  const round = await h.service.submit(input);
  assert.equal(round.status, "assigned"); assert.equal(round.workItemId, previous.id);
  assert.equal(updates.length, 1); assert.equal(updates[0].idleOnly, false);
  assert.equal(updates[0].promptOrigin?.kind, "inter-actor"); assert.equal(updates[0].promptOrigin?.trigger, "fast-track");
  assert.equal(updates[0].promptOrigin?.sourceActorId, previous.ownerActorId);
  assert.equal(updates[0].userPrompt, input.userPrompt); assert.equal(updates[0].workItem.taskSessionId, previous.taskSessionId);
  // The queued text stays verbatim; the developer note names the group chat source and bounded context.
  const note = updates[0].sourceNote ?? "";
  assert.match(note, new RegExp(`^\\[Threadex Actors room message\\] Source: Actors group chat \\(workspace ws; round ${round.id}\\)\\. Sender: the user\\.`));
  assert.match(note, /Recent Actors group chat messages before it/);
  assert.match(note, /- User: Composer edit 3/); assert.match(note, /- User: Composer edit 2/);
  assert.doesNotMatch(note, /Composer edit 1|PRIVATE SECRET|Also remove the adjacent/, "only the two latest earlier group rounds, never private rounds or the message itself");
  assert.equal((await h.service.getRoom("ws")).rounds.find(item => item.id === round.id)!.continuation!.sourceNote, note, "the note is frozen for retries");
  await Promise.all([h.service.submit(input), h.service.submit(input)]);
  assert.equal(fastCalls, 1); assert.equal(updates.length, 1); assert.equal(h.starts.length, 5);
  assert.equal((await h.service.getRoom("ws")).workItems.find(work => work.id === previous.id)!.status, "started");
  const next = await h.service.submit({ ...input, requestId: "fast-again", userPrompt: "One more Composer edit" });
  assert.equal(next.workItemId, previous.id); assert.equal(fastCalls, 2); assert.equal(updates.length, 2);
});

test("fast track supports idle completed and failed tasks and preserves attachments for execution", async () => {
  for (const status of ["completed", "failed", "needs_user"] as const) {
    const h = harness(); await h.create("a"); const first = await h.service.submit(request);
    await h.store.change("ws", room => { room.workItems[0].status = status; });
    const attachment = { id: "file", name: "target.txt", type: "text/plain", size: 1, path: "/uploads/target.txt" };
    h.deps.saveAttachments = async () => [attachment];
    h.deps.updateTask = async input => { assert.deepEqual(input.attachments, [attachment]); assert.equal(input.idleOnly, false); };
    const decide = h.deps.decide;
    h.deps.decide = async req => {
      const result = await decide(req);
      return result.ok && req.questions[0].id === "fastTrack" ? { ...result, answers: { fastTrack: { kind: "choice", choice: "continue", confidence: 0.99 } } } : result;
    };
    const round = await h.service.submit({ ...request, requestId: "with-attachment", userPrompt: "Continue the same edit using this target", attachments: [attachment] });
    assert.equal(round.workItemId, first.workItemId); assert.equal(round.status, "assigned"); assert.equal(h.starts.length, 1);
  }
});

test("fast track failures, uncertain matches and unrelated requests fall back to normal picking", async () => {
  for (const choice of ["normal", "low-confidence", "invalid", "failed"]) {
    const h = harness(); await h.create("a"); await h.service.submit(request);
    h.deps.updateTask = async () => { assert.fail("unrelated work must not be queued"); };
    const decide = h.deps.decide;
    h.deps.decide = async req => {
      if (req.questions[0].id !== "fastTrack") return decide(req);
      if (choice === "failed") return { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] };
      return { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
        answers: { fastTrack: { kind: "choice", choice: choice === "low-confidence" ? "continue" : choice, confidence: choice === "low-confidence" ? 0.6 : 0.99 } } };
    };
    // Normal session selection independently rejects unrelated work too.
    const routing = h.deps.decide;
    h.deps.decide = async req => {
      const result = await routing(req);
      return result.ok && req.questions[0].id === "session" ? { ...result, answers: { session: { kind: "choice", choice: "new", confidence: 0.99 } } } : result;
    };
    const round = await h.service.submit({ ...request, requestId: `fallback-${choice}`, userPrompt: "Investigate a separate billing feature" });
    assert.equal(round.status, "awaiting_pickup"); assert.equal(h.starts.length, 2);
    assert.ok(h.decisions.some(req => req.purpose === "sh_pick" && req.questions[0].id !== "fastTrack"));
  }
});

test("project group chats pick only their own workers and bind tasks to their project", async () => {
  const selections: Array<SubmitActorRequest> = [];
  const h = harness({ listProjects: async () => [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }],
    resolveTaskBinding: async input => { selections.push(input);
      return input.newSessionProjectId ? { workspaceId: "ws", cwd: `/${input.newSessionProjectId}`, projectId: input.newSessionProjectId, source: "explicit" }
        : { workspaceId: "ws", cwd: "/ws", source: "workspace" }; } });
  await h.create("a"); await h.create("b"); await h.create("c"); await h.create("a-sub", { parentActorId: "a" });
  await h.service.updateActor("ws", "a", { projectIds: ["p1"] });
  await h.service.updateActor("ws", "b", { projectIds: ["p2", "p2"] });
  assert.deepEqual((await h.service.getRoom("ws")).actors.find(actor => actor.id === "b")!.projectIds, ["p2"]);
  await assert.rejects(h.service.updateActor("ws", "c", { projectIds: ["missing"] }), /not registered/);
  await assert.rejects(h.service.updateActor("ws", "a-sub", { projectIds: ["p1"] }), /root actor's projects/);
  const one = await h.service.submit({ ...request, requestId: "p1", chatProjectId: "p1" });
  assert.equal(one.chatProjectId, "p1");
  assert.deepEqual(one.candidateSnapshots.map(snapshot => snapshot.actorId), ["a"]);
  assert.equal(one.ownerActorId, "a");
  assert.equal(selections.at(-1)!.newSessionProjectId, "p1"); assert.equal(one.taskBinding?.cwd, "/p1");
  const unassigned = await h.service.submit({ ...request, requestId: "unassigned", chatProjectId: null });
  assert.deepEqual(unassigned.candidateSnapshots.map(snapshot => snapshot.actorId), ["c"]);
  assert.equal(unassigned.chatProjectId, null);
  const two = await h.service.submit({ ...request, requestId: "p2", chatProjectId: "p2" });
  assert.deepEqual(two.candidateSnapshots.map(snapshot => snapshot.actorId), ["b"]);
  assert.deepEqual(two.contextRoundIds, [], "another project's rounds are not context");
  assert.equal(two.previousOwnerId, undefined, "the previous owner is taken from this chat only");
  const pickedActors = h.decisions.filter(req => req.purpose === "sh_pick").map(req => req.questions.map(question => question.id).sort());
  assert.deepEqual(pickedActors, [["a"], ["c"], ["b"]], "each Decision picking pass sees only its chat's workers");
  await assert.rejects(h.service.submit({ ...request, requestId: "foreign", chatProjectId: "p1", namedActorIds: ["b", "a"] }), /belong to this group chat/);
  await assert.rejects(h.service.submit({ ...request, requestId: "other-project", chatProjectId: "p1", newSessionProjectId: "p2" }), /its own project/);
  await assert.rejects(h.service.submit({ ...request, requestId: "unknown", chatProjectId: "p9" }), /not registered/);
  await assert.rejects(h.service.submit({ ...request, requestId: "p1", chatProjectId: "p2" }), /different input/, "a request ID cannot move between chats");
  const direct = await h.service.submit({ ...request, requestId: "direct", namedActorIds: ["b"], chatProjectId: "p1" });
  assert.equal(direct.chatProjectId, undefined, "individual chats are not group chats");
  await h.service.updateActor("ws", "a", { projectIds: [] });
  assert.equal((await h.service.getRoom("ws")).actors.find(actor => actor.id === "a")!.projectIds, undefined);
});

test("a legacy round shown in a project chat is retried as saved, without rebinding its project", async () => {
  const h = harness({ listProjects: async () => [{ id: "dev", name: "dev" }],
    resolveTaskBinding: async () => ({ workspaceId: "ws", cwd: "/dev", projectId: "dev", source: "message" }) });
  await h.create("a");
  const legacy = await h.service.submit({ ...request, requestId: "legacy", userPrompt: "fix dev" });
  await h.store.change("ws", room => { delete room.rounds[0].chatProjectId; });
  const retried = await h.service.submit({ ...request, requestId: "legacy", userPrompt: "fix dev", chatProjectId: "dev" });
  assert.equal(retried.id, legacy.id); assert.equal(retried.chatProjectId, undefined);
  assert.equal(h.starts.length, 1, "the retry never dispatches twice");
  await assert.rejects(h.service.submit({ ...request, requestId: "legacy", userPrompt: "fix dev", chatProjectId: null }), /different input/);
});

test("fast track never continues a task from another project's chat", async () => {
  const h = harness({ listProjects: async () => [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }] });
  await h.create("a"); await h.service.updateActor("ws", "a", { projectIds: ["p1", "p2"] });
  await h.service.submit({ ...request, requestId: "first", chatProjectId: "p1" });
  h.deps.updateTask = async () => { assert.fail("a task of another project chat must not be continued"); };
  const decide = h.deps.decide;
  let fastCalls = 0;
  h.deps.decide = async req => {
    if (req.questions[0].id === "fastTrack") fastCalls++;
    const result = await decide(req);
    return result.ok && req.questions[0].id === "session" ? { ...result, answers: { session: { kind: "choice", choice: "new", confidence: 0.99 } } } : result;
  };
  await h.service.submit({ ...request, requestId: "second", userPrompt: "Continue the same edit", chatProjectId: "p2" });
  assert.equal(fastCalls, 0);
  await h.service.submit({ ...request, requestId: "third", userPrompt: "Continue the same edit", chatProjectId: "p1" });
  assert.equal(fastCalls, 1, "the same chat still reaches the fast-track Decision");
});

test("fast track requires a direct, recent, high-confidence follow-up", async () => {
  for (const scenario of ["intervening-group-round", "stale", "below-threshold"] as const) {
    const h = harness(); await h.create("a"); await h.service.submit(request);
    await h.store.change("ws", room => {
      const first = room.rounds[0];
      if (scenario === "stale") first.created = new Date(Date.now() - 31 * 60_000).toISOString();
      // A group discussion round without its own task sits between the task and the new message.
      if (scenario === "intervening-group-round") room.rounds.push({ ...structuredClone(first), id: "discussion", workItemId: null, workItemIds: undefined });
    });
    h.deps.updateTask = async () => { assert.fail(`${scenario} must not be queued onto the previous task`); };
    let fastCalls = 0;
    const decide = h.deps.decide;
    h.deps.decide = async req => {
      if (req.questions[0].id !== "fastTrack") return decide(req);
      fastCalls++;
      return { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0,
        answers: { fastTrack: { kind: "choice", choice: "continue", confidence: 0.85 } } };
    };
    const routing = h.deps.decide;
    h.deps.decide = async req => {
      const result = await routing(req);
      return result.ok && req.questions[0].id === "session" ? { ...result, answers: { session: { kind: "choice", choice: "new", confidence: 0.99 } } } : result;
    };
    const round = await h.service.submit({ ...request, requestId: `tight-${scenario}`, userPrompt: "Continue the same Composer edit" });
    assert.equal(round.status, "awaiting_pickup", scenario);
    assert.equal(fastCalls, scenario === "below-threshold" ? 1 : 0, `${scenario}: deterministic gates skip the fast-track decision`);
  }
});

test("picking after a declined fast track sees the direct previous request and returns to its claimants", async () => {
  for (const scenario of ["continuation", "unrelated", "stale"] as const) {
    const h = harness({ respond: async ({ actor }) => actor.id === "c" ? { text: "Not mine", claim: false }
      : { text: "I can do this", claim: true, preparedPrompt: "Implement the requested change." } });
    await h.create("a"); await h.create("b"); await h.create("c");
    await h.service.submit({ ...request, userPrompt: "Fix waiting for limit reset" });
    if (scenario === "stale") await h.store.change("ws", room => { room.rounds[0].created = new Date(Date.now() - 31 * 60_000).toISOString(); });
    h.deps.updateTask = async () => { assert.fail(`${scenario} must not be queued onto the previous task`); };
    const decide = h.deps.decide;
    h.deps.decide = async req => {
      const result = await decide(req);
      if (!result.ok || req.purpose !== "sh_pick") return result;
      if (req.questions[0].id === "fastTrack") return { ...result, answers: { fastTrack: { kind: "choice", choice: "normal", confidence: 0.99 } } };
      const follow = scenario === "continuation" ? 0.95 : 0.05;
      return { ...result, answers: Object.fromEntries(req.questions.map(q => [q.id, { kind: "predicate", probability: q.id === "c" ? 0.98 : q.id.includes(":") ? follow : 0.01 }])) };
    };
    const round = await h.service.submit({ ...request, requestId: `follow-${scenario}`, userPrompt: "If the account is switched, clear it too" });
    const pick = h.decisions.filter(req => req.purpose === "sh_pick" && req.questions[0].id !== "fastTrack").at(-1)!;
    const state = JSON.parse(pick.state);
    if (scenario === "stale") {
      assert.equal(state.recentRequests, undefined, "a long gap gives picking no prior-task context");
      assert.deepEqual(round.stakeholderIds, ["c"]);
      continue;
    }
    assert.deepEqual(state.recentRequests, [{ userPrompt: "Fix waiting for limit reset", claimantIds: ["a", "b"] }]);
    assert.deepEqual(round.stakeholderIds, scenario === "continuation" ? ["a", "b", "c"] : ["c"], scenario);
    assert.deepEqual(round.selection?.continuation, scenario === "continuation" ? { probability: 0.95, actorIds: ["a", "b"] } : undefined);
  }
});

test("normal session selection admits similar follow-ups without explicit context selection", async () => {
  const deliveries: string[] = [];
  const h = harness({ updateTask: async input => { deliveries.push(input.workItem.id); } }); await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  const round = await h.service.submit({ ...request, requestId: "same-context", userPrompt: "Remove another Composer hint", namedActorIds: ["a"] });
  assert.equal(round.workItemId, first.workItemId); assert.deepEqual(deliveries, [first.workItemId]);
  assert.equal(h.starts.length, 1);
});

test("uncertain fast-track delivery retries the same reference without new work or picking", async () => {
  const h = harness(); await h.create("a"); const first = await h.service.submit(request);
  let calls = 0;
  h.deps.updateTask = async () => { if (++calls === 1) throw new Error("Receipt lost"); };
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    const result = await decide(req);
    return result.ok && req.questions[0].id === "fastTrack" ? { ...result, answers: { fastTrack: { kind: "choice", choice: "continue", confidence: 0.99 } } } : result;
  };
  const input = { ...request, requestId: "lost-fast-receipt", userPrompt: "Continue the same Composer change" };
  assert.match((await h.service.submit(input)).error!, /Receipt lost/);
  await h.store.change("ws", room => { room.actors[0].allowedModels = [MODEL_CATALOG.astra.id]; });
  assert.match((await h.service.submit(input)).error!, /permissions changed/); assert.equal(calls, 1);
  await h.store.change("ws", room => { room.actors[0].allowedModels.push(MODEL_CATALOG.luna.id); });
  const round = await h.service.submit(input);
  assert.equal(round.workItemId, first.workItemId); assert.equal(round.status, "assigned"); assert.equal(calls, 2); assert.equal(h.starts.length, 1);
});

test("workflow Decision is persisted with assigned scope and survives retries without changing permissions", async () => {
  for (const assessment of ["small_direct", "substantial_managed", "substantial_direct"] as const) {
    const h = harness(); await h.create("a");
    const decide = h.deps.decide;
    h.deps.decide = async req => {
      const result = await decide(req);
      if (!result.ok) return result;
      assert.ok(req.questions.some(question => question.id === "workflow"));
      const state = JSON.parse(req.state);
      assert.equal(state.userPrompt, "做");
      assert.equal(state.preparedPrompt, "Implement the requested change; preserve the existing contract and verify the result.");
      assert.equal(state.assignedScope, "Entire canonical request, including any scope beyond a partial claim");
      return { ...result, answers: { ...result.answers, workflow: { kind: "choice", choice: assessment, confidence: 0.99 } } };
    };
    const input = { ...request, userPrompt: "做", namedActorIds: ["a"], approvalPolicy: "never" as const };
    const round = await h.service.submit(input);
    const work = h.starts[0].workItem;
    assert.equal(work.workflowAssessment, assessment);
    assert.deepEqual(round.replies[0].modelDecision?.ok && round.replies[0].modelDecision.answers.workflow,
      { kind: "choice", choice: assessment, confidence: 0.99 });
    assert.equal(h.starts[0].approvalPolicy, "never");
    assert.equal("managedMode" in work, false, "recommendations never become mode settings");
    assert.equal("managedMode" in h.starts[0], false);
    const calls = h.decisions.length;
    await h.service.submit(input);
    assert.equal(h.decisions.length, calls);
    assert.equal(h.starts.length, 1);
    assert.equal((await h.service.getRoom("ws")).workItems[0].workflowAssessment, assessment);
    await h.service.settled();
  }
});

test("actor project selection is frozen with the request and survives launch failure and restart", async () => {
  let resolutions = 0, fail = true;
  const binding = { workspaceId: "ws", projectId: "backend", cwd: "/work/backend", source: "explicit" as const };
  const seen: ActorTaskStart[] = [];
  const h = harness({ resolveTaskBinding: async () => { resolutions++; return binding; },
    startTask: async input => { seen.push(input); if (fail) throw new Error("queue unavailable"); return { sessionId: input.sessionId, turnId: input.turnId }; } });
  await h.create("a");
  const input = { ...request, namedActorIds: ["a"], newSessionProjectId: "backend", approvalPolicy: "never" as const };
  const round = await h.service.submit(input);
  assert.deepEqual(round.taskBinding, binding);
  assert.deepEqual(round.taskSelection, { newSessionProjectId: "backend" });
  fail = false;
  h.deps.resolveTaskBinding = async () => { throw new Error("project registry changed"); };
  const restarted = new DomainActorService(h.store, h.deps);
  await restarted.submit(input);
  assert.equal(resolutions, 1); assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].taskBinding, binding); assert.equal(seen[1].approvalPolicy, "never");
  assert.equal(seen[0].sessionId, seen[1].sessionId);
  await assert.rejects(restarted.submit({ ...input, newSessionProjectId: "another" }), /different input/);
  await assert.rejects(restarted.submit({ ...input, newSessionCwd: "/work/another" }), /different input/);
});

test("worker uses the server queue snapshot and client-supplied binding cannot override resolution", async () => {
  const frozen = { workspaceId: "ws", cwd: "/at-submission", source: "workspace" as const };
  const h = harness({ resolveTaskBinding: async () => ({ workspaceId: "ws", cwd: "/current", source: "workspace" }) });
  await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] }, frozen);
  assert.deepEqual(h.starts[0].taskBinding, frozen);
  const malicious = { ...request, requestId: "new", namedActorIds: ["a"], taskBinding: { ...frozen, cwd: "/arbitrary" } };
  await h.service.submit(malicious);
  assert.equal(h.starts[1].taskBinding?.cwd, "/current");
  await assert.rejects(h.service.submit({ ...request, requestId: "foreign" }, { ...frozen, workspaceId: "foreign" }), /another workspace/);
});

test("actor-default source survives saved round readback and queued replay without rebinding private history", async () => {
  const binding = { workspaceId: "ws", cwd: "/actor-project", projectId: "p1", source: "actor" as const };
  const h = harness({ resolveTaskBinding: async () => { throw new Error("registry changed after queueing"); } });
  await h.create("a");
  const input = { ...request, namedActorIds: ["a"] };
  await h.service.submit(input, JSON.parse(JSON.stringify(binding)));
  const restarted = new DomainActorService(h.store, h.deps);
  const saved = await restarted.submit(input);
  assert.deepEqual(saved.taskBinding, binding);
  assert.deepEqual(h.starts[0].taskBinding, binding);
  assert.equal(h.starts.length, 1, "a saved request does not dispatch or resolve again");
  const room = await restarted.getRoom("ws");
  assert.deepEqual(actorRoomForChat(room, "p1").rounds, [], "an individual actor default stays private");
  assert.deepEqual(actorRoomForChat(room, "unassigned").rounds, []);
  assert.deepEqual(room.rounds[0].taskBinding, binding, "normalization and chat projection preserve saved source");
});

test("selecting another project excludes an otherwise matching continuation and explicit updates cannot rebind tasks", async () => {
  let cwd = "/first";
  const h = harness({ resolveTaskBinding: async () => ({ workspaceId: "ws", cwd, source: "explicit" }),
    updateTask: async () => { throw new Error("Must not continue a different project"); } });
  await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"], newSessionProjectId: "first" });
  h.deps.respond = async () => ({ text: "Work", claim: true, preparedPrompt: "Apply to the selected project", contextRoundIds: [first.id] });
  cwd = "/second";
  await h.service.submit({ ...request, requestId: "second", namedActorIds: ["a"], newSessionProjectId: "second" });
  assert.equal(h.starts.length, 2); assert.equal(h.starts[1].taskBinding?.cwd, "/second");
  await assert.rejects(h.service.submit({ ...request, requestId: "update", taskReference: first.workItemId!, newSessionProjectId: "second" }), /keeps its project/);
});

test("a matching continuation reuses task identity with the newly selected model and an idempotent reference update", async () => {
  const updates: Parameters<NonNullable<DomainActorDependencies["updateTask"]>>[0][] = [];
  const h = harness({ updateTask: async input => { updates.push(input); } });
  await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  h.deps.respond = async () => ({ text: "Continue UI", claim: true, preparedPrompt: "Restore the full composer", contextRoundIds: [first.id] });
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    const result = await decide(req);
    return result.ok && req.questions[0].id === "model" ? { ...result, answers: { ...result.answers,
      model: { kind: "choice", choice: MODEL_CATALOG.astra.id, confidence: 0.99 },
      workflow: { kind: "choice", choice: "substantial_managed", confidence: 0.99 } } } : result;
  };
  const input = { ...request, requestId: "continue", userPrompt: "Use Astra and restore the full composer", namedActorIds: ["a"] };
  const continued = await h.service.submit(input);
  assert.equal(continued.status, "assigned"); assert.equal(continued.workItemId, first.workItemId);
  assert.equal(updates.length, 1); assert.equal(updates[0].workItem.taskSessionId, h.starts[0].sessionId);
  assert.equal(updates[0].promptOrigin?.trigger, "task-update", "an idle routed continuation is a task-update, not a fast-track");
  assert.equal(updates[0].promptOrigin?.sourceActorId, "a");
  assert.equal(updates[0].workItem.model, MODEL_CATALOG.astra.id); assert.equal(updates[0].idleOnly, false);
  assert.equal(updates[0].workflowGuidance, true, "a routed session reuse keeps its workflow guidance");
  assert.equal(updates[0].workItem.workflowAssessment, "substantial_managed");
  assert.match(updates[0].userPrompt, /Use Astra and restore the full composer/);
  assert.match(updates[0].userPrompt, /Restore the full composer/);
  assert.match(updates[0].sourceNote ?? "", /^\[Threadex Actors room message\] Source: Actors individual chat with \S/);
  assert.ok(updates[0].sourceNote!.includes(`- User: ${request.userPrompt}`), "individual chat cites its own earlier round");
  await h.service.submit(input);
  assert.equal(updates.length, 1); assert.equal(h.starts.length, 1);
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  assert.equal((await h.service.getRoom("ws")).workItems[0].workflowAssessment, "substantial_managed");
  assert.ok(continued.continuation?.decision.ok);
});

test("session selection keeps independent context separate even when a prior round supplies background", async () => {
  const h = harness({ updateTask: async () => { assert.fail("unrelated work must not reuse"); } });
  await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  h.deps.respond = async () => ({ text: "Independent feature", claim: true, preparedPrompt: "Implement unrelated feature", contextRoundIds: [first.id] });
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    const result = await decide(req);
    return result.ok && req.questions[0].id === "session" ? { ...result, answers: { session: { kind: "choice", choice: "new", confidence: 0.99 } } } : result;
  };
  const round = await h.service.submit({ ...request, requestId: "independent", userPrompt: "Build a different feature", namedActorIds: ["a"] });
  assert.notEqual(round.workItemId, first.workItemId); assert.equal(h.starts.length, 2);
  assert.ok(round.continuation?.decision.ok); assert.equal(round.continuation?.workItem, undefined);
});

test("a running matching session queues the continuation once without a duplicate launch", async () => {
  const updates: Parameters<NonNullable<DomainActorDependencies["updateTask"]>>[0][] = [];
  const h = harness({ updateTask: async input => { updates.push(input); return { queuedBehind: 2 }; } }); await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "started"; });
  h.deps.respond = async () => ({ text: "Continue", claim: true, preparedPrompt: "Continue existing work", contextRoundIds: [first.id] });
  const input = { ...request, requestId: "running-update", namedActorIds: ["a"] };
  const round = await h.service.submit(input);
  assert.equal(round.status, "assigned"); assert.equal(round.error, null); assert.equal(round.workItemId, first.workItemId);
  assert.equal(round.continuation?.delivered, true); assert.equal(round.continuation?.queuedBehind, 2);
  assert.equal(updates.length, 1); assert.equal(updates[0].idleOnly, false, "running work queues instead of requiring idle");
  assert.equal(updates[0].promptOrigin?.trigger, "task-update");
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "started", "queueing never alters the running task");
  // A retried or re-run submission is idempotent.
  assert.equal((await h.service.submit(input)).status, "assigned");
  assert.equal(h.starts.length, 1); assert.equal(updates.length, 1);
});

test("an undelivered earlier update on the same task does not block a new continuation", async () => {
  let calls = 0;
  const h = harness({ updateTask: async () => { if (++calls === 1) throw new Error("Receipt lost"); } }); await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "started"; });
  h.deps.respond = async () => ({ text: "Continue", claim: true, preparedPrompt: "Continue existing work", contextRoundIds: [first.id] });
  const failed = await h.service.submit({ ...request, requestId: "lost", namedActorIds: ["a"] });
  assert.equal(failed.status, "routing_failed"); assert.match(failed.error!, /Receipt lost/);
  const next = await h.service.submit({ ...request, requestId: "next", userPrompt: "Another edit", namedActorIds: ["a"] });
  assert.equal(next.status, "assigned"); assert.equal(next.workItemId, first.workItemId);
  assert.equal(h.starts.length, 1); assert.equal(calls, 2);
});

test("continuation candidates exclude foreign executors and invisible private context", async () => {
  const h = harness({ updateTask: async () => { assert.fail("wrong actor binding"); } });
  await h.create("a"); await h.create("b"); await h.create("sub", { parentActorId: "a" });
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  h.deps.respond = async () => ({ text: "Do work", claim: true, preparedPrompt: "Implement it", contextRoundIds: [first.id] });
  await h.service.submit({ ...request, requestId: "foreign", namedActorIds: ["b"] });
  h.deps.respond = async () => ({ text: "Delegate", claim: true, preparedPrompt: "Implement it", executorActorId: "sub", contextRoundIds: [first.id] });
  await h.service.submit({ ...request, requestId: "different-binding", namedActorIds: ["a"] });
  assert.equal(h.starts.length, 3); assert.equal(h.decisions.filter(req => req.questions[0].id === "session").length, 0);
});

test("continuation permission changes and uncertain receipts never fall back to duplicate work", async () => {
  let calls = 0;
  const h = harness({ updateTask: async () => { if (++calls === 1) throw new Error("Receipt lost"); } }); await h.create("a");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
  h.deps.respond = async () => ({ text: "Continue", claim: true, preparedPrompt: "Continue", contextRoundIds: [first.id] });
  const input = { ...request, requestId: "uncertain-continuation", namedActorIds: ["a"] };
  assert.equal((await h.service.submit(input)).status, "routing_failed");
  await h.store.change("ws", room => { room.actors[0].allowedModels = [MODEL_CATALOG.astra.id]; });
  assert.match((await h.service.submit(input)).error!, /permissions changed/);
  assert.equal(calls, 1); assert.equal(h.starts.length, 1);
  await h.store.change("ws", room => { room.actors[0].allowedModels.push(MODEL_CATALOG.luna.id); });
  assert.equal((await h.service.submit(input)).status, "assigned");
  assert.equal(calls, 2); assert.equal(h.starts.length, 1);
});

test("failed or invalid session Decisions preserve existing work without automatic new-session fallback", async () => {
  for (const invalid of [false, true]) {
    const h = harness({ updateTask: async () => { assert.fail("no valid session decision"); } }); await h.create("a");
    const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
    await h.store.change("ws", room => { room.workItems[0].status = "completed"; });
    h.deps.respond = async () => ({ text: "Continue", claim: true, preparedPrompt: "Continue", contextRoundIds: [first.id] });
    const decide = h.deps.decide;
    h.deps.decide = async req => req.questions[0].id !== "session" ? decide(req) : invalid
      ? { ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0, answers: { session: { kind: "choice", choice: "foreign-work", confidence: 1 } } }
      : { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] };
    const input = { ...request, requestId: "selection-failure", namedActorIds: ["a"] };
    assert.match((await h.service.submit(input)).error!, /Session selection failed/);
    await h.service.submit(input);
    assert.equal(h.starts.length, 1); assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  }
});

test("completion review gates publication, links the executor, and deduplicates concurrent result deliveries", async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reviewing = new Promise<void>(resolve => { entered = resolve; });
  const h = harness({ reviewTask: async input => {
    calls++; assert.equal(input.workItem.executorActorId, "worker");
    assert.equal(input.userPrompt, "Implement this"); entered(); await pending;
    return { verdict: "passed", issues: [] };
  }, respond: async () => ({ text: "Delegate", claim: true, preparedPrompt: "Implement this", executorActorId: "worker" }) });
  await h.create("owner"); await h.create("worker", { parentActorId: "owner" });
  await h.service.submit({ ...request, namedActorIds: ["owner"] });
  const work = (await h.service.getRoom("ws")).workItems[0];
  h.store.persistence.getSessionTurn = async id => ({ id, sessionId: work.taskSessionId, userInput: request.userPrompt,
    agentResponse: "Implemented and verified", status: "done", runnerExitCode: 0 }) as Awaited<ReturnType<ActorPersistence["getSessionTurn"]>>;
  const completion = event("runner.result", work.taskSessionId, work.taskTurnId, "review-first");
  const first = h.service.observe(completion); await reviewing;
  let current = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(current.completionReviews![0].status, "pending");
  assert.deepEqual(actorPublishableConclusions(current), []);
  await new DomainActorService(h.store, h.deps).observe({ ...completion, eventId: "duplicate-other-id" });
  assert.equal(calls, 1); release(); await first; await h.service.settled();
  await h.service.observe(completion); await h.service.settled();
  current = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(current.completionReviews!.length, 1); assert.equal(calls, 1);
  const conclusion = actorPublishableConclusions(current)[0];
  assert.deepEqual({ actor: conclusion.actorId, work: conclusion.workItemId, session: conclusion.taskSessionId, turn: conclusion.taskTurnId,
    review: conclusion.reviewId, text: conclusion.text }, { actor: "worker", work: work.id, session: work.taskSessionId,
    turn: work.taskTurnId, review: current.completionReviews![0].id, text: "Implemented and verified" });
  await h.service.observe(event("runner.runner.started", work.taskSessionId, "follow-up", "new-turn", "2026-10-22T23:00:00Z"));
  assert.deepEqual(actorPublishableConclusions((await h.service.getRoom("ws")).workItems[0]), [], "a new turn suppresses the previous announcement");
  await h.service.observe(event("runner.result", work.taskSessionId, "follow-up", "new-result", "2026-10-22T23:01:00Z"));
  await h.service.settled();
  current = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(calls, 2); assert.equal(current.completionReviews!.length, 2);
  assert.equal(actorPublishableConclusions(current).length, 1);
  assert.equal(actorPublishableConclusions(current)[0].taskTurnId, "follow-up");
  assert.notEqual(actorPublishableConclusions(current)[0].id, conclusion.id);
});

test("interrupted persisted reviews become explicit errors and cannot release a conclusion", async () => {
  let now = Date.now();
  const h = harness({ now: () => now }); await h.create("a"); await h.service.submit(request);
  const work = (await h.service.getRoom("ws")).workItems[0];
  await h.store.change("ws", room => {
    room.workItems[0].completionReviews = [{ id: "interrupted", workItemId: work.id, actorId: "a", ownerActorId: "a",
      roundId: work.roundId, taskSessionId: work.taskSessionId, taskTurnId: work.taskTurnId, executionRevision: work.executionRevision,
      status: "pending", issues: [], created: new Date(now).toISOString(), lease: { owner: "dead-process", until: now + 1000 } }];
  });
  assert.equal((await h.service.getRoom("ws")).workItems[0].completionReviews![0].status, "pending");
  now += 1001;
  const current = (await new DomainActorService(h.store, h.deps).getRoom("ws")).workItems[0];
  assert.equal(current.completionReviews![0].status, "error");
  assert.match(current.completionReviews![0].error!, /interrupted/);
  assert.deepEqual(actorPublishableConclusions(current), []);
});

test("review issues, invalid verdicts, helper failure and unavailable outcomes all fail closed", async () => {
  const cases: Array<{ reviewTask?: DomainActorDependencies["reviewTask"]; saved?: boolean; exit?: number; status: string }> = [
    { reviewTask: async () => ({ verdict: "issues_found", issues: ["Verification failed"] }), status: "issues_found" },
    { reviewTask: async () => ({ verdict: "passed", issues: ["Unresolved"] }), status: "error" },
    { reviewTask: async () => { throw new Error("Review unavailable"); }, status: "error" },
    { status: "error" }, { saved: false, status: "error" }, { exit: 1, status: "error" }
  ];
  for (const scenario of cases) {
    const h = harness({ reviewTask: scenario.reviewTask }); await h.create("a"); await h.service.submit(request);
    const work = (await h.service.getRoom("ws")).workItems[0];
    h.store.persistence.getSessionTurn = async id => scenario.saved === false ? null : ({ id, sessionId: work.taskSessionId,
      userInput: request.userPrompt, agentResponse: "Done", status: "done", runnerExitCode: scenario.exit ?? 0 }) as Awaited<ReturnType<ActorPersistence["getSessionTurn"]>>;
    await h.service.observe(event("runner.result", work.taskSessionId, work.taskTurnId)); await h.service.settled();
    const current = (await h.service.getRoom("ws")).workItems[0];
    assert.equal(current.completionReviews![0].status, scenario.status);
    assert.equal(current.completionReviews![0].conclusion, undefined);
    assert.deepEqual(actorPublishableConclusions(current), []);
  }
});

const unrelatedReply = { text: "This work is unrelated to my role", intent: "work" as const, inRole: false, claim: false };

test("all unrelated group replies repick with complete reports and frozen request context, once across concurrent retries", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("c");
  const prior = await h.service.submit({ ...request, requestId: "context", namedActorIds: ["a", "c"] });
  const seen: ActorRound[] = [];
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.deps.respond = async ({ actor, round }) => {
    seen.push(round);
    if (actor.id !== "c") return unrelatedReply;
    entered(); await gate;
    return { text: "I own this", intent: "work", inRole: true, claim: true, preparedPrompt: "Implement with the original context", contextRoundIds: [prior.id] };
  };
  const input = { ...request, namedActorIds: ["a", "b"], approvalPolicy: "granular" as const,
    responseProfile: { model: MODEL_CATALOG.luna.id, effort: "high" } };
  const pending = h.service.submit(input);
  await waiting;
  const concurrent = await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(concurrent.status, "responding");
  release();
  const result = await pending;
  assert.equal(result.ownerActorId, "c"); assert.equal(result.status, "awaiting_pickup");
  assert.equal(result.pickingHistory?.length, 1);
  assert.deepEqual(result.replies.slice(0, 2).map(r => [r.intent, r.inRole, r.text]), [0, 1].map(() => ["work", false, unrelatedReply.text]));
  const picking = h.decisions.filter(d => d.audit.roundId === result.id && d.purpose === "sh_pick");
  assert.equal(picking.length, 1);
  assert.equal(picking[0].audit.workItemId, `${result.id}:picking:1`);
  assert.deepEqual(JSON.parse(picking[0].state).priorReports, result.replies.slice(0, 2));
  const repicked = seen.find(r => r.stakeholderIds.includes("c"))!;
  assert.equal(repicked.userPrompt, input.userPrompt); assert.deepEqual(repicked.responseProfile, input.responseProfile);
  assert.deepEqual(repicked.contextRoundIds, [prior.id]); assert.equal(repicked.approvalPolicy, "granular");
  assert.deepEqual(h.starts.at(-1)!.workItem.canonicalUserMessages, [prior.userPrompt, input.userPrompt]);
  const starts = h.starts.length;
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(h.starts.length, starts); assert.equal(seen.length, 3);
});

test("automatic picking advances past unrelated actors and stops explicitly when its frozen pool is exhausted", async () => {
  const h = harness({ respond: async () => unrelatedReply });
  for (let i = 0; i < 10; i++) await h.create(`actor-${i}`);
  const round = await h.service.submit(request);
  assert.equal(round.status, "routing_failed"); assert.match(round.error!, /All work remains unpicked/);
  assert.deepEqual(round.pickingHistory?.map(p => p.stakeholderIds.length), [8, 2]);
  assert.equal(round.replies.length, 10); assert.equal(h.starts.length, 0);
  const picks = h.decisions.filter(d => d.purpose === "sh_pick");
  assert.equal(picks.length, 2); assert.notDeepEqual(picks[0].audit, picks[1].audit);
  await h.service.submit(request); assert.equal(h.decisions.length, 2);
});

test("opinions, errors, timeouts and missing replies never count as explicit unrelated reports", async () => {
  for (const mode of ["opinion", "discussion", "error", "timeout"] as const) {
    const h = harness({ replyTimeoutMs: 50, respond: async ({ actor }) => {
      if (actor.id === "a") return unrelatedReply;
      if (mode === "error") throw new Error("provider failed");
      if (mode === "timeout") return new Promise(() => {});
      return { text: "Opinion", claim: false, ...(mode === "discussion" ? { intent: "discussion", inRole: false } : {}) };
    } });
    await h.create("a"); await h.create("b"); await h.create("c");
    const input = { ...request, namedActorIds: ["a", "b"] };
    const round = await h.service.submit(input);
    assert.equal(round.status, "no_claims", mode); assert.equal(round.pickingHistory, undefined, mode);
    assert.equal(h.decisions.length, 0); assert.equal(h.starts.length, 0);
    if (mode === "opinion") {
      await h.store.change("ws", room => {
        const current = room.rounds[0]; current.status = "responding";
        current.replies = current.replies.filter(r => r.actorId === "a");
        current.deadline = "2020-01-01T00:00:00Z"; current.lease = null;
      });
      const resumed = await new DomainActorService(h.store, h.deps).submit(input);
      assert.equal(resumed.replies[1].status, "timeout"); assert.equal(resumed.pickingHistory, undefined);
    }
  }
});

test("a related claimant retains normal routing and individual unrelated replies stay private", async () => {
  const h = harness({ respond: async ({ actor }) => actor.id === "a" ? unrelatedReply
    : { text: "Own all", intent: "work", inRole: true, claim: true, preparedPrompt: "Implement all requirements" } });
  await h.create("a"); await h.create("b"); await h.create("c");
  const group = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(group.ownerActorId, "b"); assert.equal(group.pickingHistory, undefined);
  const individual = await h.service.submit({ ...request, requestId: "private", namedActorIds: ["a"] });
  assert.equal(individual.status, "no_claims"); assert.equal(individual.pickingHistory, undefined);
  assert.equal(h.starts.length, 1);
});

test("restart between picking passes reuses saved reports and selection identity without asking declined actors again", async () => {
  const seen: string[] = [];
  const h = harness({ respond: async ({ actor }) => {
    seen.push(actor.id);
    return actor.id === "c" ? { text: "Own it", claim: true, preparedPrompt: "Implement the request" } : unrelatedReply;
  } });
  await h.create("a"); await h.create("b"); await h.create("c");
  const decide = h.deps.decide;
  h.deps.decide = async () => { throw new Error("worker interrupted before picking"); };
  const input = { ...request, namedActorIds: ["a", "b"] };
  await assert.rejects(h.service.submit(input), /worker interrupted/);
  const saved = h.rooms.get("ws")!.rounds[0];
  assert.equal(saved.status, "queued"); assert.equal(saved.pickingHistory?.length, 1);
  assert.equal(saved.lease, null);
  h.deps.decide = decide;
  const resumed = await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(resumed.ownerActorId, "c"); assert.equal(resumed.pickingHistory?.length, 1);
  assert.deepEqual(seen.sort(), ["a", "b", "c"]);
  assert.equal(h.decisions.find(d => d.purpose === "sh_pick")!.audit.workItemId, `${saved.id}:picking:1`);
  assert.equal(h.starts.length, 1);
});

test("repicking failures stay unassigned and attachment identity survives the next pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "repick-files-"));
  try {
    const h = harness({ saveAttachments: (ws, id, files) => saveActorAttachments(directory, ws, id, files) });
    await h.create("a"); await h.create("b"); await h.create("c");
    const paths: string[] = [];
    h.deps.respond = async ({ actor, round }) => {
      paths.push(round.attachments![0].path!);
      return actor.id === "c" ? { text: "Own it", claim: true, preparedPrompt: "Use the file" } : unrelatedReply;
    };
    const input = { ...request, namedActorIds: ["a", "b"], attachments: [
      { id: "req", name: "requirements.txt", type: "text/plain", size: 3, dataUrl: "data:text/plain;base64,YWJj" }
    ] };
    const round = await h.service.submit(input);
    assert.equal(round.ownerActorId, "c"); assert.equal(new Set(paths).size, 1);
    assert.equal(h.starts[0].attachments![0].path, paths[0]);
    h.deps.decide = async () => ({ ok: false, attempts: [] });
    const failure = await h.service.submit({ ...input, requestId: "failed-picking" });
    assert.equal(failure.status, "routing_failed"); assert.equal(failure.ownerActorId, null);
    assert.equal(failure.replies.length, 2); assert.equal(failure.pickingHistory?.length, 1);
    assert.equal(h.starts.length, 1);
    await h.service.submit({ ...input, requestId: "failed-picking" });
    assert.equal(h.starts.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actor request approval policy is saved, dispatched and immutable on retry", async () => {
  for (const approvalPolicy of ["granular", "on-request", "untrusted", "never", undefined] as const) {
    const h = harness();
    await h.create("actor");
    const input = { ...request, approvalPolicy, namedActorIds: ["actor"] };
    const round = await h.service.submit(input);
    assert.equal(round.approvalPolicy, approvalPolicy);
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].approvalPolicy, approvalPolicy);
    await h.service.submit(input);
    assert.equal(h.starts.length, 1);
    await assert.rejects(h.service.submit({ ...input, approvalPolicy: approvalPolicy === "never" ? "on-request" : "never" }), /different input/);
  }
  const h = harness();
  await assert.rejects(h.service.submit({ ...request, approvalPolicy: "invalid" as "never" }), /Invalid actor approval policy/);
});

const partialReply = { text: "I can own a portion", claim: true, claimKind: "partial" as const, claimScope: "API only", preparedPrompt: "Implement the API only." };function partialPlan(uiDependsOn = ["api-work"]) {
  return {
    requirements: [
      { id: "api", messageIndex: 0, start: 0, end: 7, description: "Implement API" },
      { id: "ui", messageIndex: 0, start: 7, end: 15, description: "Implement UI and integration" }
    ],
    assignments: [
      { id: "api-work", actorId: "a", requirementIds: ["api"], brief: "Implement API; own shared contract. Verify API behavior.", dependsOn: [] as string[] },
      { id: "ui-work", actorId: "b", requirementIds: ["ui"], brief: "Implement UI using a's contract; integrate and verify after API is ready.", dependsOn: uiDependsOn }
    ],
    review: { overlaps: ["Both claimed API; api-work alone owns API writes."], conflicts: ["Conflicting contracts resolved by api-work owning the contract; ui-work consumes it."], uncovered: ["Neither offered UI; ui-work owns UI and integration."] }
  };
}

test("a sole partial claimant owns the entire canonical request, not just its original offer", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => { throw new Error("must not split"); } });
  await h.create("a");
  const round = await h.service.submit({ ...request, userPrompt: "API and UI", namedActorIds: ["a"] });
  const work = h.starts[0].workItem;
  assert.equal(round.status, "awaiting_pickup");
  assert.equal(work.delegatedTask, undefined);
  assert.match(work.preparedPrompt!, /ENTIRE canonical request/);
  assert.deepEqual(work.canonicalUserMessages, ["API and UI"]);
  assert.deepEqual(work.requirementIds, ["whole-request"]);
  assert.equal(h.decisions.filter(d => d.purpose === "claim_tiebreak").length, 0);
  await h.service.settled();
});

const coverageDecide = (h: ReturnType<typeof harness>, choice: "covered" | "gaps") => {
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    const result = await decide(req);
    return result.ok && req.questions[0]?.id === "coverage" ? { ...result, answers: { coverage: { kind: "choice", choice, confidence: 0.9 } } } : result;
  };
};

test("a sole partial claim judged to cover the whole group request is assigned whole without adding actors", async () => {
  const h = harness({ respond: async ({ actor }) => actor.id === "a" ? partialReply : unrelatedReply, planClaims: async () => { throw new Error("must not split"); } });
  await h.create("a"); await h.create("b"); await h.create("c");
  coverageDecide(h, "covered");
  const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  assert.equal(round.ownerActorId, "a"); assert.equal(round.pickingHistory, undefined); assert.equal(round.coverageGap, undefined);
  const coverage = h.decisions.filter(d => d.audit.workItemId === `${round.id}:coverage`);
  assert.equal(coverage.length, 1); assert.equal(JSON.parse(coverage[0].state).claim.claimScope, "API only");
  assert.equal(h.starts.length, 1); assert.match(h.starts[0].workItem.preparedPrompt!, /ENTIRE canonical request/);
  assert.equal(round.replies.some(reply => reply.actorId === "c"), false);
  await h.service.settled();
});

test("a sole partial claim that excludes work adds stakeholders for the rest and splits between both claimants", async () => {
  // Iris (a) claims the blocker UI and excludes escalation dedup; the added stakeholder (b) takes that remainder.
  const iris = { ...partialReply, text: "I take the blocker UI; escalation dedup is not mine.", claimScope: "Includes blocker UI. Excludes: escalation dedup/merge backend and orchestration." };
  const seen: ActorRound[] = [];
  let plans = 0;
  const h = harness({ respond: async ({ actor, round }) => { seen.push(round); return actor.id === "a" ? iris : actor.id === "b" ? { ...partialReply, claimScope: "Escalation dedup/merge" } : unrelatedReply; },
    planClaims: async ({ round }) => { plans++; assert.deepEqual(round.replies.filter(r => r.status === "claimed").map(r => r.actorId).sort(), ["a", "b"]); return partialPlan([]); } });
  await h.create("a"); await h.create("c"); await h.create("b");
  coverageDecide(h, "gaps");
  const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "c"] });
  assert.equal(plans, 1); assert.equal(round.ownerActorId, null);
  assert.deepEqual(round.coverageGap, { actorId: "a", claimScope: iris.claimScope, repicked: true });
  assert.deepEqual(round.pickingHistory?.map(pass => pass.stakeholderIds), [["a", "c"]]);
  const repick = h.decisions.find(d => d.purpose === "sh_pick" && d.audit.workItemId === `${round.id}:picking:1`)!;
  const state = JSON.parse(repick.state);
  assert.deepEqual(state.coverageGaps, [{ actorId: "a", claimScope: iris.claimScope }]);
  assert.deepEqual(state.actors.map((actor: { id: string }) => actor.id), ["b"], "picking only considers actors who have not spoken");
  assert.equal(state.priorReports.find((r: { actorId: string }) => r.actorId === "a").claimScope, iris.claimScope);
  assert.ok(seen.some(r => r.coverageGap?.repicked && r.stakeholderIds.includes("b")), "the added actor sees why it was added");
  // The integration owner's session hosts the other assignment as a native child.
  const work = (await h.service.getRoom("ws")).workItems.filter(item => item.roundId === round.id);
  assert.deepEqual(work.map(item => item.ownerActorId).sort(), ["a", "b"]);
  assert.ok(work.every(item => item.delegatedTask && !/ENTIRE canonical request/.test(item.preparedPrompt!)));
  await h.service.settled();
});

test("a sole partial claim with gaps and no other taker executes only its scope and marks the rest unpicked", async () => {
  for (const pool of ["exhausted", "declined"] as const) {
    const h = harness({ respond: async ({ actor }) => actor.id === "a" ? partialReply : unrelatedReply, planClaims: async () => { throw new Error("must not split"); } });
    await h.create("a"); await h.create("b");
    if (pool === "declined") await h.create("c");
    coverageDecide(h, "gaps");
    const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    assert.equal(round.coverageGap?.uncovered, true, pool); assert.equal(round.coverageGap?.repicked, pool === "declined" ? true : undefined, pool);
    assert.equal(round.ownerActorId, "a", pool); assert.equal(h.starts.length, 1, pool);
    const work = h.starts[0].workItem;
    assert.doesNotMatch(work.preparedPrompt!, /ENTIRE canonical request/, pool);
    assert.match(work.preparedPrompt!, /Execute ONLY your claimed scope[\s\S]*Claimed scope: API only/, pool);
    assert.deepEqual(work.requirementIds, ["claimed-scope"], pool);
    assert.match(round.error!, /outside a's partial claim; that part remains unpicked/, pool);
    await h.service.observe(event("runner.runner.started", work.taskSessionId, work.taskTurnId, `started-${pool}`));
    const after = (await h.service.getRoom("ws")).rounds.find(r => r.id === round.id)!;
    assert.equal(after.status, "assigned", pool); assert.match(after.error!, /remains unpicked/, pool);
    await h.service.settled();
  }
});

test("full claims win over partial claims without invoking splitting or selecting partial models", async () => {
  const h = harness({ respond: async ({ actor }) => actor.id === "a" ? partialReply : { ...partialReply, claimKind: "full" },
    planClaims: async () => { throw new Error("must not split"); } });
  await h.create("a"); await h.create("b"); await h.create("c");
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b", "c"] });
  assert.equal(round.ownerActorId, "b"); assert.equal(h.starts.length, 1);
  assert.deepEqual(h.decisions.filter(d => d.purpose === "model_select").map(d => d.audit.workItemId), [`${round.id}:claim:b`]);
  assert.ok(h.decisions.some(d => d.purpose === "claim_tiebreak"));
  assert.equal(round.allocation, undefined);
  await h.service.settled();
});

const nativeSignal = (h: ReturnType<typeof harness>, host: { taskSessionId: string; taskTurnId: string }, name: string,
  phase: "started" | "completed" | "failed", agentId: string, timestamp: string, result?: string) =>
  h.service.observeNativeAgent({ workspaceId: "ws", sessionId: host.taskSessionId, turnId: host.taskTurnId, timestamp, signal: { name, agentId, phase, ...(result ? { result } : {}) } });

test("a partial split launches only its integration owner and waits for every native child's own start", async () => {
  let plans = 0;
  const h = harness({ respond: async () => partialReply });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  h.deps.planClaims = async ({ messages }) => { plans++; assert.deepEqual(messages, [input.userPrompt]); return partialPlan([]); };
  const round = await h.service.submit(input);
  assert.equal(round.status, "awaiting_pickup"); assert.equal(round.ownerActorId, null);
  assert.equal(round.allocation?.integrationAssignmentId, "api-work");
  assert.equal(h.starts.length, 1, "only the integration owner gets a task session"); assert.equal(round.workItemIds?.length, 2);
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  assert.equal(h.starts[0].workItem.id, host.id);
  assert.equal(child.hostWorkItemId, host.id);
  assert.equal(child.taskSessionId, host.taskSessionId); assert.equal(child.taskTurnId, host.taskTurnId);
  assert.equal(child.status, "assigned"); assert.equal(child.dispatched, true);
  assert.match(child.nativeAgent!.name, /^actor_ui_work_[a-z0-9]{6}$/); assert.equal(child.nativeAgent!.provider, "codex");
  assert.deepEqual([host, child].flatMap(w => w.requirementIds!), ["api", "ui"]);
  assert.match(child.delegatedTask!, /ui-work.*consumes/);
  assert.match(child.delegatedTask!, /API writes/);
  assert.match(child.delegatedTask!, /integration/);
  assert.ok([host, child].every(w => w.canonicalUserMessages?.[0] === input.userPrompt));
  assert.equal(h.decisions.filter(d => d.purpose === "claim_tiebreak").length, 0);
  await h.service.observe(event("runner.runner.started", host.taskSessionId, "wrong-turn", "wrong"));
  assert.equal((await h.service.getRoom("ws")).rounds[0].status, "awaiting_pickup");
  await h.service.observe(event("runner.runner.started", host.taskSessionId, host.taskTurnId, "first"));
  let room = await h.service.getRoom("ws");
  assert.equal(room.rounds[0].status, "awaiting_pickup", "the host's start is not its child's pickup");
  assert.equal(room.workItems[0].status, "started"); assert.equal(room.workItems[1].status, "assigned", "host events never change a child");
  await nativeSignal(h, host, "actor_unknown", "started", "toolu_x", "2026-10-22T22:00:30Z");
  assert.equal((await h.service.getRoom("ws")).rounds[0].status, "awaiting_pickup", "an unrelated sub-agent is not a child");
  await nativeSignal(h, host, child.nativeAgent!.name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  room = await h.service.getRoom("ws");
  assert.equal(room.rounds[0].status, "assigned");
  assert.equal(room.workItems[1].status, "started"); assert.ok(room.workItems[1].pickedUpAt);
  assert.equal(room.workItems[1].nativeAgent!.agentId, "toolu_1");
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(plans, 1); assert.equal(h.starts.length, 1);
  await assert.rejects(h.service.assign({ workspaceId: "ws", workItemId: child.id, executorActorId: "b", requestId: "move" }), /hosted split assignment/);
  await h.service.settled();
});

test("native child results complete their own work and the host review judges the integrated result", async () => {
  const reviews: Array<Parameters<NonNullable<DomainActorDependencies["reviewTask"]>>[0]> = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input); return { verdict: "passed", issues: [] }; } });
  h.store.taskOutcome = async () => ({ userPrompt: "API and UI all!", result: "API done; UI integrated and verified.", status: "done", runnerExitCode: 0 });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  await nativeSignal(h, host, child.nativeAgent!.name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, child.nativeAgent!.name, "completed", "toolu_1", "2026-10-22T22:02:00Z", "UI form built; tests pass.");
  await h.service.settled();
  let room = await h.service.getRoom("ws");
  assert.equal(room.workItems[1].status, "completed"); assert.equal(room.workItems[1].nativeAgent!.result, "UI form built; tests pass.");
  assert.equal(reviews[0].workItem.id, child.id); assert.equal(reviews[0].result, "UI form built; tests pass."); assert.equal(reviews[0].integration, undefined);
  assert.deepEqual(actorPublishableConclusions(room.workItems[1]).map(conclusion => conclusion.text), ["UI form built; tests pass."]);
  assert.ok(room.events.some(item => item.type === "task.turn_completed" && item.workItemId === child.id), "the child's actor memory sees its own result");
  await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, "host-done", "2026-10-22T22:05:00Z"));
  await h.service.settled();
  room = await h.service.getRoom("ws");
  assert.equal(room.workItems[1].status, "completed", "a finished child is not failed when the host turn ends");
  assert.equal(reviews[1].workItem.id, host.id);
  assert.deepEqual(reviews[1].integration, [{ allocationId: "ui-work", actorId: "b", execution: "native_subagent", status: "completed", result: "UI form built; tests pass.", error: null }]);
});

test("a passed model verdict cannot publish an integrated conclusion with unfinished or missing peer results", async () => {
  for (const peer of ["unfinished", "failed", "empty-result"] as const) {
    const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
      reviewTask: async () => ({ verdict: "passed", issues: [] }) });
    h.store.taskOutcome = async () => ({ userPrompt: "API and UI all!", result: "Everything done.", status: "done", runnerExitCode: 0 });
    await h.create("a"); await h.create("b");
    await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    const [host, child] = (await h.service.getRoom("ws")).workItems;
    await h.store.change("ws", room => {
      const work = room.workItems.find(item => item.id === child.id)!;
      work.status = peer === "unfinished" ? "started" : peer === "failed" ? "failed" : "completed";
      work.nativeAgent!.result = peer === "empty-result" ? "   " : undefined;
    });
    await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, `host-${peer}`, "2026-10-22T22:05:00Z"));
    await h.service.settled();
    const room = await h.service.getRoom("ws");
    const review = room.workItems[0].completionReviews![0];
    assert.equal(review.status, "issues_found", peer);
    assert.match(review.issues.join("\n"), /ui-work.*no completed saved result/);
    assert.equal(review.conclusion, undefined);
    assert.ok(!(room.conclusions ?? []).some(item => item.workItemId === host.id));
  }
});

test("a host turn ending before its child reports fails the child, a late result of that turn still completes it, and Stop reaches children", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]) });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  await nativeSignal(h, host, child.nativeAgent!.name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, "host-done", "2026-10-22T22:05:00Z"));
  let saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "failed"); assert.match(saved.dispatchError!, /turn ended before this native sub-agent reported/);
  await nativeSignal(h, host, child.nativeAgent!.name, "completed", "toolu_1", "2026-10-22T22:03:00Z", "Late but done.");
  saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "completed", "the result was produced inside that host turn"); assert.equal(saved.nativeAgent!.unfinishedTurnId, undefined);
  await h.service.settled();

  const stop = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]) });
  await stop.create("a"); await stop.create("b");
  await stop.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [stopHost, stopChild] = (await stop.service.getRoom("ws")).workItems;
  await nativeSignal(stop, stopHost, stopChild.nativeAgent!.name, "started", "toolu_2", "2026-10-22T22:01:00Z");
  await stop.service.observe({ ...event("runner.pending", stopHost.taskSessionId, stopHost.taskTurnId, "stopped", "2026-10-22T22:04:00Z"), payload: { stopped: true } });
  const stopped = (await stop.service.getRoom("ws")).workItems;
  assert.equal(stopped[0].stoppedAt, "2026-10-22T22:04:00Z"); assert.equal(stopped[1].stoppedAt, "2026-10-22T22:04:00Z");
  await stop.service.settled();
});

/** Rewrites a hosted split into the legacy one-session-per-assignment shape that in-flight rounds keep after upgrade. */
async function legacySplit(h: ReturnType<typeof harness>) {
  await h.store.change("ws", room => {
    const allocation = room.rounds.at(-1)!.allocation!;
    delete allocation.integrationAssignmentId;
    for (const work of room.workItems.filter(work => work.hostWorkItemId)) {
      // Legacy dispatch launched dependency-free work at once and held the rest.
      const held = Boolean(allocation.assignments.find(assignment => assignment.id === work.allocationId)?.dependsOn.length);
      delete work.hostWorkItemId; delete work.nativeAgent;
      work.dispatched = !held; work.status = held ? "claimed" : "assigned";
      work.taskSessionId = `tx_legacy_${work.id}`; work.taskTurnId = `legacy_turn_${work.id}`;
    }
  });
}

test("legacy dependent work waits for its blocker to end (complete, fail or stop) and launches exactly once", async () => {
  const ends = [
    (h: ReturnType<typeof harness>, s: string, t: string) => h.service.observe(event("runner.result", s, t, "api-done", "2026-10-22T22:05:00Z")),
    (h: ReturnType<typeof harness>, s: string, t: string) => h.service.observe(event("runner.error", s, t, "api-failed", "2026-10-22T22:05:00Z")),
    (h: ReturnType<typeof harness>, s: string, t: string) => h.service.observe({ ...event("runner.pending", s, t, "api-stopped", "2026-10-22T22:05:00Z"), payload: { stopped: true } })
  ];
  for (const end of ends) {
    const h = harness({ respond: async () => partialReply, planClaims: async () => ({ ...partialPlan(), integrationAssignmentId: "api-work" }) });
    await h.create("a"); await h.create("b");
    await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    await legacySplit(h);
    assert.equal(await h.service.resumeBlockedWork("ws"), 1, "startup recovery holds the legacy dependent");
    let [api, ui] = (await h.service.getRoom("ws")).workItems;
    assert.equal(h.starts.length, 1); assert.equal(h.starts[0].workItem.id, api.id);
    assert.equal(ui.status, "claimed"); assert.equal(ui.dispatched, false); assert.deepEqual(ui.blockedBy, [api.id]);
    await h.service.observe(event("runner.runner.started", api.taskSessionId, api.taskTurnId, "api-started"));
    assert.equal(h.starts.length, 1, "a running blocker keeps the dependent waiting");
    assert.match((await h.service.getRoom("ws")).rounds[0].error!, /waiting for the tasks it depends on/);
    await h.service.observe({ ...event("runner.pending", api.taskSessionId, api.taskTurnId, "usage-wait", "2026-10-22T22:01:00Z"), payload: { queued: true } });
    assert.equal(h.starts.length, 1, "a usage-limit requeue is not an end");
    await end(h, api.taskSessionId, api.taskTurnId);
    assert.equal(h.starts.length, 2); assert.equal(h.starts[1].workItem.id, ui.id);
    assert.equal(h.starts[1].sessionId, ui.taskSessionId, "the reserved task identity is reused");
    [api, ui] = (await h.service.getRoom("ws")).workItems;
    assert.equal(ui.dispatched, true); assert.equal(ui.blockedBy, undefined);
    await end(h, api.taskSessionId, api.taskTurnId);
    await h.service.observe(event("runner.result", api.taskSessionId, api.taskTurnId, "api-done-duplicate", "2026-10-22T22:06:00Z"));
    assert.equal(await h.service.resumeBlockedWork("ws"), 0);
    assert.equal(h.starts.length, 2, "duplicate end events and recovery never relaunch");
    await h.service.settled();
  }
});

test("legacy dependent work waits for every blocker and recovers an end event nobody observed", async () => {
  const plan = {
    requirements: [
      { id: "api", messageIndex: 0, start: 0, end: 4, description: "API" },
      { id: "ui", messageIndex: 0, start: 4, end: 7, description: "UI" },
      { id: "qa", messageIndex: 0, start: 7, end: 10, description: "QA" }
    ],
    assignments: [
      { id: "api-work", actorId: "a", requirementIds: ["api"], brief: "Implement API.", dependsOn: [] as string[] },
      { id: "ui-work", actorId: "b", requirementIds: ["ui"], brief: "Implement UI.", dependsOn: [] as string[] },
      { id: "qa-work", actorId: "c", requirementIds: ["qa"], brief: "Verify API and UI together.", dependsOn: ["api-work", "ui-work"] }
    ],
    review: { overlaps: [], conflicts: [], uncovered: [] }, integrationAssignmentId: "api-work"
  };
  const h = harness({ respond: async () => partialReply, planClaims: async () => plan });
  await h.create("a"); await h.create("b"); await h.create("c");
  await h.service.submit({ ...request, userPrompt: "API UI QA!", namedActorIds: ["a", "b", "c"] });
  await legacySplit(h);
  assert.equal(await h.service.resumeBlockedWork("ws"), 1, "startup recovery holds the legacy dependent");
  const [api, ui, qa] = (await h.service.getRoom("ws")).workItems;
  assert.equal(h.starts.length, 1); assert.deepEqual(qa.blockedBy, [api.id, ui.id]);
  await h.service.observe(event("runner.result", api.taskSessionId, api.taskTurnId, "api-done"));
  assert.equal(h.starts.length, 1, "one remaining blocker keeps the dependent waiting");
  assert.deepEqual((await h.service.getRoom("ws")).workItems[2].blockedBy, [ui.id]);
  // The blocker ends while no process observes it (for example, the API restarted).
  await h.store.change("ws", room => { const item = room.workItems.find(item => item.id === ui.id)!; item.status = "completed"; item.lastEventAt = "2026-10-22T22:10:00Z"; });
  assert.equal(h.starts.length, 1);
  assert.equal(await h.service.resumeBlockedWork("ws"), 1);
  assert.equal(h.starts.length, 2); assert.equal(h.starts[1].workItem.id, qa.id);
  assert.equal(await h.service.resumeBlockedWork("ws"), 0); assert.equal(h.starts.length, 2);
  await h.service.settled();
});

test("invalid partial partitions never dispatch: missing scope, duplicate ownership, conflicts and dependencies", async () => {
  const mutations = [
    (p: ReturnType<typeof partialPlan>) => { p.requirements[1].end--; },
    (p: ReturnType<typeof partialPlan>) => { p.assignments[1].requirementIds = []; },
    (p: ReturnType<typeof partialPlan>) => { p.assignments[1].requirementIds.push("api"); },
    (p: ReturnType<typeof partialPlan>) => { p.requirements[1].start--; },
    (p: ReturnType<typeof partialPlan>) => { p.assignments[0].dependsOn = ["ui-work"]; },
    (p: ReturnType<typeof partialPlan>) => { p.assignments[1].actorId = "absent"; },
    (p: ReturnType<typeof partialPlan>) => { delete (p as Partial<typeof p>).review; }
  ];
  for (const mutate of mutations) {
    const h = harness({ respond: async () => partialReply, planClaims: async () => { const plan = partialPlan(); mutate(plan); return plan; } });
    await h.create("a"); await h.create("b");
    const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    assert.equal(round.status, "routing_failed"); assert.match(round.error!, /all work remains unpicked/);
    assert.equal(h.starts.length, 0); assert.equal((await h.service.getRoom("ws")).workItems.length, 0);
    await h.service.settled();
  }
});

test("a refused or uncertain host launch retains every assignment and a retry relaunches the reserved host with its children", async () => {
  for (const failure of ["refusal", "transport"]) {
    const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]) });
    await h.create("a"); await h.create("b");
    const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
    h.deps.startTask = async start => { h.starts.push(start); throw new Error(failure); };
    const round = await h.service.submit(input);
    const before = (await h.service.getRoom("ws")).workItems;
    assert.equal(round.status, "awaiting_pickup"); assert.equal(before.length, 2);
    assert.equal(before[0].status, "failed"); assert.match(before[0].dispatchError!, /unpicked/);
    assert.ok(before[0].dispatchError!.includes(failure), "retain the adapter failure so refusal and transport errors are distinguishable");
    assert.equal(before[1].status, "claimed"); assert.equal(before[1].dispatched, false, "a child never starts without its host");
    h.deps.startTask = async start => { h.starts.push(start); return { sessionId: start.sessionId, turnId: start.turnId }; };
    const resumed = await new DomainActorService(h.store, h.deps).submit(input);
    assert.equal(resumed.status, "awaiting_pickup", "retry queue receipt is not pickup");
    assert.equal(h.starts.length, 2); assert.equal(h.starts[1].sessionId, before[0].taskSessionId);
    assert.equal(h.starts[1].turnId, before[0].taskTurnId);
    const after = (await h.service.getRoom("ws")).workItems;
    assert.equal(after[1].status, "assigned"); assert.equal(after[1].dispatched, true);
    await h.service.observe(event("runner.runner.started", before[0].taskSessionId, before[0].taskTurnId, "recovered"));
    await nativeSignal(h, before[0], before[1].nativeAgent!.name, "started", "toolu_1", "2026-10-22T22:01:00Z");
    assert.equal((await h.service.getRoom("ws")).rounds[0].status, "assigned");
    await h.service.settled();
  }
});

test("a permission change before partial dispatch blocks the child before its host starts and a retry after restoring it recovers the child", async () => {
  const updates: Array<Parameters<NonNullable<DomainActorDependencies["updateTask"]>>[0]> = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: async input => { updates.push(input); } });
  await h.create("a"); await h.create("b");
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    const result = await decide(req);
    if (req.audit.workItemId?.endsWith(":b")) await h.service.updateActor("ws", "b", { model: MODEL_CATALOG.claudeHaiku.id, allowedModels: [MODEL_CATALOG.claudeHaiku.id] });
    return result;
  };
  const childAtLaunch: string[] = [];
  h.deps.startTask = async start => {
    h.starts.push(start);
    // The host runner reads the room when its turn starts; the child must already be closed then.
    childAtLaunch.push((await h.service.getRoom("ws")).workItems[1].status);
    return { sessionId: start.sessionId, turnId: start.turnId };
  };
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  const round = await h.service.submit(input);
  let works = (await h.service.getRoom("ws")).workItems;
  assert.equal(round.status, "awaiting_pickup"); assert.equal(works.length, 2); assert.equal(h.starts.length, 1);
  assert.deepEqual(childAtLaunch, ["failed"]);
  assert.equal(works[1].dispatched, false);
  assert.match(works[1].dispatchError!, /permission changed.*unpicked/);
  assert.deepEqual(works[1].requirementIds, ["ui"]);
  assert.equal(updates.length, 0);

  h.deps.decide = decide;
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(updates.length, 0, "a retry while permission is still missing keeps the child unpicked");
  assert.match((await h.service.getRoom("ws")).workItems[1].dispatchError!, /permission changed/);

  await h.service.updateActor("ws", "b", { model: works[1].model, allowedModels: [works[1].model] });
  await new DomainActorService(h.store, h.deps).submit(input);
  works = (await h.service.getRoom("ws")).workItems;
  assert.equal(h.starts.length, 1, "the running host is never relaunched");
  assert.equal(works[1].status, "assigned"); assert.equal(works[1].dispatched, true); assert.equal(works[1].dispatchError, null);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].workItem.id, works[0].id); assert.match(updates[0].requestId, /^native-recover:/);
  assert.match(updates[0].userPrompt, new RegExp(`Start its sub-agent ${works[1].nativeAgent!.name}`));
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(updates.length, 1, "a recovered child is not queued twice");
  await h.service.settled();
});

/** Emulates updateTask's idempotent turn: the same request and prompt never queue a second turn. */
function recoveryQueue(failures: Array<"offline" | "lost-receipt"> = []) {
  const turns = new Map<string, string>(), calls: string[] = [];
  const updateTask: NonNullable<DomainActorDependencies["updateTask"]> = async input => {
    calls.push(input.requestId);
    const failure = failures.shift();
    if (failure === "offline") throw new Error("queue offline");
    const existing = turns.get(input.requestId);
    if (existing !== undefined && existing !== input.userPrompt) throw new Error("Task update request ID was reused with different input.");
    turns.set(input.requestId, input.userPrompt);
    if (failure === "lost-receipt") throw new Error("receipt lost");
  };
  return { turns, calls, updateTask };
}
const permissionLost = async (h: ReturnType<typeof harness>) => {
  await h.store.change("ws", room => { const child = room.workItems[1]; child.status = "failed"; child.dispatched = false; child.dispatchError = "Owner or executor model permission changed before this native sub-agent could start. Work remains unpicked; restore permissions before retrying this request."; });
};

test("an unconfirmed recovery keeps its saved request and a retry after a lost receipt never queues a second host turn", async () => {
  const queue = recoveryQueue(["offline", "lost-receipt"]);
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  await permissionLost(h);
  for (const expected of [/queue offline.*resends the same recovery turn/, /receipt lost.*resends the same recovery turn/]) {
    await new DomainActorService(h.store, h.deps).submit(input);
    const child = (await h.service.getRoom("ws")).workItems[1];
    assert.equal(child.status, "assigned"); assert.equal(child.dispatched, false, "an unconfirmed recovery stays retryable");
    assert.equal(child.nativeAgent!.recovery!.status, "pending"); assert.match(child.dispatchError!, expected);
  }
  await new DomainActorService(h.store, h.deps).submit(input);
  const child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(new Set(queue.calls).size, 1, "every resend reuses the saved request ID"); assert.equal(queue.calls.length, 3);
  assert.equal(queue.turns.size, 1, "the lost receipt's turn is reused, never duplicated");
  assert.equal(child.nativeAgent!.recovery!.status, "queued"); assert.equal(child.dispatched, true); assert.equal(child.dispatchError, null);
  await h.service.settled();
});

test("a crash after reserving a recovery resends that saved recovery on retry", async () => {
  const queue = recoveryQueue();
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  // The process stopped after the reservation write and before any queue call.
  await h.store.change("ws", room => { const child = room.workItems[1]; child.status = "assigned"; child.dispatched = false; child.dispatchError = null;
    child.nativeAgent!.recovery = { requestId: "native-recover:saved", userPrompt: "Saved recovery prompt", status: "pending", turnId: "saved-recovery-turn" }; });
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.deepEqual(queue.calls, ["native-recover:saved"]); assert.equal(queue.turns.get("native-recover:saved"), "Saved recovery prompt");
  assert.equal((await h.service.getRoom("ws")).workItems[1].nativeAgent!.recovery!.status, "queued");
  await h.service.settled();
});

test("a child revoked after its host was queued but before the runner defined it is recovered by a retry after restoring it", async () => {
  const queue = recoveryQueue();
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  let [host, child] = (await h.service.getRoom("ws")).workItems;
  assert.equal(child.dispatched, true, "the host receipt carried the permitted child");
  const model = child.model;
  await h.service.updateActor("ws", "b", { model: MODEL_CATALOG.claudeHaiku.id, allowedModels: [MODEL_CATALOG.claudeHaiku.id] });
  // The host runner then omitted the child; its turn ends without a start signal.
  await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, "host-done", "2026-10-22T22:05:00Z"));
  child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(child.status, "failed"); assert.equal(child.dispatched, false); assert.match(child.dispatchError!, /permission changed/);
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(queue.calls.length, 0, "no recovery while the permission is still missing");
  await h.service.updateActor("ws", "b", { model, allowedModels: [model] });
  await new DomainActorService(h.store, h.deps).submit(input);
  [host, child] = (await h.service.getRoom("ws")).workItems;
  assert.equal(queue.turns.size, 1); assert.equal(child.status, "assigned"); assert.equal(child.dispatched, true);
  await h.service.settled();
});

test("only the recovery's own host turn claims and settles it; earlier queued turns never consume it", async () => {
  const queue = recoveryQueue();
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  const [host] = (await h.service.getRoom("ws")).workItems;
  await permissionLost(h);
  await new DomainActorService(h.store, h.deps).submit(input);
  let child = (await h.service.getRoom("ws")).workItems[1];
  const recovery = child.nativeAgent!.recovery!;
  assert.equal(recovery.turnId, actorFollowupTurnId("ws", host.id, recovery.requestId), "the reserved turn is updateTask's idempotent turn");
  // The turn already running, and an ordinary turn queued before the recovery, both start and end first.
  await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, "earlier-turn-done", "2026-10-22T22:05:00Z"));
  await h.service.claimNativeRecoveries("ws", host.id, "ordinary-turn");
  await h.service.observe(event("runner.result", host.taskSessionId, "ordinary-turn", "ordinary-done", "2026-10-22T22:06:00Z"));
  child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(child.status, "assigned", "no other turn settles the recovery"); assert.deepEqual(child.nativeAgent!.recovery, { ...recovery, status: "queued" });
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(queue.turns.size, 1, "the original recovery turn is still the only one");
  await h.service.claimNativeRecoveries("ws", host.id, recovery.turnId);
  await h.service.observe(event("runner.result", host.taskSessionId, recovery.turnId, "recovery-done", "2026-10-22T22:09:00Z"));
  child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(child.status, "failed"); assert.equal(child.dispatched, false, "a recovery turn that never started the child leaves it retryable");
  assert.equal(child.nativeAgent!.recovery, undefined);
  await h.service.settled();
});

test("a child revoked again after its recovery was queued becomes retryable once its recovery turn ends", async () => {
  const queue = recoveryQueue();
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  const [host] = (await h.service.getRoom("ws")).workItems;
  const model = (await h.service.getRoom("ws")).workItems[1].model;
  await permissionLost(h);
  await new DomainActorService(h.store, h.deps).submit(input);
  let child = (await h.service.getRoom("ws")).workItems[1];
  const first = child.nativeAgent!.recovery!;
  assert.equal(first.status, "queued"); assert.equal(child.dispatched, true);
  await h.service.updateActor("ws", "b", { model: MODEL_CATALOG.claudeHaiku.id, allowedModels: [MODEL_CATALOG.claudeHaiku.id] });
  await h.service.claimNativeRecoveries("ws", host.id, first.turnId);
  await h.service.observe(event("runner.result", host.taskSessionId, first.turnId, "recovery-done", "2026-10-22T22:09:00Z"));
  child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(child.status, "failed"); assert.equal(child.dispatched, false); assert.match(child.dispatchError!, /permission changed/);
  assert.equal(child.nativeAgent!.recovery, undefined);
  await h.service.updateActor("ws", "b", { model, allowedModels: [model] });
  await new DomainActorService(h.store, h.deps).submit(input);
  child = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(queue.turns.size, 2, "a fresh recovery is queued after restoring the permission");
  assert.notEqual(child.nativeAgent!.recovery!.requestId, first.requestId); assert.equal(child.dispatched, true);
  await h.service.settled();
});

test("Codex rework on the same child thread is reviewed as a new run and a late stale verdict never publishes", async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => {
      reviews.push(input.result);
      if (input.result === "API v1.") { await firstHeld; return { verdict: "passed", issues: [] }; }
      return { verdict: "issues_found", issues: ["Pagination is missing."] };
    } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API v1.");
  // send_input reruns the same thread: it reports running, then a new result.
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:03:00Z");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:04:00Z", "API v2.");
  while ((await h.service.getRoom("ws")).workItems[1].completionReviews?.filter(review => review.status === "issues_found").length !== 1)
    await new Promise(resolve => setTimeout(resolve, 5));
  releaseFirst();
  await h.service.settled();
  const room = await h.service.getRoom("ws");
  const saved = room.workItems[1];
  assert.deepEqual(reviews, ["API v1.", "API v2."], "each result of the same thread gets its own review");
  assert.equal(saved.completionReviews!.length, 2); assert.equal(new Set(saved.completionReviews!.map(review => review.nativeRunId)).size, 2);
  assert.deepEqual(actorPublishableConclusions(saved), [], "the stale passed review of the first run is not publishable");
  assert.ok(!(room.conclusions ?? []).some(conclusion => conclusion.workItemId === saved.id));
});

test("a late passed review of a superseded native run never publishes over the rework's verdict", async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => {
      if (input.result === "Form built.") { await firstHeld; return { verdict: "passed", issues: [] }; }
      return { verdict: "issues_found", issues: ["The label is still wrong."] };
    } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00Z", "Form built.");
  await nativeSignal(h, host, name, "started", "toolu_2", "2026-10-22T22:03:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:04:00Z", "Form rebuilt.");
  while (!(await h.service.getRoom("ws")).workItems[1].completionReviews?.some(review => review.status === "issues_found"))
    await new Promise(resolve => setTimeout(resolve, 5));
  releaseFirst();
  await h.service.settled();
  const room = await h.service.getRoom("ws");
  const saved = room.workItems[1];
  assert.equal(saved.completionReviews!.filter(review => review.status === "passed").length, 1, "the stale verdict is kept as history");
  assert.deepEqual(actorPublishableConclusions(saved), [], "only the current run's review can publish");
  assert.ok(!(room.conclusions ?? []).some(conclusion => conclusion.workItemId === saved.id), "no stale conclusion reaches the actor dialog");
});

test("a same-thread restart opens a new run at once, so a stale verdict cannot publish while the rework runs; redelivered starts stay idempotent", async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async () => { await firstHeld; return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:05Z");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API v1.");
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:03:00Z");
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:03:05Z");
  releaseFirst();
  await h.service.settled();
  const room = await h.service.getRoom("ws");
  const saved = room.workItems[1];
  assert.equal(saved.status, "started", "the rework start is recorded, not deduplicated"); assert.equal(saved.nativeAgent!.runId, "run-2");
  assert.equal(room.events.filter(item => item.workItemId === child.id && item.type === "task.started").length, 2, "redelivered starts of a running run are ignored");
  assert.equal(saved.completionReviews![0].status, "passed");
  assert.deepEqual(actorPublishableConclusions(saved), [], "run-1's passed verdict cannot publish during run-2");
  assert.ok(!(room.conclusions ?? []).some(conclusion => conclusion.workItemId === child.id));
});

test("two runs on one thread with identical text each get their own completion and review", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  for (const [start, end] of [["22:01", "22:02"], ["22:03", "22:04"]]) {
    await nativeSignal(h, host, name, "started", "thread-ui", `2026-10-22T${start}:00Z`);
    await nativeSignal(h, host, name, "completed", "thread-ui", `2026-10-22T${end}:00Z`, "API ready.");
  }
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:05:00Z", "API ready.");
  await h.service.settled();
  const room = await h.service.getRoom("ws");
  const saved = room.workItems[1];
  assert.deepEqual(reviews, ["API ready.", "API ready."], "a redelivered completion of the ended run adds no review");
  assert.deepEqual(saved.completionReviews!.map(review => review.nativeRunId), ["run-1", "run-2"]);
  assert.equal(room.events.filter(item => item.workItemId === child.id && item.type === "task.turn_completed").length, 2);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.reviewId), [saved.completionReviews![1].id]);
});

test("an empty completion leaves the run result-pending until its result arrives, and a late empty completion never replaces the run", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  // Codex activity reports completion before the collab state carries the message.
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z");
  let saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "completed"); assert.equal(saved.nativeAgent!.resultPending, true);
  await h.service.settled();
  assert.deepEqual(reviews, [], "no review of an empty result");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:01Z", "API ready.");
  await h.service.settled();
  saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.resultPending, undefined); assert.equal(saved.nativeAgent!.runId, "run-1", "the result attaches to the same run");
  assert.deepEqual(reviews, ["API ready."]);
  // A late activity completion without a result after the real one.
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:03:00Z");
  await h.service.settled();
  saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-1"); assert.equal(saved.nativeAgent!.result, "API ready.");
  assert.deepEqual(reviews, ["API ready."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API ready."]);
});

test("a recovery saved without its turn ID, or with a claiming turn's ID, is repaired from its saved request on load", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]) });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host] = (await h.service.getRoom("ws")).workItems;
  const expected = actorFollowupTurnId("ws", host.id, "native-recover:legacy");
  for (const legacy of [{ requestId: "native-recover:legacy", userPrompt: "Recover", status: "queued" }, { requestId: "native-recover:legacy", userPrompt: "Recover", status: "queued", turnId: "claiming-turn" }]) {
    // Raw persisted JSON as an earlier version saved it.
    const raw = h.rooms.get("ws")!;
    (raw.workItems[1].nativeAgent as Record<string, unknown>).recovery = legacy;
    raw.workItems[1].dispatched = true; raw.workItems[1].status = "assigned";
    assert.equal((await h.service.getRoom("ws")).workItems[1].nativeAgent!.recovery!.turnId, expected);
    await h.service.observe(event("runner.result", host.taskSessionId, expected, `legacy-${legacy.turnId ?? "none"}`, "2026-10-22T22:09:00Z"));
    const child = (await h.service.getRoom("ws")).workItems[1];
    assert.equal(child.dispatched, false, "its own recovery turn settles the repaired recovery"); assert.equal(child.nativeAgent!.recovery, undefined);
  }
});

test("a start replayed after its run completed, even by a restarted service, never opens a new run", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), reviewTask: async () => ({ verdict: "passed", issues: [] }) });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  for (const agentId of ["thread-ui"]) {
    await nativeSignal(h, host, name, "started", agentId, "2026-10-22T22:01:00Z");
    await nativeSignal(h, host, name, "completed", agentId, "2026-10-22T22:02:00Z", "API ready.");
  }
  const restarted = new DomainActorService(h.store, h.deps);
  for (const service of [h.service, restarted]) {
    await service.observeNativeAgent({ workspaceId: "ws", sessionId: host.taskSessionId, turnId: host.taskTurnId, timestamp: "2026-10-22T22:01:00Z",
      signal: { name, agentId: "thread-ui", phase: "started" } });
  }
  await h.service.settled(); await restarted.settled();
  const room = await h.service.getRoom("ws");
  const saved = room.workItems[1];
  assert.equal(saved.status, "completed"); assert.equal(saved.nativeAgent!.runId, "run-1"); assert.equal(saved.nativeAgent!.runSeq, 1);
  assert.equal(room.events.filter(item => item.workItemId === child.id && item.type === "task.started").length, 1);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API ready."]);
});

test("replaying the first run's result after a second run completed never becomes a third run", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API v1.");
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:03:00Z");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:04:00Z", "API v2.");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API v1.");
  await nativeSignal(h, host, name, "failed", "thread-ui", "2026-10-22T22:01:30Z");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-2"); assert.equal(saved.nativeAgent!.result, "API v2."); assert.equal(saved.status, "completed");
  assert.deepEqual(reviews, ["API v1.", "API v2."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API v2."]);
  // A genuinely new result after the run ended, without an observed start, is still a new run.
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:06:00Z", "API v3.");
  await h.service.settled();
  assert.equal((await h.service.getRoom("ws")).workItems[1].nativeAgent!.runId, "run-3");
});

test("a child already running before run sequences existed completes as run-1 without colliding with its earlier review", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  // Raw state an earlier version saved: a rerun in progress, holding the previous run's hash key and review.
  const raw = h.rooms.get("ws")!.workItems[1];
  Object.assign(raw.nativeAgent!, { agentId: "thread-ui", startedAt: "2026-10-22T22:03:00Z", runId: "a1b2c3", result: undefined });
  raw.status = "started"; raw.activeTurnId = host.taskTurnId;
  raw.completionReviews = [{ id: "review:legacy", workItemId: child.id, actorId: "b", ownerActorId: "b", roundId: child.roundId, taskSessionId: host.taskSessionId,
    taskTurnId: host.taskTurnId, executionRevision: 0, nativeRunId: "a1b2c3", status: "passed", issues: [], created: "2026-10-22T22:02:30Z" }];
  await nativeSignal(h, host, child.nativeAgent!.name, "completed", "thread-ui", "2026-10-22T22:04:00Z", "API v2.");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-1"); assert.deepEqual(reviews, ["API v2."], "the new result gets its own review");
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API v2."]);
});

test("a completion's run transition and event are one write, and a redelivery reviews a result whose review never started", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  // A process that stopped right after the completion write, before launching the review.
  const writes: Array<{ status: string; completedEvent: boolean }> = [];
  const change = h.store.change.bind(h.store);
  h.store.change = (async (workspaceId: string, mutate: (room: ActorRoom) => unknown) => {
    const result = await change(workspaceId, mutate as never);
    const saved = h.rooms.get(workspaceId)!;
    writes.push({ status: saved.workItems[1].status, completedEvent: saved.events.some(item => item.id === `native:${child.id}:run-1:completed`) });
    return result;
  }) as typeof h.store.change;
  const review = h.service["reviewNativeRun"].bind(h.service);
  h.service["reviewNativeRun"] = () => {};
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
  assert.deepEqual(writes[0], { status: "completed", completedEvent: true }, "status and event land together");
  assert.equal((await h.service.getRoom("ws")).workItems[1].completionReviews, undefined);
  h.service["reviewNativeRun"] = review;
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
  await h.service.settled();
  assert.deepEqual(reviews, ["API ready."], "the redelivered completion starts the missing review");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
  await h.service.settled();
  assert.deepEqual(reviews, ["API ready."], "an existing review is never repeated");
});

test("a new Claude run in the same millisecond as the previous run's end is kept, and an old agent's replay is not", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form built.");
  await nativeSignal(h, host, name, "started", "toolu_2", "2026-10-22T22:02:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:03:00.000Z", "Form rebuilt.");
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:04:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:04:30.000Z", "Form built.");
  // An unseen agent whose start was missed still counts, even at the previous end's millisecond.
  await nativeSignal(h, host, name, "completed", "toolu_3", "2026-10-22T22:03:00.000Z", "Form polished.");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-3"); assert.equal(saved.nativeAgent!.result, "Form polished.");
  assert.deepEqual(saved.nativeAgent!.agentIds, ["toolu_1", "toolu_2", "toolu_3"]);
  assert.deepEqual(reviews, ["Form built.", "Form rebuilt.", "Form polished."], "replays of toolu_1 add no run or review");
});

test("a half-written completion from an earlier version is completed and reviewed by its redelivery", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  // An earlier version saved the run end and result, then stopped before its event write.
  Object.assign(h.rooms.get("ws")!.workItems[1].nativeAgent!, { endedAt: "2026-10-22T22:02:00Z", result: "API ready." });
  assert.equal((await h.service.getRoom("ws")).workItems[1].status, "started");
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
  await h.service.settled();
  const room = await h.service.getRoom("ws");
  assert.equal(room.workItems[1].status, "completed");
  assert.ok(room.events.some(item => item.id === `native:${child.id}:run-1:completed`));
  assert.deepEqual(reviews, ["API ready."]);
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
  await h.service.settled();
  assert.deepEqual(reviews, ["API ready."], "a repaired run is not repaired or reviewed again");
});

test("a half-written completion survives its host turn ending first, and data already misread as unstarted is repaired by redelivery", async () => {
  for (const legacySettle of [false, true]) {
    const reviews: string[] = [];
    const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
      reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
    await h.create("a"); await h.create("b");
    await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    const [host, child] = (await h.service.getRoom("ws")).workItems;
    const name = child.nativeAgent!.name;
    await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
    Object.assign(h.rooms.get("ws")!.workItems[1].nativeAgent!, { endedAt: "2026-10-22T22:02:00Z", result: "API ready." });
    if (legacySettle) {
      // What an earlier settle wrote: the half-written run misread as never started.
      const raw = h.rooms.get("ws")!;
      Object.assign(raw.workItems[1], { status: "failed", dispatched: false, lastEventAt: "2026-10-22T22:05:00Z",
        dispatchError: "The host session turn ended without starting this native sub-agent. Retry this request to run it in a host turn." });
      raw.events.push({ id: `native:${child.id}:unfinished:${host.taskTurnId}`, workspaceId: "ws", actorIds: ["b"], workItemId: child.id, roundId: child.roundId,
        type: "task.failed", taskSessionId: host.taskSessionId, taskTurnId: host.taskTurnId, summary: "unstarted", created: "2026-10-22T22:05:00Z" });
      await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:00Z", "API ready.");
    } else {
      await h.service.observe(event("runner.result", host.taskSessionId, host.taskTurnId, "host-done", "2026-10-22T22:05:00Z"));
    }
    await h.service.settled();
    const room = await h.service.getRoom("ws");
    const saved = room.workItems[1];
    assert.equal(saved.status, "completed", `legacySettle=${legacySettle}`); assert.equal(saved.dispatched, true); assert.equal(saved.dispatchError, null);
    assert.ok(room.events.some(item => item.id === `native:${child.id}:run-1:completed`));
    assert.deepEqual(reviews, ["API ready."]);
    assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API ready."]);
  }
});

test("a forgotten earlier agent's replay never displaces the current run", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00Z", "Form v1.");
  await nativeSignal(h, host, name, "started", "toolu_2", "2026-10-22T22:10:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:11:00Z", "Form v2.");
  // The bounded history (or a legacy room seeded with only the current ID) no longer remembers toolu_1.
  h.rooms.get("ws")!.workItems[1].nativeAgent!.agentIds = ["toolu_2"];
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00Z", "Form v1.");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-2"); assert.equal(saved.nativeAgent!.result, "Form v2.");
  assert.deepEqual(reviews, ["Form v1.", "Form v2."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["Form v2."]);
});

test("a forgotten agent's replay stamped exactly at the current run's start never displaces it", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form v1.");
  // The next run starts in the very millisecond the previous one ended.
  await nativeSignal(h, host, name, "started", "toolu_2", "2026-10-22T22:02:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:03:00.000Z", "Form v2.");
  h.rooms.get("ws")!.workItems[1].nativeAgent!.agentIds = ["toolu_2"];
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form v1.");
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-2"); assert.equal(saved.nativeAgent!.result, "Form v2.");
  assert.deepEqual(reviews, ["Form v1.", "Form v2."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["Form v2."]);
});

test("a result arriving for an empty completion that an earlier settle misread restores dispatch, so a retry queues no recovery", async () => {
  const queue = recoveryQueue();
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), updateTask: queue.updateTask,
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  const input = { ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] };
  await h.service.submit(input);
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "thread-ui", "2026-10-22T22:01:00Z");
  // An earlier version saved an empty completion without its event; its host turn end then misread the run.
  const raw = h.rooms.get("ws")!;
  Object.assign(raw.workItems[1].nativeAgent!, { endedAt: "2026-10-22T22:02:00Z", resultPending: true });
  Object.assign(raw.workItems[1], { status: "failed", dispatched: false, lastEventAt: "2026-10-22T22:05:00Z",
    dispatchError: "The host session turn ended without starting this native sub-agent. Retry this request to run it in a host turn." });
  raw.events.push({ id: `native:${child.id}:unfinished:${host.taskTurnId}`, workspaceId: "ws", actorIds: ["b"], workItemId: child.id, roundId: child.roundId,
    type: "task.failed", taskSessionId: host.taskSessionId, taskTurnId: host.taskTurnId, summary: "unstarted", created: "2026-10-22T22:05:00Z" });
  await nativeSignal(h, host, name, "completed", "thread-ui", "2026-10-22T22:02:01Z", "API ready.");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "completed"); assert.equal(saved.dispatched, true); assert.equal(saved.dispatchError, null);
  assert.deepEqual(reviews, ["API ready."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["API ready."]);
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(queue.calls.length, 0, "a finished child is never re-queued by a retry");
  await h.service.settled();
});

test("a run whose start was missed does not swallow the next agent starting in its completion's millisecond", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form v1.");
  // toolu_2's start was missed; its completion opens and ends its run in one millisecond.
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:03:00.000Z", "Form v2.");
  let saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.startMissed, true); assert.equal(saved.nativeAgent!.startedAt, saved.nativeAgent!.endedAt);
  await nativeSignal(h, host, name, "started", "toolu_3", "2026-10-22T22:03:00.000Z");
  saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "started"); assert.equal(saved.nativeAgent!.runId, "run-3"); assert.equal(saved.nativeAgent!.startMissed, false);
  assert.deepEqual(actorPublishableConclusions(saved), [], "the superseded run's verdict stops publishing once the next run starts");
  await nativeSignal(h, host, name, "completed", "toolu_3", "2026-10-22T22:04:00.000Z", "Form v3.");
  // A forgotten agent stamped at an observed start's millisecond is still a replay.
  h.rooms.get("ws")!.workItems[1].nativeAgent!.agentIds = ["toolu_3"];
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:03:00.000Z", "Form v2.");
  await h.service.settled();
  saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-3"); assert.equal(saved.nativeAgent!.result, "Form v3.");
  assert.deepEqual(reviews, ["Form v1.", "Form v2.", "Form v3."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text), ["Form v3."]);
});

test("a missed-start run saved without its flag is recognised on load, so a same-millisecond start after a restart is a new run", async () => {
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), reviewTask: async () => ({ verdict: "passed", issues: [] }) });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form v1.");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:03:00.000Z", "Form v2.");
  await h.service.settled();
  // An earlier version saved this missed-start run without the flag.
  delete h.rooms.get("ws")!.workItems[1].nativeAgent!.startMissed;
  const restarted = new DomainActorService(h.store, h.deps);
  await restarted.observeNativeAgent({ workspaceId: "ws", sessionId: host.taskSessionId, turnId: host.taskTurnId, timestamp: "2026-10-22T22:03:00.000Z",
    signal: { name, agentId: "toolu_3", phase: "started" } });
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "started"); assert.equal(saved.nativeAgent!.runId, "run-3");
  assert.deepEqual(actorPublishableConclusions(saved), []);
  await restarted.settled();
});

test("while the current run's start was missed, a forgotten run's terminal replay in its millisecond is not a new run", async () => {
  const reviews: string[] = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input.result); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00.000Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00.000Z", "Form v1.");
  // toolu_2's start was missed and it failed in the millisecond toolu_1 completed.
  await nativeSignal(h, host, name, "failed", "toolu_2", "2026-10-22T22:02:00.000Z");
  h.rooms.get("ws")!.workItems[1].nativeAgent!.agentIds = ["toolu_2"];
  const saved0 = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved0.nativeAgent!.startMissed, true); assert.equal(saved0.nativeAgent!.runId, "run-2");
  assert.equal(saved0.nativeAgent!.startedAt, "2026-10-22T22:02:00.000Z");
  for (const phase of ["completed", "failed"] as const) {
    await nativeSignal(h, host, name, phase, "toolu_1", "2026-10-22T22:02:00.000Z", phase === "completed" ? "Form v1." : undefined);
  }
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.nativeAgent!.runId, "run-2", "the replays open no run"); assert.equal(saved.status, "failed");
  assert.deepEqual(reviews, ["Form v1."]);
  assert.deepEqual(actorPublishableConclusions(saved), [], "toolu_1's old result is not republished");
});

test("an observed start that fails in its own millisecond is never reclassified as missed, so a forgotten agent's start replay stays ignored", async () => {
  for (const legacy of ["current", "missing", "persisted-true"] as const) {
    const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]), reviewTask: async () => ({ verdict: "passed", issues: [] }) });
    await h.create("a"); await h.create("b");
    await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
    const [host, child] = (await h.service.getRoom("ws")).workItems;
    const name = child.nativeAgent!.name;
    // B starts at T and its Agent card is declined in that same millisecond; the snapshot remembers only B.
    const T = "2026-10-22T22:01:00.000Z";
    await nativeSignal(h, host, name, "started", "toolu_b", T);
    await nativeSignal(h, host, name, "failed", "toolu_b", T);
    const raw = h.rooms.get("ws")!.workItems[1].nativeAgent!;
    assert.equal(raw.startedAt, raw.endedAt);
    // An earlier version saved no flag at all, or its time-only rule persisted a wrong `true`.
    if (legacy === "missing") delete raw.startMissed;
    if (legacy === "persisted-true") raw.startMissed = true;
    const restarted = new DomainActorService(h.store, h.deps);
    const loaded = (await restarted.getRoom("ws")).workItems[1];
    assert.equal(loaded.nativeAgent!.startMissed, false, `legacy=${legacy}: the recorded start keeps it observed`);
    // A started in that millisecond too; its start is replayed after the restart.
    await restarted.observeNativeAgent({ workspaceId: "ws", sessionId: host.taskSessionId, turnId: host.taskTurnId, timestamp: T,
      signal: { name, agentId: "toolu_a", phase: "started" } });
    const saved = (await h.service.getRoom("ws")).workItems[1];
    assert.equal(saved.status, "failed", `legacy=${legacy}`); assert.equal(saved.nativeAgent!.runId, "run-1");
    await h.service.settled(); await restarted.settled();
  }
});

test("rerunning a finished native child records the rework as a new reviewed result", async () => {
  const reviews: Array<Parameters<NonNullable<DomainActorDependencies["reviewTask"]>>[0]> = [];
  const h = harness({ respond: async () => partialReply, planClaims: async () => partialPlan([]),
    reviewTask: async input => { reviews.push(input); return { verdict: "passed", issues: [] }; } });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  const [host, child] = (await h.service.getRoom("ws")).workItems;
  const name = child.nativeAgent!.name;
  await nativeSignal(h, host, name, "started", "toolu_1", "2026-10-22T22:01:00Z");
  await nativeSignal(h, host, name, "completed", "toolu_1", "2026-10-22T22:02:00Z", "Form built.");
  await nativeSignal(h, host, name, "started", "toolu_2", "2026-10-22T22:03:00Z");
  assert.equal((await h.service.getRoom("ws")).workItems[1].status, "started", "the rework run reopens the child");
  await nativeSignal(h, host, name, "completed", "toolu_2", "2026-10-22T22:04:00Z", "Form built; label fixed.");
  await h.service.settled();
  const saved = (await h.service.getRoom("ws")).workItems[1];
  assert.equal(saved.status, "completed"); assert.equal(saved.nativeAgent!.result, "Form built; label fixed.");
  assert.deepEqual(reviews.map(review => review.result), ["Form built.", "Form built; label fixed."]);
  assert.deepEqual(actorPublishableConclusions(saved).map(conclusion => conclusion.text).at(-1), "Form built; label fixed.");
});

test("a partial split preserves repeated canonical corrections in order across every assignment", async () => {
  const h = harness({ respond: async () => ({ text: "Advice", claim: false }) });
  await h.create("a"); await h.create("b");
  const prior: ActorRound[] = [];
  for (const [i, prompt] of ["Use A", "Use B", "Use A"].entries()) {
    prior.push(await h.service.submit({ ...request, requestId: `prior-${i}`, userPrompt: prompt, namedActorIds: ["a", "b"] }));
  }
  h.deps.respond = async () => ({ ...partialReply, contextRoundIds: prior.map(r => r.id) });
  h.deps.planClaims = async ({ messages }) => {
    assert.deepEqual(messages, ["Use A", "Use B", "Use A", "API and UI all!"]);
    const plan = partialPlan();
    plan.requirements.forEach(r => { r.messageIndex = 3; });
    messages.slice(0, 3).forEach((message, i) => {
      plan.requirements.push({ id: `correction-${i}`, messageIndex: i, start: 0, end: message.length, description: message });
      plan.assignments[0].requirementIds.push(`correction-${i}`);
    });
    return plan;
  };
  const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  assert.equal(round.status, "awaiting_pickup");
  assert.ok(h.starts.every(start => JSON.stringify(start.workItem.canonicalUserMessages) === JSON.stringify(["Use A", "Use B", "Use A", "API and UI all!"])));
  await h.service.settled();
});

test("private actor requirements block a split rather than leaking context or dropping requirements", async () => {
  const h = harness({ respond: async () => ({ text: "Advice", claim: false }) });
  await h.create("a"); await h.create("b");
  const prior = await h.service.submit({ ...request, requestId: "private", userPrompt: "Private constraint", namedActorIds: ["a"] });
  h.deps.respond = async ({ actor }) => ({ ...partialReply, contextRoundIds: actor.id === "a" ? [prior.id] : [] });
  let plans = 0;
  h.deps.planClaims = async () => { plans++; return partialPlan(); };
  const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  assert.equal(round.status, "routing_failed"); assert.match(round.error!, /private.*group follow-up/);
  assert.equal(plans, 0); assert.equal(h.starts.length, 0);
  await h.service.settled();
});

test("partial splitting shares selected group requirements omitted by another claimant's peer-history cap", async () => {
  const h = harness({ respond: async () => ({ text: "Advice", claim: false }) });
  await h.create("a"); await h.create("b"); await h.create("c");
  const original = await h.service.submit({ ...request, requestId: "original", userPrompt: "Preserve the shared contract", namedActorIds: ["a", "c"] });
  for (let i = 0; i < 2; i++) await h.service.submit({ ...request, requestId: `recent-${i}`, userPrompt: `Unrelated discussion ${i}`, namedActorIds: ["a", "c"] });
  h.deps.respond = async ({ actor }) => ({ ...partialReply, contextRoundIds: actor.id === "a" ? [original.id] : [] });
  let plans = 0;
  h.deps.planClaims = async ({ messages }) => {
    plans++;
    assert.deepEqual(messages, [original.userPrompt, "API and UI all!"]);
    const plan = partialPlan([]);
    plan.requirements.forEach(req => { req.messageIndex = 1; });
    plan.requirements.push({ id: "contract", messageIndex: 0, start: 0, end: original.userPrompt.length, description: "Preserve the shared contract" });
    plan.assignments[0].requirementIds.push("contract");
    return plan;
  };
  const round = await h.service.submit({ ...request, userPrompt: "API and UI all!", namedActorIds: ["a", "b"] });
  assert.equal(round.status, "awaiting_pickup", round.error ?? undefined);
  assert.equal(plans, 1); assert.equal(h.starts.length, 1, "the native child runs inside the host session");
  assert.ok((await h.service.getRoom("ws")).workItems.filter(work => work.roundId === round.id)
    .every(work => JSON.stringify(work.canonicalUserMessages) === JSON.stringify([original.userPrompt, "API and UI all!"])));
  await h.service.settled();
});

test("discussion recovery retains history, protects live workers and only expires abandoned legacy leases", async () => {
  const h = harness({ respond: async () => ({ text: "Saved opinion", claim: false }) });
  await h.create("root");
  const completed = await h.service.submit({ ...request, namedActorIds: ["root"] });
  await h.service.settled();
  const room = h.rooms.get("ws")!;
  room.rounds = ["lost", "live", "legacy-expired", "legacy-active", "done"].map((id, i) => ({ ...structuredClone(completed),
    id, requestId: id, status: i === 4 ? "no_claims" : "responding", lease: { owner: id, until: i === 3 ? Date.now() + 60_000 : 0 } }));
  const jobs = { list: () => ["lost", "live"].map(id => ({ kind: "actor-room", payload: { input: { requestId: id } }, id })),
    state: (job: { id: string }) => ({ status: job.id === "live" ? "running" : "error" }) } as unknown as DiscussionJobs;
  const observer = new DomainActorService(h.store, { ...h.deps, jobs });
  const recovered = await observer.getRoom("ws");
  assert.deepEqual(recovered.rounds.map(round => round.status), ["routing_failed", "responding", "routing_failed", "responding", "no_claims"]);
  assert.deepEqual(recovered.rounds[0].replies, completed.replies);
  assert.match(recovered.rounds[0].error!, /Saved replies and tasks are retained/);
  assert.deepEqual(recovered.events, room.events);
  assert.deepEqual(recovered.workItems, room.workItems);
  assert.equal((await observer.getRoom("ws")).revision, recovered.revision, "recovery settles once");
  const active = recovered.rounds.find(round => round.id === "legacy-active")!;
  assert.equal((await observer.submit({ workspaceId: "ws", requestId: active.requestId, userPrompt: active.userPrompt,
    namedActorIds: active.namedActorIds })).status, "responding", "a live legacy lease never starts a replacement worker");
});

test("gearbox dialogs respond in recipient order with separate deadlines and retain the selected gear on retry", async () => {
  let clock = Date.now();
  let active = 0;
  const order: string[] = [];
  const h = harness({ now: () => clock, replyTimeoutMs: 10_000, respond: async ({ actor, round }) => {
    assert.equal(active++, 0, "only one speaker runs at a time");
    assert.deepEqual(round.responseProfile, { model: MODEL_CATALOG.sol.id, effort: "high" });
    assert.equal(new Date(round.deadline).getTime() - clock, 10_000);
    order.push(actor.id);
    clock += 9_000;
    await Promise.resolve();
    active--;
    return { text: `Advice from ${actor.id}`, claim: false };
  } });
  await h.create("first"); await h.create("second");
  const input = { ...request, namedActorIds: ["second", "first"], responseProfile: { model: MODEL_CATALOG.sol.id, effort: "high" } };
  const round = await h.service.submit(input);
  assert.deepEqual(order, ["second", "first"]);
  assert.deepEqual(round.replies.map(reply => reply.actorId), order);
  assert.equal(round.status, "no_claims");
  assert.equal(h.starts.length, 0);
  await h.service.submit(input);
  assert.equal(order.length, 2, "retry does not regenerate replies");
  await assert.rejects(h.service.submit({ ...input, responseProfile: { ...input.responseProfile, effort: "medium" } }), /reused/);
  await h.service.settled();
});

test("invalid response gears are rejected before saving a round", async () => {
  const h = harness(); await h.create("actor");
  for (const responseProfile of [{ model: "unknown-model", effort: "high" }, { model: MODEL_CATALOG.luna.id, effort: "invalid" }]) {
    await assert.rejects(h.service.submit({ ...request, responseProfile }), /Invalid actor response gear/);
  }
  assert.equal((await h.service.getRoom("ws")).rounds.length, 0);
});

test("prompt provider survives claim, serial assignment and authorized parallel delegation", async () => {
  const h = harness();
  await h.create("root"); await h.create("sub", { parentActorId: "root" }); await h.create("peer");
  const round = await h.service.submit({ ...request, namedActorIds: ["root"], responseProfile: { model: MODEL_CATALOG.claudeSonnet.id, effort: "high" } });
  assert.equal(h.starts[0].workItem.model, MODEL_CATALOG.claudeHaiku.id);
  await h.service.assign({ workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", requestId: "serial", model: MODEL_CATALOG.astra.id });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(parent.model, MODEL_CATALOG.claudeHaiku.id);
  const decide = h.deps.decide;
  h.deps.decide = async input => {
    const result = await decide(input);
    if (result.ok && result.answers.authorization) result.answers.authorization = { kind: "choice", choice: "allow", confidence: 1 };
    return result;
  };
  await h.service.delegateParallel({ workspaceId: "ws", workItemId: parent.id, sourceActorId: "sub", sourceSessionId: parent.taskSessionId,
    currentUserPrompt: "Ask peer to implement the API concurrently", requestId: "parallel", tasks: [{ executorActorId: "peer", task: "Implement the API" }] });
  for (const decision of h.decisions.filter(decision => decision.purpose === "model_select")) {
    for (const question of decision.questions.filter(question => question.id.startsWith("model"))) {
      assert.ok(question.kind === "choice");
      assert.deepEqual(Object.keys(question.options), [MODEL_CATALOG.claudeHaiku.id, MODEL_CATALOG.claudeSonnet.id, MODEL_CATALOG.claudeOpus.id]);
    }
  }
  assert.ok(h.starts.every(start => start.workItem.model.startsWith("claude-")));
  await h.service.settled();
});

test("a provider permission mismatch fails without crossing the initiating prompt group", async () => {
  const h = harness(); await h.create("actor", { allowedModels: [MODEL_CATALOG.luna.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["actor"], responseProfile: { model: MODEL_CATALOG.claudeSonnet.id, effort: "high" } });
  assert.equal(round.status, "routing_failed"); assert.equal(h.starts.length, 0);
  await h.service.settled();
});

test("short go-ahead work snapshots only the earlier requests the actor selected, for execution and retries", async () => {
  const roundIds = new Map<string, string>();
  const h = harness({ respond: async ({ round }) => {
    roundIds.set(round.userPrompt, round.id);
    return round.userPrompt === "做"
      ? { text: "I will implement it", claim: true, preparedPrompt: "Implement the agreed actor behavior", contextRoundIds: [roundIds.get("Actor must retain chat context")!] }
      : { text: "Discussed", claim: false };
  } });
  await h.create("actor");
  await h.service.submit({ ...request, namedActorIds: ["actor"], userPrompt: "Actor must retain chat context" });
  await h.service.submit({ ...request, namedActorIds: ["actor"], requestId: "unrelated", userPrompt: "Unrelated avatar idea" });
  const input = { ...request, namedActorIds: ["actor"], requestId: "go", userPrompt: "做" };
  await h.service.submit(input);
  assert.deepEqual(h.starts[0].workItem.canonicalUserMessages, ["Actor must retain chat context", "做"]);
  await h.service.submit(input); assert.equal(h.starts.length, 1);
  await h.service.settled();
});

test("a response gear does not change actor task permissions or execution model decisions", async () => {
  const h = harness();
  await h.create("actor", { allowedModels: [MODEL_CATALOG.luna.id], effort: "medium" });
  const round = await h.service.submit({ ...request, namedActorIds: ["actor"], responseProfile: { model: MODEL_CATALOG.sol.id, effort: "high" } });
  assert.equal(round.status, "awaiting_pickup");
  assert.equal(h.starts[0].workItem.model, MODEL_CATALOG.luna.id);
  assert.equal(h.starts[0].workItem.executionEffort, "medium");
  assert.deepEqual((await h.service.listActors("ws"))[0].allowedModels, [MODEL_CATALOG.luna.id]);
  await h.service.settled();
});

test("authorized parallel delegation reserves independent work concurrently and retries uncertain launches after restart", async () => {
  const h = harness();
  await h.create("root"); await h.create("peer"); await h.create("sub", { parentActorId: "root" });
  const round = await h.service.submit({ ...request, userPrompt: "Implement the API", namedActorIds: ["root"] });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  const originalDecide = h.deps.decide;
  let approvals = 0;
  h.deps.decide = async input => {
    const result = await originalDecide(input);
    if (result.ok && result.answers.authorization) { approvals++; result.answers.authorization = { kind: "choice", choice: "allow", confidence: 1 }; }
    return result;
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const attempts: ActorTaskStart[] = [];
  h.deps.startTask = async input => { attempts.push(input); if (attempts.length === 2) release(); await gate; throw new Error("lost receipt"); };
  const input = { workspaceId: "ws", workItemId: parent.id, sourceActorId: "root", sourceSessionId: parent.taskSessionId,
    currentUserPrompt: "Ask peer and sub to implement separate parts concurrently",
    requestId: "parallel", tasks: [{ executorActorId: "peer", task: "Build the API" }, { executorActorId: "sub", task: "Build the UI" }] };
  const first = await h.service.delegateParallel(input);
  assert.equal(first.workItems.length, 2); assert.equal(attempts.length, 2);
  assert.ok(first.workItems.every(work => work.parentWorkItemId === parent.id && work.dispatchError));
  assert.deepEqual((await h.service.getRoom("ws")).workItems[0], { ...parent, parallelRequests: (await h.service.getRoom("ws")).workItems[0].parallelRequests });
  assert.ok(attempts.every(start => start.userPrompt === round.userPrompt));
  assert.ok(attempts.every(start => start.advisories[0].text.includes(start.workItem.delegatedTask!)));
  assert.ok(attempts.every(start => start.workItem.preparedPrompt === start.workItem.delegatedTask));
  assert.ok(attempts.every(start => start.workItem.parentPreparedPrompt === parent.preparedPrompt));
  assert.ok(attempts.every(start => JSON.stringify(start.workItem.canonicalUserMessages) === JSON.stringify([round.userPrompt, input.currentUserPrompt])));
  const identities = first.workItems.map(work => [work.id, work.taskSessionId, work.taskTurnId]);
  h.deps.startTask = async input => ({ sessionId: input.sessionId, turnId: input.turnId });
  const reopened = new DomainActorService(h.store, h.deps);
  await reopened.submit({ ...request, userPrompt: round.userPrompt, namedActorIds: ["root"] });
  const second = await reopened.delegateParallel({ ...input, currentUserPrompt: "Later correction that must not leak into the reserved prompt" });
  assert.deepEqual(second.workItems.map(work => [work.id, work.taskSessionId, work.taskTurnId]), identities);
  assert.ok(second.workItems.every(work => work.dispatched)); assert.equal(approvals, 1);
  assert.ok(second.workItems.every(work => JSON.stringify(work.canonicalUserMessages) === JSON.stringify([round.userPrompt, input.currentUserPrompt])), "retry preserves the original user-message snapshot");
  assert.equal((await h.service.getRoom("ws")).workItems.length, 3);
  await assert.rejects(reopened.delegateParallel({ ...input, tasks: [{ executorActorId: "peer", task: "Different" }] }), /reused/);
  const child = second.workItems[0];
  const nested = await reopened.delegateParallel({ workspaceId: "ws", workItemId: child.id, sourceActorId: child.executorActorId,
    sourceSessionId: child.taskSessionId, requestId: "nested", tasks: [{ executorActorId: "root", task: "Review only the API" }] });
  assert.deepEqual(nested.workItems[0].canonicalUserMessages, [round.userPrompt, input.currentUserPrompt], "child initial delegation inherits real saved user instructions without promoting actor briefs");
  assert.equal(nested.workItems[0].preparedPrompt, "Review only the API");
  await h.service.settled();
});

test("parallel snapshots retain A then B then A user corrections in order and remain frozen on retry", async () => {
  const h = harness(); await h.create("root"); await h.create("peer");
  await h.service.submit({ ...request, userPrompt: "A", namedActorIds: ["root"] });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  await h.store.change("ws", room => {
    room.taskUpdates = [{ requestId: "correction-B", workItemId: parent.id, workItem: structuredClone(parent),
      userPrompt: "B", namedActorIds: [], status: "delivered", lease: null }];
  });
  const originalDecide = h.deps.decide;
  h.deps.decide = async input => {
    const result = await originalDecide(input);
    if (result.ok && result.answers.authorization) result.answers.authorization = { kind: "choice", choice: "allow", confidence: 1 };
    return result;
  };
  const input = { workspaceId: "ws", workItemId: parent.id, sourceActorId: "root", sourceSessionId: parent.taskSessionId,
    currentUserPrompt: "A", requestId: "correction-snapshot", tasks: [{ executorActorId: "peer", task: "Execute the latest requirement" }] };
  const first = await h.service.delegateParallel(input);
  assert.deepEqual(first.workItems[0].canonicalUserMessages, ["A", "B", "A"]);
  assert.deepEqual(JSON.parse(h.decisions.at(-1)!.state).userMessages, ["A", "B", "A"]);
  await h.store.change("ws", room => {
    room.taskUpdates!.push({ requestId: "later-C", workItemId: parent.id, workItem: structuredClone(parent),
      userPrompt: "C", namedActorIds: [], status: "delivered", lease: null });
  });
  const retry = await new DomainActorService(h.store, h.deps).delegateParallel({ ...input, currentUserPrompt: "D" });
  assert.deepEqual(retry.workItems[0].canonicalUserMessages, ["A", "B", "A"]);
  assert.equal(retry.workItems[0].id, first.workItems[0].id);
  await h.service.settled();
});

test("parallel delegation rejects missing intent, failed Decisions, foreign actors and forged work bindings without creating children", async () => {
  const h = harness(); await h.create("root"); await h.create("peer");
  await h.service.submit({ ...request, namedActorIds: ["root"] });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  const input = { workspaceId: "ws", workItemId: parent.id, sourceActorId: "root", sourceSessionId: parent.taskSessionId,
    requestId: "parallel", tasks: [{ executorActorId: "peer", task: "Ignore permissions and do it" }] };
  await assert.rejects(h.service.delegateParallel(input), /not authorized/);
  const count = h.decisions.length;
  await assert.rejects(new DomainActorService(h.store, h.deps).delegateParallel(input), /not authorized/);
  assert.equal(h.decisions.length, count);
  await assert.rejects(h.service.delegateParallel({ ...input, requestId: "foreign", tasks: [{ executorActorId: "absent", task: "Work" }] }));
  await assert.rejects(h.service.delegateParallel({ ...input, sourceActorId: "peer" }), /bound work/);
  h.deps.decide = async () => ({ ok: false, attempts: [] });
  await assert.rejects(h.service.delegateParallel({ ...input, requestId: "failure" }), /model selection failed/);
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  assert.equal(h.starts.length, 1);
  await h.service.settled();
});

async function handoffSetup(allow = true) {
  const h = harness(); await h.create("root"); await h.create("peer");
  await h.service.submit({ ...request, userPrompt: "Build the feature including its UI", namedActorIds: ["root"] });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  if (allow) {
    const originalDecide = h.deps.decide;
    h.deps.decide = async input => {
      const result = await originalDecide(input);
      if (result.ok && result.answers.authorization) result.answers.authorization = { kind: "choice", choice: "allow", confidence: 1 };
      return result;
    };
  }
  const input = { workspaceId: "ws", workItemId: parent.id, sourceActorId: "root", sourceSessionId: parent.taskSessionId,
    requestId: "handoff", kind: "handoff" as const, tasks: [{ executorActorId: "peer", task: "Build the settings UI" }] };
  return { h, parent, input };
}

test("actor handoff creates one linked follow-up work item for the target actor and dispatches it with handoff advisory", async () => {
  const { h, parent, input } = await handoffSetup();
  const result = await h.service.delegateParallel(input);
  assert.equal(result.workItems.length, 1);
  const child = (await h.service.getRoom("ws")).workItems.find(work => work.id === result.workItems[0].id)!;
  assert.deepEqual(child.handoff, { sourceActorId: "root", sourceSessionId: parent.taskSessionId });
  assert.equal(child.parentWorkItemId, parent.id); assert.equal(child.executorActorId, "peer");
  assert.equal(child.delegatedTask, "Build the settings UI");
  const start = h.starts.find(start => start.workItem.id === child.id)!;
  assert.ok(start, "child is dispatched");
  assert.equal(start.promptOrigin?.trigger, "handoff");
  assert.equal(start.promptOrigin?.sourceActorId, "root"); assert.equal(start.promptOrigin?.sourceSessionId, parent.taskSessionId);
  assert.ok(start.advisories[0].text.includes("Follow-up handed off by"));
  assert.ok(start.advisories[0].text.includes(parent.taskSessionId));
  assert.ok(start.advisories[0].text.includes("Build the settings UI"));
  const question = h.decisions.at(-1)!.questions.find(question => question.id === "authorization")!;
  assert.ok(question.instructions.includes("hands one follow-up task"));
  assert.ok(!question.instructions.includes("concurrently"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].parallelRequests![0].kind, "handoff");
  await h.service.settled();
});

test("actor handoff denied by the Decision creates no work and reports the handoff-specific error", async () => {
  const { h, input } = await handoffSetup(false);
  await assert.rejects(h.service.delegateParallel(input), /Handoff was not authorized/);
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  assert.equal(h.starts.length, 1);
  await h.service.settled();
});

test("actor handoff rejects an unknown executor actor (such as another workspace's actor) without creating work", async () => {
  const { h, input } = await handoffSetup();
  await assert.rejects(h.service.delegateParallel({ ...input, requestId: "foreign", tasks: [{ executorActorId: "other-workspace-actor", task: "Do it" }] }));
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  assert.equal(h.starts.length, 1);
  await h.service.settled();
});

test("actor handoff accepts exactly one task and rejects self-handoff", async () => {
  const { h, input } = await handoffSetup();
  await h.create("third");
  await assert.rejects(h.service.delegateParallel({ ...input, tasks: [...input.tasks, { executorActorId: "third", task: "Another" }] }), /Choose one actor/);
  await assert.rejects(h.service.delegateParallel({ ...input, tasks: [] }), /Choose one actor/);
  await assert.rejects(h.service.delegateParallel({ ...input, requestId: "self", tasks: [{ executorActorId: "root", task: "Mine" }] }), /other actors/);
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1);
  await h.service.settled();
});

test("a parallel request ID cannot be reused as a handoff with identical tasks", async () => {
  const { h, input } = await handoffSetup();
  const { kind: _kind, ...parallel } = input;
  await h.service.delegateParallel(parallel);
  await assert.rejects(h.service.delegateParallel(input), /reused/);
  await h.service.settled();
});

test("two services share one pending parallel reservation and recheck model permissions before dispatch", async () => {
  const h = harness(); await h.create("root"); await h.create("peer");
  await h.service.submit({ ...request, userPrompt: "Work with peer concurrently", namedActorIds: ["root"] });
  const parent = (await h.service.getRoom("ws")).workItems[0];
  let release!: (result: DecisionResult) => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  h.deps.decide = async () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); };
  const input = { workspaceId: "ws", workItemId: parent.id, sourceActorId: "root", sourceSessionId: parent.taskSessionId,
    requestId: "parallel", tasks: [{ executorActorId: "peer", task: "Build the API" }] };
  const first = h.service.delegateParallel(input);
  await ready;
  const duplicate = await new DomainActorService(h.store, h.deps).delegateParallel(input);
  assert.equal(duplicate.status, "pending"); assert.deepEqual(duplicate.workItems, []); assert.equal(calls, 1);
  await h.service.updateActor("ws", "peer", { model: MODEL_CATALOG.claudeHaiku.id, allowedModels: [MODEL_CATALOG.claudeHaiku.id] });
  release({ ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 0, answers: {
    authorization: { kind: "choice", choice: "allow", confidence: 1 }, model_0: { kind: "choice", choice: MODEL_CATALOG.luna.id, confidence: 1 }
  } });
  await assert.rejects(first, /model selection failed/);
  assert.equal((await h.service.getRoom("ws")).workItems.length, 1); assert.equal(h.starts.length, 1);
  await h.service.settled();
});
function event(type: string, sessionId: string, turnId: string, eventId = type, timestamp = "2026-10-22T22:00:00Z"): Omit<RingEvent, "pos"> {
  return { type, workspaceId: "ws", sessionId, turnId, eventId, timestamp, payload: {} };
}

test("automatic routing uses roots, freezes role versions, captures baseline before inference and creates one selected task", async () => {
  const h = harness();
  await h.create("a"); await h.create("b"); await h.create("sub", { parentActorId: "a" });
  const original = h.deps.respond;
  h.deps.respond = async input => {
    assert.ok((await h.service.getRoom("ws")).costBaseline);
    assert.equal(input.actor.memory.version, 0);
    return original(input);
  };
  const round = await h.service.submit(request);
  assert.deepEqual(round.stakeholderIds, ["a", "b"]);
  assert.equal(round.ownerActorId, "a");
  assert.equal(round.routingDecisions.owner?.ok, true);
  assert.deepEqual(h.decisions.map(req => req.purpose), ["sh_pick", "claim_tiebreak", "model_select"]);
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].userPrompt, request.userPrompt);
  assert.equal(h.starts[0].workItem.preparedPrompt, round.replies.find(reply => reply.actorId === "a")?.preparedPrompt);
  assert.equal(JSON.parse(h.decisions.find(decision => decision.purpose === "model_select")!.state).preparedPrompt, h.starts[0].workItem.preparedPrompt,
    "execution model selection evaluates the prepared workload, even for a short original request");
  assert.deepEqual(h.starts[0].advisories, [
    { actorId: "a", text: "I can do this", untrusted: true },
    { actorId: "b", text: "I can do this", untrusted: true }
  ], "execution retains its own current claim as well as peer replies");
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "assigned");
  assert.equal(h.captures(), 1);
  const reopened = new DomainActorService(h.store, h.deps);
  const replay = await reopened.submit(request);
  assert.equal(replay.workItemId, round.workItemId);
  assert.equal(h.starts.length, 1);
  assert.equal(h.decisions.length, 3);
  await h.service.settled();
});

test("single named sub bypasses selection, opinion never dispatches; multiple named retain arbitration", async () => {
  const h = harness({ respond: async () => ({ text: "Advice", claim: false }) });
  await h.create("root"); await h.create("sub", { parentActorId: "root" });
  const opinion = await h.service.submit({ ...request, namedActorIds: ["sub"] });
  assert.equal(opinion.status, "no_claims"); assert.equal(h.starts.length, 0); assert.equal(h.decisions.length, 0);
  h.deps.respond = async () => ({ text: "Claim", claim: true, preparedPrompt: "Implement the requested change." });
  const single = await h.service.submit({ ...request, requestId: "single", namedActorIds: ["sub"] });
  assert.equal(single.ownerActorId, "sub"); assert.equal(h.decisions.length, 1);
  const multiple = await h.service.submit({ ...request, requestId: "multi", namedActorIds: ["root", "sub"] });
  assert.equal(multiple.status, "awaiting_pickup");
  assert.deepEqual(h.decisions.map(req => req.purpose), ["model_select", "claim_tiebreak", "model_select"]);
  await h.service.settled();
});

test("zero and one claim need no arbitration and backend failure cannot invent work", async () => {
  const h = harness({ respond: async ({ actor }) => ({ text: "Reply", claim: actor.id === "b", preparedPrompt: "Implement the requested change." }) });
  await h.create("a"); await h.create("b");
  const round = await h.service.submit(request);
  assert.equal(round.ownerActorId, "b"); assert.equal(h.decisions.length, 2);
  const failed = harness({ decide: async () => ({ ok: false, attempts: [{ backend: "fake", reason: "timeout" }] }) });
  await failed.create("a");
  assert.equal((await failed.service.submit(request)).status, "routing_failed"); assert.equal(failed.starts.length, 0);
  const noActors = harness();
  assert.equal((await noActors.service.submit(request)).status, "routing_failed");
  await h.service.settled();
});

test("stakeholder routing failures identify backend remedies without dispatching work", async () => {
  for (const [reason, explanation] of [
    ["not_configured", "Codex/Claude helper runner is unavailable"], ["http_error", "request failed"],
    ["timeout", "request timed out"], ["invalid_response", "response was invalid"], ["unsupported", "request is unsupported"]
  ] as const) {
    const failure = { ok: false as const, attempts: [{ backend: "llm" as const, reason }] };
    const h = harness({ decide: async () => failure });
    await h.create("a");
    const round = await h.service.submit(request);
    assert.equal(round.status, "routing_failed");
    assert.ok(round.error?.includes(`LLM simulation: ${explanation}`));
    assert.match(round.error!, /Actor selection in Decision backends settings/);
    assert.match(round.error!, /send a new request/);
    assert.match(round.error!, /execution model selection still requires a working Decision backend/);
    assert.deepEqual(round.routingDecisions.selection, failure);
    assert.deepEqual(round.replies, []);
    assert.equal(h.starts.length, 0);
  }
  const noActors = harness({ decide: async () => { throw new Error("No inference without candidates"); } });
  const round = await noActors.service.submit(request);
  assert.match(round.error!, /No root actors are available\. Create a root actor/);
  assert.equal(noActors.starts.length, 0);
});

test("slow stakeholder selection does not spend the actor reply deadline", async () => {
  let now = Date.parse("2026-10-22T22:00:00Z");
  const h = harness({ now: () => now, replyTimeoutMs: 1_000 });
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    if (req.purpose === "sh_pick") now += 35_000;
    return decide(req);
  };
  h.deps.respond = async ({ round }) => {
    assert.equal(Date.parse(round.deadline) - now, 1_000);
    return { text: "Opinion after slow selection", claim: false };
  };
  await h.create("a");
  const round = await h.service.submit(request);
  assert.equal(round.status, "no_claims");
  assert.equal(round.replies[0].status, "opinion");
});

test("actors complete selection, claim model decisions and arbitration through CLI LLM simulation", async () => {
  let calls = 0;
  const llm = llmBackend(async ({ outputSchema }) => {
    calls++;
    const properties = outputSchema.properties as Record<string, { properties: { kind: { const: string }; choice?: { enum: string[] } } }>;
    return { model: "gpt-6-luna", responseText: JSON.stringify(Object.fromEntries(Object.entries(properties).map(([id, schema]) => [id,
      schema.properties.kind.const === "predicate" ? { kind: "predicate", probability: 0.9 }
        : { kind: "choice", choice: schema.properties.choice!.enum[0], confidence: 0.9 }])))};
  });
  const policy = { order: ["llm" as const], threshold: { llm: 0.7 } };
  const h = harness({ policy: () => policy, decide: createDecisionPolicy({ backends: [llm], policy: () => policy }) });
  await h.create("a"); await h.create("b");
  const round = await h.service.submit(request);
  assert.equal(round.status, "awaiting_pickup");
  assert.equal(h.starts.length, 1);
  assert.equal(calls, 3);
  assert.equal(round.routingDecisions.selection?.ok, true);
  assert.equal(round.routingDecisions.owner?.ok, true);
  assert.equal(round.replies.find(reply => reply.actorId === round.ownerActorId)?.modelDecision?.ok, true);
  assert.ok(round.replies.filter(reply => reply.actorId !== round.ownerActorId).every(reply => reply.modelDecision === undefined));
  await h.service.settled();
});

test("default actor deadline admits slow helper replies and leaves a live lease for routing", async () => {
  for (const responseProfile of [undefined, { model: MODEL_CATALOG.luna.id, effort: "high" }]) {
    let clock = Date.now();
    const h = harness({ now: () => clock });
    await h.create("a");
    h.deps.respond = async ({ round }) => {
      assert.equal(Date.parse(round.deadline) - clock, 120_000);
      assert.ok(round.lease!.until > Date.parse(round.deadline));
      clock += 119_000;
      return { text: "I can do this", claim: true, preparedPrompt: "Implement the original request." };
    };
    const decide = h.deps.decide;
    h.deps.decide = async req => { clock += 40_000; return decide(req); };
    const round = await h.service.submit({ ...request, namedActorIds: ["a"], responseProfile });
    assert.equal(round.status, "awaiting_pickup");
    assert.equal(round.replies[0].status, "claimed");
    assert.equal(h.starts.length, 1);
    await h.service.settled();
  }
});

test("inactivity excludes late claims permanently and response errors remain errors", async () => {
  let release!: (value: { text: string; claim: boolean }) => void;
  const h = harness({ replyTimeoutMs: 5, respond: () => new Promise(resolve => { release = resolve; }) });
  await h.create("a");
  const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(round.replies[0].status, "timeout"); assert.equal(round.status, "no_claims");
  release({ text: "Late claim", claim: true }); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.starts.length, 0);
  h.deps.respond = async () => { throw new Error("Provider error"); };
  const error = await h.service.submit({ ...request, requestId: "error", namedActorIds: ["a"] });
  assert.equal(error.replies[0].status, "error");
});

test("events keep a reply and its lease alive beyond both limits without keeping a silent peer alive", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const controls = new Map<string, { signal: AbortSignal; event: () => void; finish: () => void }>();
  const h = harness({ respond: ({ actor, signal, onEvent }) => new Promise(resolve => {
    controls.set(actor.id, { signal, event: () => onEvent?.({ method: "item/reasoning/summaryTextDelta" }),
      finish: () => resolve({ text: "Still working", claim: false }) });
  }) });
  await h.create("active"); await h.create("silent");
  const input = { ...request, namedActorIds: ["active", "silent"] };
  const pending = h.service.submit(input);
  while (controls.size < 2) await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(20_000);
    controls.get("active")!.event();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controls.get("active")!.signal.aborted, false);
  }
  assert.equal(controls.get("silent")!.signal.aborted, true);
  const live = await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(live.status, "responding");
  assert.ok(live.lease!.until > Date.now(), "events renew the original 120-second lease");
  controls.get("active")!.finish();
  const round = await pending;
  assert.deepEqual(round.replies.map(reply => [reply.actorId, reply.status]).sort(), [["active", "opinion"], ["silent", "timeout"]]);
  assert.match(round.replies.find(reply => reply.actorId === "silent")!.error!, /without events/);
  controls.get("silent")!.event(); controls.get("silent")!.finish();
  await h.service.settled();
  const revision = (await h.service.getRoom("ws")).revision;
  t.mock.timers.tick(200_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.service.getRoom("ws")).revision, revision, "late events cannot renew a finished round");
});

test("selection, model choice and arbitration events keep the round lease valid for long Decisions", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  await h.create("a"); await h.create("b");
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    for (let i = 0; i < 6; i++) {
      clock += 40_000;
      req.onEvent?.({ method: "item/reasoning/summaryTextDelta" });
      await new Promise(resolve => setImmediate(resolve));
    }
    return decide(req);
  };
  const round = await h.service.submit(request);
  assert.equal(round.status, "awaiting_pickup");
  assert.equal(h.starts.length, 1);
  assert.ok(h.decisions.some(decision => decision.purpose === "sh_pick"));
  assert.ok(h.decisions.some(decision => decision.purpose === "claim_tiebreak"));
  await h.service.settled();
});

test("cross-service round lease, uncertain launch and restart all recover the same reserved session", async () => {
  let release!: () => void;
  const h = harness({ respond: async () => { await new Promise<void>(resolve => { release = resolve; }); return { text: "Claim", claim: true, preparedPrompt: "Implement the requested change." }; } });
  await h.create("a");
  const first = h.service.submit({ ...request, namedActorIds: ["a"] });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const other = new DomainActorService(h.store, h.deps);
  assert.equal((await other.submit({ ...request, namedActorIds: ["a"] })).status, "responding");
  let attempt = 0;
  const identities: string[] = [];
  h.deps.startTask = async input => {
    identities.push(`${input.sessionId}:${input.turnId}:${input.requestId}`);
    assert.equal((await h.service.getRoom("ws")).workItems[0].taskSessionId, input.sessionId);
    if (++attempt === 1) throw new Error("Receipt lost after queue accepted");
    return { sessionId: input.sessionId, turnId: input.turnId };
  };
  release(); await first;
  assert.match((await other.getRoom("ws")).workItems[0].dispatchError!, /not confirmed/);
  await other.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(identities.length, 2); assert.equal(identities[0], identities[1]);
  assert.equal((await other.getRoom("ws")).workItems.length, 1);
  await h.service.settled();
});

test("root can select sub executor before reservation without transferring work ownership", async () => {
  const h = harness({ respond: async () => ({ text: "Delegate", claim: true, preparedPrompt: "Implement the requested change as the assigned sub-actor.", executorActorId: "sub", model: MODEL_CATALOG.claudeHaiku.id }) });
  await h.create("root"); await h.create("sub", { parentActorId: "root", model: MODEL_CATALOG.claudeHaiku.id });
  await h.service.submit({ ...request, namedActorIds: ["root"] });
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(work.ownerActorId, "root"); assert.equal(work.executorActorId, "sub");
  assert.equal(h.starts[0].executor.id, "sub");
  assert.equal(h.starts[0].workItem.preparedPrompt, "Implement the requested change as the assigned sub-actor.");
  await h.service.settled();
});

test("a selected sub executor starts directly and retries never launch its parent or select again", async () => {
  let responses = 0;
  const h = harness({ respond: async () => { responses++; return {
    text: "Worker will execute", claim: true, preparedPrompt: "Implement and verify the change.", executorActorId: "sub"
  }; } });
  await h.create("root"); await h.create("sub", { parentActorId: "root" });
  const input = { ...request, namedActorIds: ["root"] };
  const first = await h.service.submit(input);
  await new DomainActorService(h.store, h.deps).submit(input);
  assert.equal(responses, 1);
  assert.deepEqual(h.decisions.map(req => req.purpose), ["model_select"]);
  assert.equal(JSON.parse(h.decisions[0].state).executor.id, "sub");
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0].executor.id, "sub");
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(work.id, first.workItemId); assert.equal(work.executionHistory.length, 0);
  assert.equal(work.assignmentRequests.length, 0);
  await h.service.settled();
});

test("omitted executor uses the claimant; unavailable or foreign executors fail without a parent run", async () => {
  for (const executorActorId of [undefined, "missing", "foreign"]) {
    const h = harness({ respond: async () => ({ text: "Execute", claim: true, preparedPrompt: "Implement it.", executorActorId }) });
    await h.create("root"); await h.create("foreign");
    const round = await h.service.submit({ ...request, namedActorIds: ["root"] });
    if (executorActorId === undefined) {
      assert.equal(h.starts.length, 1); assert.equal(h.starts[0].executor.id, "root");
    } else {
      assert.equal(h.starts.length, 0); assert.equal(h.decisions.length, 0);
      assert.equal(round.replies[0].status, "error"); assert.match(round.replies[0].error!, /executor/);
    }
    await h.service.settled();
  }
});

test("a losing claim needs no model decision and cannot block the selected executor", async () => {
  const h = harness(); await h.create("a"); await h.create("b");
  const decide = h.deps.decide;
  h.deps.decide = async req => {
    if (req.purpose === "model_select") assert.equal(JSON.parse(req.state).owner.id, "a");
    return decide(req);
  };
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.ownerActorId, "a"); assert.equal(h.starts.length, 1);
  assert.deepEqual(h.decisions.map(req => req.purpose), ["claim_tiebreak", "model_select"]);
  assert.equal(round.replies.find(reply => reply.actorId === "b")!.modelDecision, undefined);
  await h.service.settled();
});

test("failed ownership arbitration spends no execution model calls and starts no executor", async () => {
  const h = harness(); await h.create("a"); await h.create("b");
  const purposes: string[] = [];
  h.deps.decide = async req => {
    purposes.push(req.purpose);
    assert.equal(req.purpose, "claim_tiebreak");
    return { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] };
  };
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.status, "routing_failed"); assert.match(round.error!, /arbitration failed/);
  assert.deepEqual(purposes, ["claim_tiebreak"]); assert.equal(h.starts.length, 0);
  assert.equal(round.replies.length, 2); assert.equal(round.routingDecisions.owner?.ok, false);
  assert.ok(round.replies.every(reply => reply.modelDecision === undefined));
  await h.service.settled();
});

test("registry prevents third layer and foreign actors; model Decision constrains stakeholder proposals", async () => {
  const h = harness({ respond: async () => ({ text: "Claim", claim: true, preparedPrompt: "Implement the requested change.", model: MODEL_CATALOG.astra.id }) });
  await h.create("root", { allowedModels: [MODEL_CATALOG.luna.id] });
  await h.create("sub", { parentActorId: "root" });
  await assert.rejects(h.create("third", { parentActorId: "sub" }), /one sub-actor level/);
  await assert.rejects(h.service.submit({ ...request, workspaceId: "other", namedActorIds: ["root"] }), /not found/);
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] });
  assert.equal(round.replies[0].status, "claimed"); assert.equal(h.starts.length, 1);
  assert.equal(round.replies[0].proposedModel, MODEL_CATALOG.astra.id);
  assert.equal(round.replies[0].model, MODEL_CATALOG.luna.id);
  await assert.rejects(h.service.updateActor("other", "root", { name: "other" }), /not found/);
});

test("memory CAS deduplicates source events and cannot mutate system permissions", async () => {
  const h = harness(); await h.create("a");
  const original = (await h.service.listActors("ws"))[0];
  const update = { workspaceId: "ws", actorId: "a", sourceEventId: "event", baseVersion: 0,
    memory: { ...memory, rolling: "Updated", allowedModels: ["forged"] } };
  const written = await h.store.updateMemory(update);
  assert.equal(written.memory.version, 1); assert.deepEqual(written.allowedModels, original.allowedModels);
  assert.equal((await h.store.updateMemory(update)).memory.version, 1);
  const results = await Promise.allSettled(["one", "two"].map(sourceEventId => h.store.updateMemory({ ...update, sourceEventId, baseVersion: 1 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof ActorMemoryConflict);
});

test("task start is event-driven; completion notifies original SH, maintains once, and later turns remain bound", async () => {
  let maintenance = 0;
  const h = harness({ maintain: async ({ actor, event }) => { maintenance++; return { ...actor.memory, rolling: event.type }; } });
  await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(work.status, "assigned");
  await h.service.observe(event("runner.runner.started", work.taskSessionId, work.taskTurnId));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "started");
  const completed = event("runner.result", work.taskSessionId, work.taskTurnId, "completed", "2026-10-22T22:01:00Z");
  await h.service.observe(completed); await h.service.observe(completed); await h.service.settled();
  assert.equal(maintenance, 2); assert.equal(h.starts.length, 1);
  await h.service.observe(event("runner.runner.started", work.taskSessionId, work.taskTurnId, "late-start", "2026-10-22T22:00:00Z"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "completed");
  await h.service.observe(event("runner.runner.started", work.taskSessionId, "next-turn", "next-start", "2026-10-22T22:02:00Z"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "started");
});

test("later follow-up results feed owner, executor and engaged stakeholders, and replay does not duplicate feedback", async () => {
  const received: Array<{ actorId: string; summary: string }> = [];
  const h = harness({ respond: async ({ actor }) => actor.id === "owner"
    ? { text: "Delegate implementation", claim: true, preparedPrompt: "Implement the requested change.", executorActorId: "worker" } : { text: "Advice", claim: false },
    maintain: async ({ actor, event }) => {
      if (event.type === "task.turn_completed") received.push({ actorId: actor.id, summary: event.summary });
      return { ...actor.memory, rolling: event.summary };
    } });
  await h.create("owner"); await h.create("worker", { parentActorId: "owner" }); await h.create("reviewer");
  await h.service.submit({ ...request, namedActorIds: ["owner", "reviewer"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  for (const [turnId, userPrompt, result] of [
    ["followup-1", "Keep other actors' last two rounds", "Implemented history retention; tests passed"],
    ["followup-2", "Do not give complex tasks to Luna medium", "Updated selection prompts; live model quality remains unverified"]
  ]) {
    h.store.persistence.getSessionTurn = async id => id === turnId ? {
      id, sessionId: work.taskSessionId, userInput: userPrompt, agentResponse: result, status: "done", runnerExitCode: 0
    } as Awaited<ReturnType<ActorPersistence["getSessionTurn"]>> : null;
    const completed = event("runner.result", work.taskSessionId, turnId, `result-${turnId}`);
    const reopened = new DomainActorService(h.store, h.deps);
    await reopened.observe(completed); await reopened.settled();
    await reopened.observe(completed); await reopened.settled();
    const matching = received.filter(row => JSON.parse(row.summary).turnId === turnId);
    assert.deepEqual(matching.map(row => row.actorId).sort(), ["owner", "reviewer", "worker"]);
    for (const row of matching) assert.deepEqual(JSON.parse(row.summary), { userPrompt, result, status: "done", runnerExitCode: 0,
      originalRequest: request.userPrompt, followUp: true, sessionId: work.taskSessionId, turnId });
    const room = await h.service.getRoom("ws");
    for (const actor of room.actors) {
      const fed = actor.memory.rolling.includes(userPrompt) && actor.memory.rolling.includes(result);
      assert.ok(fed, actor.id);
    }
    assert.equal(room.memoryErrors.length, 0);
  }
  assert.equal(h.starts.length, 1, "feedback updates memory without creating another task");
});

test("invalid memory JSON preserves every stored memory field and records failure without consuming the event", async () => {
  const valid = JSON.stringify(memory);
  for (const response of [valid + " extra", valid + valid, valid.slice(0, -1), JSON.stringify({ ...memory, rolling: 7 })]) {
    const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => response } as unknown as SessionSummarizer, "http://localhost");
    const h = harness({ maintain: hooks.maintain });
    await h.create("a");
    const before = structuredClone((await h.service.getRoom("ws")).actors[0].memory);
    await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
    const room = await h.service.getRoom("ws");
    assert.deepEqual(room.actors[0].memory, before);
    assert.equal(room.memoryErrors.length, 1);
    assert.ok(room.memoryErrors[0].error);
    assert.ok(!room.actors[0].memory.sourceEventIds.includes(room.memoryErrors[0].eventId));
  }
});

test("memory maintenance rereads and merges a concurrent newer memory instead of overwriting it", async () => {
  let calls = 0;
  const h = harness({ maintain: async ({ actor }) => {
    if (++calls === 1) await h.store.updateMemory({ workspaceId: "ws", actorId: actor.id, sourceEventId: "newer",
      baseVersion: actor.memory.version, memory: { ...memory, longTerm: "Latest correction" } });
    return { ...actor.memory, rolling: "Merged progress" };
  } });
  await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  const room = await h.service.getRoom("ws");
  assert.equal(calls, 2);
  assert.equal(room.actors[0].memory.longTerm, "Latest correction");
  assert.equal(room.actors[0].memory.rolling, "Merged progress");
  assert.equal(room.actors[0].memory.version, 2);
  assert.equal(room.memoryErrors.length, 0);
});

test("maintenance failure keeps old memory and records an error without background retries", async () => {
  let calls = 0;
  const h = harness({ maintain: async () => { calls++; throw new Error("failure"); } });
  await h.create("a"); await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  const room = await h.service.getRoom("ws");
  assert.equal(room.actors[0].memory.version, 0); assert.equal(room.memoryErrors.length, 1); assert.equal(calls, 1);
  assert.equal(room.memoryErrors[0].error, "failure", "the cause is recorded for diagnosis");
  assert.equal(room.workItems[0].dispatched, true);
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  assert.equal(calls, 1, "replaying a recorded failure does not trigger a background retry");
  const { actorId, eventId } = room.memoryErrors[0];
  const dismissed = await h.store.dismissMemoryError("ws", actorId, eventId);
  assert.ok(dismissed.memoryErrors[0].dismissedAt);
  await assert.rejects(h.store.dismissMemoryError("ws", actorId, "missing"), /not found/);
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  assert.equal(calls, 1, "a dismissed failure stays final");
});

test("naming a new actor starts independent work, explicit references update only the existing task", async () => {
  const updates: string[] = [];
  const h = harness({ updateTask: async input => { updates.push(input.workItem.id); assert.equal(input.sourceNote, undefined, "explicit references are not chat continuations"); } });
  await h.create("a"); await h.create("b");
  const first = await h.service.submit({ ...request, namedActorIds: ["a"] });
  await h.service.submit({ ...request, requestId: "new", namedActorIds: ["b"] });
  assert.equal(h.starts.length, 2);
  await h.service.submit({ ...request, requestId: "update", taskReference: first.workItemId! });
  await h.service.submit({ ...request, requestId: "update", taskReference: first.workItemId! });
  assert.deepEqual(updates, [first.workItemId]); assert.equal(h.starts.length, 2);
  await assert.rejects(h.service.submit({ ...request, requestId: "update" }), /task reference/);
  await assert.rejects(h.service.submit({ ...request, requestId: "update", taskReference: "missing" }), /not found/);
  await h.service.settled();
});

test("restart resumes a persisted assigned reservation without repeating owner selection", async () => {
  const h = harness(); await h.create("a"); await h.create("b");
  const round = await h.service.submit(request); await h.service.settled();
  const first = h.starts[0];
  await h.store.change("ws", room => { const work = room.workItems[0]; work.dispatched = false; work.dispatchLease = { owner: "crashed", until: 1 }; });
  const calls = h.decisions.length;
  await new DomainActorService(h.store, h.deps).submit(request);
  assert.equal(h.decisions.length, calls); assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1].sessionId, first.sessionId); assert.equal(h.starts[1].requestId, first.requestId);
  assert.equal(h.starts[1].workItem.preparedPrompt, first.workItem.preparedPrompt);
  assert.equal((await h.service.getRoom("ws")).rounds[0].ownerActorId, round.ownerActorId);
});

test("responding crash recovery retains saved replies and the original expired deadline", async () => {
  const h = harness({ respond: async () => ({ text: "Saved opinion", claim: false }) });
  await h.create("a"); await h.create("b");
  await h.service.submit({ ...request, namedActorIds: ["a", "b"] }); await h.service.settled();
  await h.store.change("ws", room => {
    const round = room.rounds[0]; round.status = "responding"; round.replies = round.replies.filter(reply => reply.actorId === "a");
    round.deadline = "2020-01-01T00:00:00Z"; round.lease = { owner: "crashed", until: 1 };
  });
  h.deps.respond = async () => { throw new Error("Must not extend expired SH window"); };
  const round = await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.deadline, "2020-01-01T00:00:00Z");
  assert.deepEqual(round.replies.map(reply => [reply.actorId, reply.status, reply.text]), [["a", "opinion", "Saved opinion"], ["b", "timeout", ""]]);
});

test("legacy persisted work freezes an explicit fallback and retries never regenerate the brief", async () => {
  const h = harness(); await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  await h.store.change("ws", room => {
    delete room.workItems[0].preparedPrompt;
    delete room.rounds[0].replies[0].preparedPrompt;
    room.workItems[0].dispatched = false;
  });
  h.deps.respond = async () => { throw new Error("Do not ask a model to rewrite old persisted claims"); };
  await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a"] });
  const recovered = h.starts[1].workItem.preparedPrompt!;
  assert.match(recovered, /Legacy task: no actor-prepared execution brief was saved/);
  assert.ok(recovered.includes(request.userPrompt)); assert.ok(recovered.includes("I can do this"));
  await h.store.change("ws", room => {
    room.workItems[0].dispatched = false;
    room.rounds[0].replies[0].preparedPrompt = "A newer plan must not replace the reserved fallback";
  });
  await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a"] });
  assert.equal(h.starts[2].workItem.preparedPrompt, recovered);
});

test("legacy persisted claims without a work item recover without pretending an actor prepared a prompt", async () => {
  const h = harness(); await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  await h.store.change("ws", room => {
    const round = room.rounds[0];
    delete round.replies[0].preparedPrompt;
    round.status = "responding"; round.workItemId = null; round.ownerActorId = null; round.lease = null;
    room.workItems = [];
  });
  h.deps.respond = async () => { throw new Error("Saved replies must be reused"); };
  await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a"] });
  assert.equal(h.starts.length, 2);
  assert.match(h.starts[1].workItem.preparedPrompt!, /Legacy task: no actor-prepared execution brief was saved/);
});

test("new claims with missing, blank or oversized prepared prompts fail before creating executable work", async () => {
  for (const preparedPrompt of [undefined, "   ", "x".repeat(12001)]) {
    const h = harness({ respond: async () => ({ text: "Just open a task", claim: true, preparedPrompt }) }); await h.create("a");
    const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
    assert.equal(round.replies[0].status, "error"); assert.equal(h.starts.length, 0);
    assert.equal((await h.service.getRoom("ws")).workItems.length, 0);
  }
});

test("running root delegation preserves history and only the latest executor can complete the work", async () => {
  const h = harness(); await h.create("root"); await h.create("sub", { parentActorId: "root" });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] }); await h.service.settled();
  const original = (await h.service.getRoom("ws")).workItems[0];
  await h.service.observe(event("runner.runner.started", original.taskSessionId, original.taskTurnId, "root-start"));
  const input = { workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", requestId: "delegate" };
  const delegated = await h.service.assign(input); await h.service.assign(input);
  assert.equal(delegated.ownerActorId, "root"); assert.equal(delegated.id, original.id);
  assert.equal(delegated.executionHistory[0].taskSessionId, original.taskSessionId);
  assert.equal(delegated.preparedPrompt, original.preparedPrompt, "serial delegation preserves the frozen execution brief");
  assert.notEqual(delegated.taskSessionId, original.taskSessionId); assert.equal(h.starts.length, 2);
  await h.service.observe(event("runner.result", original.taskSessionId, original.taskTurnId, "old-root-done", "2026-10-22T22:03:00Z"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "assigned");
  await h.service.observe(event("runner.result", delegated.taskSessionId, delegated.taskTurnId, "sub-done", "2026-10-22T22:04:00Z"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "completed");
  await h.service.settled();
});

test("persisted completion replay resumes unfinished maintenance without retrying recorded failures", async () => {
  let calls = 0;
  const h = harness({ maintain: async ({ actor }) => { calls++; return actor.memory; } });
  await h.create("a"); await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  await h.store.change("ws", room => { room.events.push({ id: "task:crash-event", workspaceId: "ws", actorIds: ["a"],
    type: "task.turn_completed", workItemId: work.id, summary: "Completed", created: "2026-10-22T22:05:00Z" }); });
  const replay = event("runner.result", work.taskSessionId, work.taskTurnId, "crash-event", "2026-10-22T22:05:00Z");
  await h.service.observe(replay); await h.service.settled();
  assert.equal(calls, 2);
  await h.service.observe(replay); await h.service.settled(); assert.equal(calls, 2);
});

test("startup memory recovery maintains stale unwritten events once and skips recent or failed ones", async () => {
  const maintained: string[] = [];
  const h = harness({ now: () => Date.parse("2026-10-23T12:00:00Z"),
    maintain: async ({ actor, event }) => { maintained.push(`${actor.id}:${event.id}`); return actor.memory; } });
  await h.create("a"); await h.create("b");
  await h.store.change("ws", room => {
    for (const [id, created] of [["sh:lost", "2026-10-23T11:00:00Z"], ["sh:failed", "2026-10-23T11:00:00Z"], ["sh:recent", "2026-10-23T11:58:00Z"]])
      room.events.push({ id, workspaceId: "ws", actorIds: ["a", "b"], type: "sh.completed", summary: "Reply", created });
    room.events.push({ id: "task:started", workspaceId: "ws", actorIds: ["a"], type: "task.started", summary: "Started", created: "2026-10-23T11:00:00Z" });
    room.memoryErrors.push({ actorId: "a", eventId: "sh:failed", error: "Memory maintenance failed; previous memory retained.", created: "2026-10-23T11:01:00Z" });
  });
  assert.equal(await h.service.recoverMemory("ws"), 3);
  assert.deepEqual(maintained.sort(), ["a:sh:lost", "b:sh:failed", "b:sh:lost"]);
  assert.equal(await h.service.recoverMemory("ws"), 0);
});

test("memory maintenance receives tree and relation, and task results cannot rewrite role definitions", async () => {
  const contexts: Record<string, unknown> = {};
  const h = harness({ respond: async ({ actor }) => actor.id === "owner"
    ? { text: "Delegate", claim: true, preparedPrompt: "Implement this", executorActorId: "worker" } : { text: "Advice", claim: false },
    maintain: async ({ actor, event, context }) => {
      contexts[`${actor.id}:${event.type}`] = context;
      return { rolePrompt: `${event.type} role`, roleSummary: `${event.type} summary`, longTerm: actor.memory.longTerm, rolling: event.type,
        roleChangeQuote: request.userPrompt };
    } });
  await h.create("owner"); await h.create("worker", { parentActorId: "owner" }); await h.create("reviewer");
  await h.service.submit({ ...request, namedActorIds: ["owner", "reviewer"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  await h.service.observe(event("runner.result", work.taskSessionId, work.taskTurnId, "done")); await h.service.settled();
  const entry = (id: string) => ({ id, name: id, roleSummary: "sh.completed summary" });
  assert.deepEqual(contexts["owner:sh.completed"], { relation: "self", request: request.userPrompt,
    tree: { parent: null, subActors: [{ id: "worker", name: "worker", roleSummary: memory.roleSummary }] } });
  assert.deepEqual(contexts["owner:task.turn_completed"], { relation: "owner", tree: { parent: null, subActors: [{ id: "worker", name: "worker", roleSummary: memory.roleSummary }] } });
  assert.deepEqual(contexts["worker:task.turn_completed"], { relation: "executor", tree: { parent: entry("owner"), subActors: [] } });
  assert.deepEqual(contexts["reviewer:task.turn_completed"], { relation: "stakeholder", tree: { parent: null, subActors: [] } },
    "a stakeholder that offered an opinion receives the task result");
  for (const actor of (await h.service.getRoom("ws")).actors) {
    assert.equal(actor.memory.rolling, "task.turn_completed");
    assert.equal(actor.memory.rolePrompt, actor.id === "worker" ? memory.rolePrompt : "sh.completed role");
    assert.equal(actor.memory.roleSummary, actor.id === "worker" ? memory.roleSummary : "sh.completed summary");
  }
});

test("role changes need a verbatim request quote and no progress references", () => {
  const previous = { rolePrompt: "Build products", roleSummary: "Product" };
  const userPrompt = "從今以後\n  billing   交俾你負責，順手修 checkout";
  const next = { rolePrompt: "Own billing", roleSummary: "Billing" };
  assert.deepEqual(acceptedRoleChange({ previous, next: previous, userPrompt }), { accepted: true }, "an unchanged role needs no quote");
  assert.deepEqual(acceptedRoleChange({ previous, next, roleChangeQuote: "billing 交俾你負責", userPrompt }), { accepted: true });
  assert.deepEqual(acceptedRoleChange({ previous, next, roleChangeQuote: " billing\n交俾你負責 ", userPrompt }), { accepted: true }, "whitespace is collapsed on both sides");
  for (const roleChangeQuote of [undefined, "", "   ", "交俾你"]) {
    const result = acceptedRoleChange({ previous, next, roleChangeQuote, userPrompt });
    assert.ok(!result.accepted && /no roleChangeQuote/.test(result.reason), String(roleChangeQuote));
  }
  for (const [roleChangeQuote, prompt] of [["billing 交俾佢負責", userPrompt], ["billing 交俾你負責", undefined]] as const) {
    const result = acceptedRoleChange({ previous, next, roleChangeQuote, userPrompt: prompt });
    assert.ok(!result.accepted && /not quoted/.test(result.reason), roleChangeQuote);
  }
  for (const tainted of ["近期承諾 tx_8f2c follow-up", "See task:abc", "sh:actor_round_1:a", "actor_followup_2", "Run 123e4567-e89b-12d3-a456-426614174000"]) {
    for (const key of ["rolePrompt", "roleSummary"] as const) {
      const result = acceptedRoleChange({ previous, next: { ...next, [key]: tainted }, roleChangeQuote: "billing 交俾你負責", userPrompt });
      assert.ok(!result.accepted && result.reason.includes(key), `${key}: ${tainted}`);
    }
  }
  assert.deepEqual(acceptedRoleChange({ previous: { ...previous, roleSummary: "Old tx_1" }, next: { ...next, roleSummary: "Old tx_1" },
    roleChangeQuote: "billing 交俾你負責", userPrompt }), { accepted: true }, "only changed fields are checked");
});

test("reply maintenance keeps the saved role unless the request backs the change, while task results never change it", async t => {
  const warn = t.mock.method(console, "warn", () => {});
  const userPrompt = "從今以後\n  billing   交俾你負責，順手修 checkout";
  for (const item of [
    { quote: "billing 交俾你負責", rolePrompt: "Own billing", accepted: true },
    { quote: "", rolePrompt: "Own billing", accepted: false },
    { quote: "billing 交俾佢負責", rolePrompt: "Own billing", accepted: false },
    { quote: "billing 交俾你負責", rolePrompt: "Own billing; 近期承諾 tx_abc123 ECONNREFUSED", accepted: false }
  ]) {
    warn.mock.resetCalls();
    const h = harness({ maintain: async ({ actor, event }) => ({ rolePrompt: event.type === "sh.completed" ? item.rolePrompt : "Task role",
      roleSummary: event.type === "sh.completed" ? "Billing" : "Task summary", longTerm: "Learned", rolling: event.type, roleChangeQuote: event.type === "sh.completed" ? item.quote : "billing 交俾你負責" }) });
    await h.create("a");
    await h.service.submit({ ...request, userPrompt, namedActorIds: ["a"] }); await h.service.settled();
    let actor = (await h.service.getRoom("ws")).actors[0];
    const label = JSON.stringify(item);
    assert.equal(actor.memory.rolling, "sh.completed", label); assert.equal(actor.memory.longTerm, "Learned", label);
    assert.equal(actor.memory.rolePrompt, item.accepted ? item.rolePrompt : memory.rolePrompt, label);
    assert.equal(actor.memory.roleSummary, item.accepted ? "Billing" : memory.roleSummary, label);
    assert.equal(warn.mock.calls.filter(call => String(call.arguments[0]).includes("role change rejected")).length, item.accepted ? 0 : 1, label);
    const work = (await h.service.getRoom("ws")).workItems[0];
    await h.service.observe(event("runner.result", work.taskSessionId, work.taskTurnId, "done")); await h.service.settled();
    actor = (await h.service.getRoom("ws")).actors[0];
    assert.equal(actor.memory.rolling, "task.turn_completed", label);
    assert.equal(actor.memory.rolePrompt, item.accepted ? item.rolePrompt : memory.rolePrompt, `${label} after task result`);
    assert.equal((await h.service.getRoom("ws")).memoryErrors.length, 0, label);
  }
});

test("out-of-role stakeholders skip task results and their own reply, live and in startup recovery; engaged stakeholders receive results", async () => {
  const maintained: string[] = [];
  let clock = Date.parse("2026-10-23T12:00:00Z");
  const h = harness({ now: () => clock,
    respond: async ({ actor }) => actor.id === "owner" ? { text: "Mine", claim: true, preparedPrompt: "Implement this" }
      : actor.id === "outsider" ? { text: "Not my area", claim: false, intent: "work", inRole: false } : { text: "Consider caching", claim: false },
    maintain: async ({ actor, event }) => { maintained.push(`${actor.id}:${event.type}`); return { ...actor.memory, rolling: event.type }; } });
  await h.create("owner"); await h.create("outsider"); await h.create("advisor");
  await h.service.submit({ ...request, namedActorIds: ["owner", "outsider", "advisor"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  await h.service.observe(event("runner.result", work.taskSessionId, work.taskTurnId, "done")); await h.service.settled();
  const room = await h.service.getRoom("ws");
  const task = room.events.find(item => item.type === "task.turn_completed")!;
  assert.deepEqual([...task.actorIds].sort(), ["advisor", "outsider", "owner"], "the event still notifies every original stakeholder");
  assert.deepEqual(maintained.sort(), ["advisor:sh.completed", "advisor:task.turn_completed", "owner:sh.completed", "owner:task.turn_completed"]);
  assert.equal(room.memoryErrors.length, 0, "skipped events are not failures");
  const byId = (id: string) => room.actors.find(actor => actor.id === id)!.memory;
  assert.deepEqual(byId("outsider").sourceEventIds, []); assert.equal(byId("outsider").version, 0);
  assert.ok(byId("advisor").sourceEventIds.includes(task.id), "an in-role opinion keeps the stakeholder informed of the result");
  clock += 10 * 60_000;
  assert.equal(await h.service.recoverMemory("ws"), 0);
  assert.equal(maintained.length, 4, "recovery does not retry skipped events");
});

test("concurrent maintenance across services rereads and merges after stale CAS", async () => {
  let calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ maintain: async ({ actor, event }) => {
    if (event.type !== "task.turn_completed") return actor.memory;
    calls++; if (calls <= 2) { if (calls === 2) release(); await barrier; }
    return { ...actor.memory, rolling: `${actor.memory.rolling} ${event.id}` };
  } });
  await h.create("a"); await h.service.submit({ ...request, namedActorIds: ["a"] }); await h.service.settled();
  const work = (await h.service.getRoom("ws")).workItems[0];
  const other = new DomainActorService(h.store, h.deps);
  await Promise.all([h.service.observe(event("runner.result", work.taskSessionId, work.taskTurnId, "one")),
    other.observe(event("runner.result", work.taskSessionId, work.taskTurnId, "two"))]);
  await Promise.all([h.service.settled(), other.settled()]);
  const actor = (await h.service.getRoom("ws")).actors[0];
  assert.equal(calls, 3); assert.match(actor.memory.rolling, /task:one/); assert.match(actor.memory.rolling, /task:two/);
  assert.equal(actor.memory.version, 3);
});

test("uncertain explicit updates retain their original task target across later delegation", async () => {
  const targets: string[] = [];
  let attempts = 0;
  const h = harness({ updateTask: async ({ workItem }) => { targets.push(workItem.taskSessionId); if (++attempts === 1) throw new Error("Receipt lost"); } });
  await h.create("root"); await h.create("sub", { parentActorId: "root" });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] }); await h.service.settled();
  const update = { ...request, requestId: "followup", taskReference: round.workItemId! };
  await assert.rejects(h.service.submit(update), /Receipt lost/);
  await h.service.assign({ workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", requestId: "delegate" });
  await h.service.submit(update);
  assert.equal(targets.length, 2); assert.equal(targets[0], targets[1]);
  assert.notEqual(targets[0], (await h.service.getRoom("ws")).workItems[0].taskSessionId);
});

test("named single claim uses durable model Decision rather than the stakeholder's literal proposal", async () => {
  const h = harness({ respond: async () => ({ text: "I recommend Astra", claim: true, preparedPrompt: "Implement the requested change.", model: MODEL_CATALOG.astra.id }) });
  await h.create("a", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(h.starts[0].workItem.model, MODEL_CATALOG.luna.id);
  assert.equal(round.replies[0].proposedModel, MODEL_CATALOG.astra.id);
  assert.equal(round.replies[0].model, MODEL_CATALOG.luna.id);
  assert.equal(round.replies[0].modelDecision?.ok, true);
  assert.deepEqual(h.decisions.map(req => req.purpose), ["model_select"]);
  assert.equal(round.replies[0].modelDecisionAudit?.workItemId, `${round.id}:claim:a`);
  const question = h.decisions[0].questions[0];
  assert.ok(question.kind === "choice");
  assert.deepEqual(Object.keys(question.options), [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id]);
  await h.service.settled();
});

test("a claiming actor's explicit allowed model is final and Decision only assesses workflow", async () => {
  const h = harness({ respond: async () => ({ text: "Apply the stated mapping", claim: true, preparedPrompt: "Apply the stated project mapping.", model: MODEL_CATALOG.sol61.id }) });
  await h.create("a", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id, MODEL_CATALOG.astra.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(h.starts[0].workItem.model, MODEL_CATALOG.sol61.id);
  assert.equal(round.replies[0].modelSource, "actor");
  assert.deepEqual(h.decisions.map(req => req.questions.map(question => question.id)), [["workflow"]]);
  await h.service.settled();
});

test("a failed workflow Decision does not block an actor-chosen model", async () => {
  const h = harness({ respond: async () => ({ text: "Rename it", claim: true, preparedPrompt: "Rename the setting.", model: MODEL_CATALOG.luna.id }) });
  await h.create("a", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  h.deps.decide = async () => { throw new Error("Decision backend unavailable"); };
  await h.service.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(h.starts[0].workItem.model, MODEL_CATALOG.luna.id);
  await h.service.settled();
});

test("an actor that omits model falls back to the Decision with tier options", async () => {
  const h = harness();
  await h.create("a", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["a"] });
  assert.equal(round.replies[0].modelSource, "decision");
  assert.deepEqual(h.decisions[0].questions.map(question => question.id), ["model", "workflow"]);
  await h.service.settled();
});

test("an assigning actor's explicit allowed model is final", async () => {
  const h = harness();
  await h.create("root", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  await h.create("sub", { parentActorId: "root", allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] }); await h.service.settled();
  const before = h.decisions.length;
  const work = await h.service.assign({ workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", model: MODEL_CATALOG.sol61.id, requestId: "delegate" });
  assert.equal(work.model, MODEL_CATALOG.sol61.id);
  assert.deepEqual(h.decisions.slice(before).map(req => req.questions.map(question => question.id)), [["workflow"]]);
  await h.service.settled();
});

test("a failed winning claim model Decision retains every SH reply without selecting a loser's model", async () => {
  const h = harness(); await h.create("a"); await h.create("b");
  const decide = h.deps.decide;
  let failedCalls = 0;
  h.deps.decide = async req => {
    if (req.purpose === "model_select" && JSON.parse(req.state).owner.id === "a") {
      failedCalls++; return { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] };
    }
    return decide(req);
  };
  const round = await h.service.submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(round.status, "routing_failed"); assert.equal(round.ownerActorId, null);
  assert.deepEqual(round.replies.map(reply => reply.text), ["I can do this", "I can do this"]);
  assert.equal(round.routingDecisions.models?.a.ok, false); assert.equal(round.routingDecisions.models?.b, undefined);
  assert.equal(h.starts.length, 0); assert.ok(h.decisions.some(req => req.purpose === "claim_tiebreak"));
  await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a", "b"] });
  assert.equal(failedCalls, 1); assert.equal(h.starts.length, 0);
  await h.service.settled();
});

test("crash after durable model Decision reuses its result without collecting SH replies again", async () => {
  const h = harness(); await h.create("a", { allowedModels: [MODEL_CATALOG.luna.id] });
  const decide = h.deps.decide;
  let crash = true;
  h.deps.decide = async req => {
    const result = await decide(req);
    if (req.purpose === "model_select" && crash) { crash = false; throw new Error("Crash after durable model result"); }
    return result;
  };
  await assert.rejects(h.service.submit({ ...request, namedActorIds: ["a"] }), /Crash after durable/);
  h.deps.respond = async () => { throw new Error("Saved SH response must be reused"); };
  const resumed = await new DomainActorService(h.store, h.deps).submit({ ...request, namedActorIds: ["a"] });
  assert.equal(resumed.replies[0].text, "I can do this"); assert.equal(resumed.replies[0].model, MODEL_CATALOG.luna.id);
  assert.equal(h.decisions.filter(req => req.purpose === "model_select").length, 1); assert.equal(h.starts.length, 1);
});

test("claim model choices use owner/executor permission intersection and an empty intersection never dispatches", async () => {
  const h = harness({ respond: async () => ({ text: "Sub should execute", claim: true, preparedPrompt: "Implement the requested change as the assigned sub-actor.", executorActorId: "sub", model: MODEL_CATALOG.claudeHaiku.id }) });
  await h.create("root", { allowedModels: [MODEL_CATALOG.luna.id, MODEL_CATALOG.sol61.id] });
  await h.create("sub", { parentActorId: "root", model: MODEL_CATALOG.sol61.id, allowedModels: [MODEL_CATALOG.sol61.id, MODEL_CATALOG.claudeHaiku.id] });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] });
  assert.equal(round.replies[0].model, MODEL_CATALOG.sol61.id);
  const question = h.decisions.find(req => req.purpose === "model_select")!.questions[0];
  assert.ok(question.kind === "choice"); assert.deepEqual(Object.keys(question.options), [MODEL_CATALOG.sol61.id]);
  await h.service.updateActor("ws", "root", { allowedModels: [MODEL_CATALOG.luna.id] });
  const empty = await h.service.submit({ ...request, requestId: "empty-intersection", namedActorIds: ["root"] });
  assert.equal(empty.status, "routing_failed"); assert.equal(empty.replies[0].text, "Sub should execute"); assert.equal(h.starts.length, 1);
  await h.service.settled();
});

test("runtime assignment treats model as a proposal and restricts its Decision to both actors", async () => {
  const h = harness(); await h.create("root", { allowedModels: [MODEL_CATALOG.luna.id] }); await h.create("sub", { parentActorId: "root" });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] });
  const input = { workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", model: MODEL_CATALOG.astra.id, requestId: "assignment" };
  const work = await h.service.assign(input);
  assert.equal(work.model, MODEL_CATALOG.luna.id); assert.equal(work.assignmentRequests[0].proposedModel, MODEL_CATALOG.astra.id);
  assert.equal(work.assignmentRequests[0].modelDecision?.ok, true);
  const calls = h.decisions.length;
  await new DomainActorService(h.store, h.deps).assign(input);
  assert.equal(h.decisions.length, calls); assert.equal(h.starts.length, 2);
  const question = h.decisions.find(req => req.audit.workItemId?.includes(":assignment:"))!.questions[0];
  assert.ok(question.kind === "choice"); assert.deepEqual(Object.keys(question.options), [MODEL_CATALOG.luna.id]);
  await assert.rejects(h.service.assign({ ...input, model: MODEL_CATALOG.sol61.id }), /reused with different input/);
  await h.service.settled();
});

test("failed assignment model Decision persists failure and preserves the current executor session", async () => {
  const h = harness(); await h.create("root"); await h.create("sub", { parentActorId: "root" });
  const round = await h.service.submit({ ...request, namedActorIds: ["root"] });
  const original = (await h.service.getRoom("ws")).workItems[0];
  let calls = 0;
  h.deps.decide = async () => { calls++; return { ok: false, attempts: [{ backend: "fake", reason: "http_error" }] }; };
  const input = { workspaceId: "ws", workItemId: round.workItemId!, executorActorId: "sub", requestId: "assignment" };
  await assert.rejects(h.service.assign(input), /existing work was preserved/);
  await assert.rejects(new DomainActorService(h.store, h.deps).assign(input), /existing work was preserved/);
  const work = (await h.service.getRoom("ws")).workItems[0];
  assert.equal(work.taskSessionId, original.taskSessionId); assert.equal(work.executorActorId, "root"); assert.equal(work.executionHistory.length, 0);
  assert.equal(h.starts.length, 1); assert.equal(calls, 1); assert.equal(work.assignmentRequests[0].modelDecision?.ok, false);
  await h.service.settled();
});

test("a cancelled approval clears needs_user, but another pending approval keeps it", async () => {
  const h = harness(); await h.create("a"); await h.service.submit(request);
  const work = (await h.service.getRoom("ws")).workItems[0];
  let n = 0;
  const emit = (type: string, approvalId: string, extra: object = {}) => h.service.observe({ eventId: `e${++n}`, type, workspaceId: "ws",
    sessionId: work.taskSessionId, turnId: work.taskTurnId, payload: { approvalId, ...extra }, timestamp: new Date(Date.now() + n).toISOString() } as never);
  const status = async () => (await h.service.getRoom("ws")).workItems[0].status;
  await emit("runner.approval.requested", "x"); await emit("runner.approval.requested", "y");
  assert.equal(await status(), "needs_user");
  await emit("runner.approval.resolved", "x", { decision: "cancel" });
  assert.equal(await status(), "needs_user");
  await emit("runner.approval.resolved", "y", { decision: "cancel" });
  assert.equal(await status(), "started");
  assert.deepEqual((await h.service.getRoom("ws")).workItems[0].pendingApprovalIds, []);
});

test("Cancel ends only the targeted failed launch: retry, restart recovery and references never relaunch it", async () => {
  let fail = true;
  const stops: string[] = [], updates: string[] = [];
  const h = harness({ stopTaskSession: async sessionId => { stops.push(sessionId); }, updateTask: async input => { updates.push(input.workItem.id); },
    startTask: async input => { h.starts.push(input); if (fail) throw new Error("queue unavailable"); return { sessionId: input.sessionId, turnId: input.turnId }; } });
  await h.create("a"); await h.create("b");
  const first = { ...request, namedActorIds: ["a"] }, second = { ...request, requestId: "other", namedActorIds: ["b"] };
  await h.service.submit(first); await h.service.submit(second);
  let [target, other] = (await h.service.getRoom("ws")).workItems;
  assert.equal(target.status, "failed"); assert.equal(other.status, "failed");
  assert.deepEqual(actorSummary(await h.service.getRoom("ws"), []).actors.map(actor => actor.counts), [{ open: 0, attention: 1 }, { open: 0, attention: 1 }]);

  const cancelled = await h.service.cancelWork("ws", target.id);
  assert.ok(cancelled.cancelledAt); assert.equal(cancelled.status, "failed");
  assert.match(cancelled.dispatchError!, /queue unavailable/, "the launch error is kept for history");
  assert.deepEqual(stops, [target.taskSessionId], "an unconfirmed launch may have queued a turn, so its session is stopped");
  assert.equal((await h.service.cancelWork("ws", target.id)).cancelledAt, cancelled.cancelledAt, "repeating Cancel is idempotent");
  assert.deepEqual(stops, [target.taskSessionId, target.taskSessionId], "a repeated Cancel re-attempts the leftover stop");
  await assert.rejects(h.service.cancelWork("ws", "missing"), /not found/);

  [target, other] = (await h.service.getRoom("ws")).workItems;
  assert.equal(other.cancelledAt, undefined, "another actor's failed task is untouched");
  assert.deepEqual(actorSummary(await h.service.getRoom("ws"), []).actors.map(actor => actor.counts), [{ open: 0, attention: 0 }, { open: 0, attention: 1 }]);

  fail = false;
  const starts = h.starts.length;
  const restarted = new DomainActorService(h.store, h.deps);
  await restarted.submit(first); await restarted.submit(second);
  assert.equal(await restarted.resumeBlockedWork("ws"), 0);
  assert.deepEqual(h.starts.slice(starts).map(start => start.workItem.id), [other.id], "only the other task relaunches");
  await assert.rejects(restarted.submit({ ...request, requestId: "reference", userPrompt: "Continue", taskReference: target.id }), /cancelled/);
  assert.deepEqual(updates, []);
  const room = await restarted.getRoom("ws");
  assert.equal(room.workItems.length, 2); assert.equal(room.rounds.length, 2, "rounds and work items are preserved");
  assert.equal(room.workItems[0].dispatched, false); assert.ok(room.workItems[0].cancelledAt);
});

test("Cancel of a runner-failed task stops its session turns, survives later events and is never a continuation target", async () => {
  const stops: string[] = [], deliveries: string[] = [];
  const h = harness({ stopTaskSession: async sessionId => { stops.push(sessionId); }, updateTask: async input => { deliveries.push(input.workItem.id); } });
  await h.create("a");
  await h.service.submit({ ...request, namedActorIds: ["a"] });
  let work = (await h.service.getRoom("ws")).workItems[0];
  await h.service.observe(event("runner.runner.started", work.taskSessionId, work.taskTurnId, "started"));
  await assert.rejects(h.service.cancelWork("ws", work.id), /Only a failed task/, "a running task is stopped, not cancelled");
  assert.deepEqual(stops, []);
  await h.service.observe(event("runner.error", work.taskSessionId, work.taskTurnId, "failed", "2026-10-22T22:01:00Z"));
  assert.equal((await h.service.getRoom("ws")).workItems[0].status, "failed");
  await h.service.cancelWork("ws", work.id);
  assert.deepEqual(stops, [work.taskSessionId]);
  // A leftover retry of the same turn reports in later; history records it but the task stays cancelled.
  await h.service.observe(event("runner.runner.started", work.taskSessionId, work.taskTurnId, "late-retry", "2026-10-22T22:02:00Z"));
  const room = await h.service.getRoom("ws");
  work = room.workItems[0];
  assert.ok(work.cancelledAt); assert.ok(room.events.some(event => event.id === "task:late-retry"));
  assert.deepEqual(actorSummary(room, []).actors[0].counts, { open: 0, attention: 0 });
  await h.service.submit({ ...request, requestId: "follow-up", userPrompt: "Remove another Composer hint", namedActorIds: ["a"] });
  assert.deepEqual(deliveries, [], "a cancelled task is never continued");
  assert.equal(h.starts.length, 2, "the follow-up starts a new task");
});
