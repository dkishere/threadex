import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, UNASSIGNED_ACTOR_PROJECT, type ActorMemoryContent, type ActorRoom, type DomainActor } from "../domainActors";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore, type ActorPersistence } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies } from "./domainActorService";
import { actorHandledTurn, MEMORY_DIGEST_IDLE_MS, MEMORY_DIGEST_MIN_TURNS, MEMORY_DIGEST_RECORD_LIMIT, memoryDigestReadiness, memoryDigestSummariesFor,
  recordMemoryDigest, type ActorMemoryDigestTurn } from "./actorMemoryDigest";
import { actorMemoryDigestModel, actorModelHooks } from "./domainActorRunner";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";

const START = Date.parse("2026-11-01T00:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const memory: ActorMemoryContent = { rolePrompt: "Owns the session list.", roleSummary: "Session list", longTerm: "Sort sessions by created (tx_old).", rolling: "Todo: paginate the list (tx_old)." };

function turn(index: number, overrides: Partial<ActorMemoryDigestTurn> = {}): ActorMemoryDigestTurn {
  return { sessionId: `session-${index}`, turnId: `turn-${index}`, projectKey: "p1", status: "done",
    lastActivityAt: new Date(START + minutes(1) + index * 1000).toISOString(), userInput: `request ${index}`, agentResponse: `result ${index}`,
    changedFiles: [`src/file${index}.ts`], runnerExitCode: 0, ...overrides };
}
const turns = (count: number, overrides: Partial<ActorMemoryDigestTurn> = {}) => Array.from({ length: count }, (_, index) => turn(index, overrides));

function harness(overrides: Partial<DomainActorDependencies> = {}) {
  const rooms = new Map<string, ActorRoom>();
  const persistence: ActorPersistence = {
    getWorkspace: async id => id === "ws" ? { id } as Awaited<ReturnType<ActorPersistence["getWorkspace"]>> : null,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room, []); room.revision++; rooms.set(id, room); return result;
    },
    captureActorCostBaseline: async () => ({ capturedAt: "2026-11-01T00:00:00Z", usage: [] }),
    getDomainActorRunningSessions: async () => [],
    getSessionTurn: async () => null
  };
  const store = new DomainActorStore(persistence);
  const state = { now: START, turns: [] as ActorMemoryDigestTurn[] };
  const summarized: string[] = [];
  const digests: Array<Parameters<NonNullable<DomainActorDependencies["digestMemory"]>>[0]> = [];
  const deps: DomainActorDependencies = {
    policy: () => ({ order: ["fake"], threshold: { fake: 0.5 } }),
    decide: async () => { throw new Error("No decisions in digest tests."); },
    respond: async () => { throw new Error("No replies in digest tests."); },
    maintain: async () => { throw new Error("No event maintenance in digest tests."); },
    startTask: async () => { throw new Error("No tasks in digest tests."); },
    now: () => state.now,
    listDigestTurns: async (_workspaceId, since) => state.turns.filter(item => item.status !== "done" || Date.parse(item.lastActivityAt) > Date.parse(since)),
    summarizeDigestTurn: async ({ turn }) => { summarized.push(turn.turnId); return `Summary of ${turn.turnId}.`; },
    digestMemory: async input => { digests.push(structuredClone(input));
      return { ...input.actor.memory, longTerm: "Sort sessions by last activity (session-3).", rolling: "" }; },
    ...overrides
  };
  const service = new DomainActorService(store, deps);
  const create = async (id: string, model: string = MODEL_CATALOG.luna.id, projectIds?: string[]) => {
    await store.create("ws", { id, name: id, model, memory });
    if (projectIds) await store.update("ws", id, { projectIds });
  };
  return { store, service, state, summarized, digests, create, room: () => store.getRoom("ws") };
}

test("a project digest waits for enough finished turns and an idle project", () => {
  const watermark = new Date(START).toISOString();
  const ready = (input: ActorMemoryDigestTurn[], now: number) => memoryDigestReadiness({ turns: input, projectKey: "p1", watermark, now, minTurns: MEMORY_DIGEST_MIN_TURNS, idleMs: MEMORY_DIGEST_IDLE_MS });
  const idle = START + minutes(30);
  assert.deepEqual(ready(turns(19), idle), { state: "waiting", completedTurns: 19 });
  assert.deepEqual(ready([...turns(20), turn(99, { status: "running" })], idle), { state: "busy", completedTurns: 20 });
  assert.deepEqual(ready([...turns(20), turn(99, { status: "queued" })], idle), { state: "busy", completedTurns: 20 });
  assert.deepEqual(ready(turns(20), START + minutes(10)), { state: "waiting", completedTurns: 20 }, "last activity under 15 minutes ago");
  const due = ready([...turns(20), turn(50, { projectKey: "p2", status: "running" }), turn(51, { lastActivityAt: watermark })], idle);
  assert.equal(due.state, "due");
  assert.ok(due.state === "due");
  assert.equal(due.batch.length, 20, "other projects and turns at the watermark do not count");
  assert.equal(due.watermark, turns(20).at(-1)!.lastActivityAt);
});

test("digest summaries skip turns the actor already processed and include ordinary sessions without a limit", async () => {
  const h = harness();
  await h.create("a");
  await h.store.change("ws", room => {
    room.events.push({ id: "task:handled", workspaceId: "ws", actorIds: ["a"], type: "task.turn_completed", summary: "", created: "2026-11-01T00:00:00Z",
      taskSessionId: "tx_task", taskTurnId: "turn-task" });
    room.events.push({ id: "task:failed-maintenance", workspaceId: "ws", actorIds: ["a"], type: "task.turn_completed", summary: "", created: "2026-11-01T00:00:00Z",
      taskSessionId: "tx_task", taskTurnId: "turn-failed" });
    room.actors[0].memory.sourceEventIds.push("task:handled");
    room.memoryErrors.push({ actorId: "a", eventId: "task:failed-maintenance", error: "failed", created: "2026-11-01T00:00:00Z" });
  });
  const room = await h.room();
  assert.equal(actorHandledTurn(room, "a", "tx_task", "turn-task"), true);
  assert.equal(actorHandledTurn(room, "a", "tx_task", "turn-failed"), false, "a failed maintenance never counts as processed");
  const summary = (sessionId: string, turnId: string) => ({ sessionId, turnId, completedAt: "2026-11-01T00:00:00Z", summary: `${turnId} done.`, changedFiles: [] });
  const ordinary = Array.from({ length: 60 }, (_, index) => summary("ordinary", `t${index}`));
  const selected = memoryDigestSummariesFor(room, "a", [summary("tx_task", "turn-task"), summary("tx_task", "turn-failed"), ...ordinary, { ...summary("blank", "t"), summary: " " }]);
  assert.deepEqual(selected.map(item => item.turnId), ["turn-failed", ...ordinary.map(item => item.turnId)]);
});

test("digest records are capped per actor", () => {
  const room = emptyActorRoom("ws");
  const record = (actorId: string, index: number) => ({ id: `${actorId}:${index}`, actorId, projectKey: "p1", watermark: "w", sourceEventId: "digest:p1:w",
    created: "2026-11-01T00:00:00Z", sources: [], before: { longTerm: "", rolling: "" }, after: { longTerm: `${index}`, rolling: "" } });
  for (let index = 0; index < MEMORY_DIGEST_RECORD_LIMIT + 5; index++) recordMemoryDigest(room, record("a", index));
  recordMemoryDigest(room, record("b", 0));
  recordMemoryDigest(room, record("b", 0));
  assert.equal(room.memoryDigests!.records.filter(item => item.actorId === "a").length, MEMORY_DIGEST_RECORD_LIMIT);
  assert.equal(room.memoryDigests!.records.find(item => item.actorId === "a")!.id, "a:5", "the oldest records are dropped");
  assert.equal(room.memoryDigests!.records.filter(item => item.actorId === "b").length, 1);
});

test("digest runs once per watermark, writes with its digest source and saves the before/after diff", async () => {
  const h = harness();
  await h.create("a", MODEL_CATALOG.luna.id, ["p1"]);
  await h.create("other", MODEL_CATALOG.luna.id, ["p2"]);
  assert.deepEqual(await h.service.digestMemory("ws"), [], "the first pass only starts watermarks");
  const initial = await h.room();
  assert.deepEqual(Object.keys(initial.memoryDigests!.projects).sort(), ["p1", "p2", UNASSIGNED_ACTOR_PROJECT].sort());
  assert.equal(initial.memoryDigests!.projects.p1.watermark, new Date(START).toISOString());

  h.state.turns = [...turns(19), turn(30, { projectKey: "p2" })];
  h.state.now = START + minutes(60);
  assert.deepEqual(await h.service.digestMemory("ws"), [], "19 finished turns are not enough");
  h.state.turns.push(turn(19), turn(40, { status: "running" }));
  assert.deepEqual(await h.service.digestMemory("ws"), [], "a running turn keeps the project busy");
  h.state.turns = h.state.turns.filter(item => item.status === "done");
  h.state.now = Date.parse(turn(19).lastActivityAt) + minutes(5);
  assert.deepEqual(await h.service.digestMemory("ws"), [], "the project has not been idle for 15 minutes");
  h.state.now = Date.parse(turn(19).lastActivityAt) + MEMORY_DIGEST_IDLE_MS;

  const [first, concurrent] = await Promise.all([h.service.digestMemory("ws"), h.service.digestMemory("ws")]);
  await h.service.settled();
  assert.deepEqual([first, concurrent], [["p1"], []], "one digest per project at a time");
  assert.equal(h.summarized.length, 20);
  assert.deepEqual(h.digests.map(input => input.actor.id), ["a"], "only the project's actors are digested");
  assert.equal(h.digests[0].summaries.length, 20);
  assert.deepEqual(h.digests[0].context, { relation: "digest", tree: { parent: null, subActors: [] }, projectId: "p1" });
  assert.deepEqual(h.digests[0].summaries[3], { sessionId: "session-3", turnId: "turn-3", completedAt: turn(3).lastActivityAt, summary: "Summary of turn-3.", changedFiles: ["src/file3.ts"] });

  const watermark = turn(19).lastActivityAt;
  const sourceEventId = `digest:p1:${watermark}`;
  const room = await h.room();
  const actor = room.actors.find(item => item.id === "a")!;
  assert.deepEqual(actor.memory.sourceEventIds, [sourceEventId]);
  assert.equal(actor.memory.version, 1);
  assert.equal(actor.memory.rolePrompt, memory.rolePrompt);
  assert.deepEqual({ watermark: room.memoryDigests!.projects.p1.watermark, pending: room.memoryDigests!.projects.p1.pending }, { watermark, pending: undefined });
  const [record] = room.memoryDigests!.records;
  assert.deepEqual({ ...record, created: undefined }, { id: `${sourceEventId}:a`, actorId: "a", projectKey: "p1", watermark, sourceEventId, created: undefined,
    sources: turns(20).map(({ sessionId, turnId }) => ({ sessionId, turnId })),
    before: { longTerm: memory.longTerm, rolling: memory.rolling }, after: { longTerm: "Sort sessions by last activity (session-3).", rolling: "" } });

  assert.deepEqual(await h.service.digestMemory("ws"), [], "the same turns never run twice");
  assert.equal(h.summarized.length, 20);
  assert.equal(h.digests.length, 1);
});

test("an interrupted digest resumes its watermark and saved summaries without writing an actor twice", async () => {
  const h = harness();
  await h.create("a");
  await h.service.digestMemory("ws");
  h.state.turns = turns(20, { projectKey: UNASSIGNED_ACTOR_PROJECT });
  const watermark = h.state.turns.at(-1)!.lastActivityAt;
  const sourceEventId = `digest:${UNASSIGNED_ACTOR_PROJECT}:${watermark}`;
  await h.store.change("ws", room => {
    room.memoryDigests!.projects[UNASSIGNED_ACTOR_PROJECT].pending = { watermark, started: watermark,
      summaries: [{ sessionId: "session-0", turnId: "turn-0", completedAt: h.state.turns[0].lastActivityAt, summary: "Saved summary.", changedFiles: [] }] };
  });
  await h.create("b");
  await h.store.change("ws", room => { room.actors.find(actor => actor.id === "a")!.memory.sourceEventIds.push(sourceEventId); });
  h.state.now = START + minutes(1);
  assert.deepEqual(await h.service.digestMemory("ws"), [UNASSIGNED_ACTOR_PROJECT], "a pending batch does not wait for idle time");
  await h.service.settled();
  assert.equal(h.summarized.length, 19, "saved summaries are reused");
  assert.deepEqual(h.digests.map(input => input.actor.id), ["b"], "an actor already holding the digest source is skipped");
  assert.equal(h.digests[0].summaries[0].summary, "Saved summary.");
  const room = await h.room();
  assert.equal(room.memoryDigests!.projects[UNASSIGNED_ACTOR_PROJECT].watermark, watermark);
});

test("a digest that changes nothing writes nothing, and a failure is recorded under the digest source", async () => {
  const unchanged = harness({ digestMemory: async input => ({ ...input.actor.memory }) });
  await unchanged.create("a");
  await unchanged.service.digestMemory("ws");
  unchanged.state.turns = turns(20, { projectKey: UNASSIGNED_ACTOR_PROJECT });
  unchanged.state.now = START + minutes(60);
  assert.deepEqual(await unchanged.service.digestMemory("ws"), [UNASSIGNED_ACTOR_PROJECT]);
  await unchanged.service.settled();
  let room = await unchanged.room();
  assert.deepEqual([room.actors[0].memory.version, room.actors[0].memory.sourceEventIds, room.memoryDigests!.records], [0, [], []]);

  const failing = harness({ digestMemory: async () => { throw new Error("Memory digest exceeds context admission budget; previous memory is retained."); } });
  await failing.create("a");
  await failing.service.digestMemory("ws");
  failing.state.turns = turns(20, { projectKey: UNASSIGNED_ACTOR_PROJECT });
  failing.state.now = START + minutes(60);
  await failing.service.digestMemory("ws");
  await failing.service.settled();
  room = await failing.room();
  const watermark = failing.state.turns.at(-1)!.lastActivityAt;
  assert.deepEqual(room.memoryErrors.map(({ actorId, eventId }) => ({ actorId, eventId })), [{ actorId: "a", eventId: `digest:${UNASSIGNED_ACTOR_PROJECT}:${watermark}` }]);
  assert.equal(room.actors[0].memory.version, 0);
  assert.equal(room.memoryDigests!.projects[UNASSIGNED_ACTOR_PROJECT].watermark, watermark, "a recorded failure is final; the watermark moves on");
});

test("rejected digest fields keep the previous value", async () => {
  const h = harness({ digestMemory: async input => ({ ...input.actor.memory, longTerm: "unchanged", rolling: "" }) });
  await h.create("a");
  await h.service.digestMemory("ws");
  h.state.turns = turns(20, { projectKey: UNASSIGNED_ACTOR_PROJECT });
  h.state.now = START + minutes(60);
  await h.service.digestMemory("ws");
  await h.service.settled();
  const room = await h.room();
  assert.deepEqual([room.actors[0].memory.longTerm, room.actors[0].memory.rolling], [memory.longTerm, ""]);
  assert.deepEqual(room.memoryDigests!.records[0].after, { longTerm: memory.longTerm, rolling: "" });
});

test("the digest uses the Terra tier: 6.1 Terra for Codex actors and Sonnet for Claude actors, never changing the role", async () => {
  assert.equal(actorMemoryDigestModel(MODEL_CATALOG.luna.id), MODEL_CATALOG.terra61.id);
  assert.equal(actorMemoryDigestModel(MODEL_CATALOG.sol.id), MODEL_CATALOG.terra61.id);
  assert.equal(actorMemoryDigestModel(MODEL_CATALOG.claudeOpus.id), MODEL_CATALOG.claudeSonnet.id);
  assert.equal(actorMemoryDigestModel(MODEL_CATALOG.claudeHaiku.id), MODEL_CATALOG.claudeSonnet.id);
  const calls: Array<{ task: string; model?: string; prompt: string }> = [];
  let response = JSON.stringify({ longTerm: "New long term (session-1).", rolling: "" });
  const summarizer = { runBackgroundJsonTask: async (_workspaceId: string, task: string, prompt: string, options?: { model?: string }) => {
    calls.push({ task, model: options?.model, prompt }); return response; } } as unknown as SessionSummarizer;
  const store = { getModelContextWindow: async () => null } as unknown as SessionStore;
  const hooks = actorModelHooks(store, summarizer, "http://localhost");
  const actor = (model: string) => ({ id: "a", workspaceId: "ws", model, memory: { ...memory, version: 2, sourceEventIds: [] } }) as unknown as DomainActor;
  const input = (model: string) => ({ actor: actor(model), baseVersion: 2, context: { relation: "digest" as const, tree: { parent: null, subActors: [] }, projectId: "p1" },
    summaries: [{ sessionId: "session-1", turnId: "turn-1", completedAt: "2026-11-01T00:00:00Z", summary: "Done.", changedFiles: [] }] });
  assert.deepEqual(await hooks.digestMemory!(input(MODEL_CATALOG.claudeOpus.id)), { ...memory, longTerm: "New long term (session-1).", rolling: "" });
  await hooks.digestMemory!(input(MODEL_CATALOG.luna.id));
  assert.deepEqual(calls.map(call => [call.task, call.model]), [["actor_memory_digest", MODEL_CATALOG.claudeSonnet.id], ["actor_memory_digest", MODEL_CATALOG.terra61.id]]);
  assert.match(calls[0].prompt, /"relation":"digest"/);
  response = JSON.stringify({ longTerm: "x", rolling: "", rolePrompt: "Rewritten role" });
  await assert.rejects(hooks.digestMemory!(input(MODEL_CATALOG.luna.id)), /Invalid memory digest response fields/);

  response = JSON.stringify({ summary: "Added pagination; the user chose 50 rows per page. Nothing left open." });
  const summary = await hooks.summarizeDigestTurn!({ workspaceId: "ws", projectKey: "p1", turn: turn(1) });
  assert.equal(summary, "Added pagination; the user chose 50 rows per page. Nothing left open.");
  assert.deepEqual([calls.at(-1)!.task, calls.at(-1)!.model], ["actor_memory_digest_summary", MODEL_CATALOG.luna.id]);
  assert.match(calls.at(-1)!.prompt, /src\/file1\.ts/);
});
