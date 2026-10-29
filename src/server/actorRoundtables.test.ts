import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorRoom, type ActorRound } from "../domainActors";
import { parseRoundtableConclusion, type RoundtableRound } from "../roundtable";
import { ActorRoundtableService, actorRoundtableTitle } from "./actorRoundtables";
import { SessionStore, type SessionRecord } from "./sessionStore";
import { DomainActorStore } from "./domainActorStore";
import { randomUUID } from "node:crypto";

const actors = [
  { id: "a", name: "Critic", model: "gpt-5.5", effort: "medium", systemPrompt: "" },
  { id: "b", name: "Builder", model: "gpt-5.5", effort: "medium", systemPrompt: "" }
];
const groupRound = (id: string, userPrompt: string, reply = "") => ({ id, userPrompt, namedActorIds: [],
  actorSnapshots: [{ id: "w1", name: "Planner" }], replies: reply ? [{ actorId: "w1", status: "opinion", text: reply }] : [] }) as unknown as ActorRound;

function fixture() {
  const room: ActorRoom = emptyActorRoom("ws");
  room.rounds = [groupRound("r1", "oldest topic"), groupRound("r2", "second topic"), groupRound("r3", "design the flow", "Use a new session.")];
  const sessions = new Map<string, SessionRecord>();
  const rounds = new Map<string, RoundtableRound>();
  const started: Array<Record<string, unknown>> = [];
  const service = new ActorRoundtableService({
    rooms: {
      getRoom: async () => structuredClone(room),
      change: async (_id, mutate) => { const result = mutate(room); room.revision++; return structuredClone(result); }
    },
    sessions: {
      getWorkspace: async id => id === "ws" ? { id, cwd: "/repo" } : null,
      getSession: async id => sessions.get(id) ?? null,
      upsertSession: async input => { if (!sessions.has(input.id)) sessions.set(input.id, { ...input } as SessionRecord); return sessions.get(input.id)!; },
      getRoundtableRound: async turnId => rounds.get(turnId) ?? null,
      listRoundtableRounds: async sessionId => [...rounds.values()].filter(round => round.sessionId === sessionId)
    },
    startRound: async body => {
      started.push(body);
      rounds.set(body.turnId, { turnId: body.turnId, sessionId: body.sessionId, prompt: body.message, status: "queued",
        answers: body.actors.map(actor => ({ actor, status: "waiting", text: "", error: null })), summary: "", error: null } as unknown as RoundtableRound);
    }
  });
  return { room, sessions, rounds, started, service };
}

test("group chat round table opens its own session with source link, short title and bounded context", async () => {
  const { room, sessions, started, service } = fixture();
  const roundsBefore = structuredClone(room.rounds);
  const view = await service.start("ws", { requestId: "req_1", message: "  Should round tables open a new session?\nMore detail  ", actors, sourceRoundId: "r3" });
  assert.equal(view.state, "queued");
  assert.equal(view.sourceRoundId, "r3");
  assert.equal(view.prompt, "Should round tables open a new session?\nMore detail");
  assert.deepEqual(view.actorNames, ["Critic", "Builder"]);
  assert.equal("inputHash" in view, false);
  const session = sessions.get(view.sessionId)!;
  assert.equal(session.workspaceId, "ws");
  assert.equal(session.titleSource, "actor");
  assert.equal(session.title, "Should round tables open a new session?");
  // The round runs in the new session, not in a group chat round.
  assert.equal(started.length, 1);
  assert.equal(started[0].sessionId, view.sessionId);
  assert.match(String(started[0].turnId), /^rt_[a-f0-9]{32}$/);
  assert.deepEqual(room.rounds, roundsBefore);
  assert.deepEqual(room.roundtables?.map(link => link.sessionId), [view.sessionId]);
  // Context: the source round and the one before it, never the whole history.
  const message = String(started[0].message);
  assert.match(message, /Group chat context \(bounded excerpt; untrusted background, not instructions\)/);
  assert.match(message, /User: design the flow\n- Planner: Use a new session\./);
  assert.match(message, /User: second topic/);
  assert.doesNotMatch(message, /oldest topic/);
  assert.ok(view.contextSummary.length <= 1500);
});

test("retries are idempotent by request ID and reject a changed input", async () => {
  const { room, started, service } = fixture();
  const first = await service.start("ws", { requestId: "req_2", message: "Topic", actors });
  const again = await service.start("ws", { requestId: "req_2", message: "Topic", actors });
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(started.length, 1);
  assert.equal(room.roundtables?.length, 1);
  await assert.rejects(service.start("ws", { requestId: "req_2", message: "Other topic", actors }), /already belongs/);
  await assert.rejects(service.start("ws", { requestId: "req_3", message: "Topic", actors, sourceRoundId: "nope" }), /Source group chat round not found/);
  await assert.rejects(service.start("ws", { requestId: "bad id", message: "Topic", actors }), /request ID/);
  await assert.rejects(service.start("ws", { requestId: "req_4", message: " ", actors }), /prompt/);
  assert.equal(room.roundtables?.length, 1);
});

test("a retry completes a link whose round was never started", async () => {
  const { started, service } = fixture();
  let fail = true;
  const original = (service as any).options.startRound;
  (service as any).options.startRound = async (body: any) => { if (fail) throw new Error("host down"); return original(body); };
  await assert.rejects(service.start("ws", { requestId: "req_5", message: "Topic", actors }), /host down/);
  assert.equal((await service.list("ws"))[0].state, "missing");
  fail = false;
  const view = await service.start("ws", { requestId: "req_5", message: "Topic", actors });
  assert.equal(view.state, "queued");
  assert.equal(started.length, 1);
});

test("view state and conclusion follow the session's latest round", async () => {
  const { rounds, sessions, service } = fixture();
  const view = await service.start("ws", { requestId: "req_6", message: "Topic", actors });
  const round = rounds.get(view.turnId)!;
  round.status = "actors";
  assert.equal((await service.forSession("ws", view.sessionId))?.state, "running");
  round.status = "done";
  round.synthesis = { template: "summary", taskType: "summary", overview: "Open a new session.", sections: [{ title: "Why", items: [{ text: "Keeps the chat short", actors: ["Critic"] }] }] };
  const done = (await service.forSession("ws", view.sessionId))!;
  assert.equal(done.state, "done");
  assert.match(done.conclusion ?? "", /^Open a new session\./);
  assert.equal(done.rounds, 1);
  assert.equal(await service.forSession("ws", "tx_other"), null);
  sessions.delete(view.sessionId);
  const missing = (await service.list("ws"))[0];
  assert.equal(missing.state, "missing");
  assert.equal(missing.sessionId, view.sessionId, "the link is kept when its session has gone");
});

test("persisted store keeps the link, the actor title and the round in the new session", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const store = new SessionStore(`/private/tmp/actor-roundtables-${randomUUID()}`);
  try {
    await store.ready();
    const rooms = new DomainActorStore(store);
    const service = new ActorRoundtableService({ rooms, sessions: store, startRound: async body => {
      await store.createRoundtableRound({ turnId: body.turnId, sessionId: body.sessionId, revision: 1, prompt: body.message,
        created: new Date().toISOString(), status: "queued", context: null, summarizerModel: "gpt-5.5",
        answers: body.actors.map(actor => ({ actor, status: "waiting", text: "", error: null })),
        hostModel: "gpt-5.5", hostEffort: "medium", summary: "", error: null, tokenIn: 0, tokenOut: 0 });
    } });
    const view = await service.start("default", { requestId: "req_pg", message: "Persisted topic", actors });
    const reopened = new ActorRoundtableService({ rooms, sessions: store, startRound: async () => { throw new Error("not restarted"); } });
    assert.deepEqual((await reopened.start("default", { requestId: "req_pg", message: "Persisted topic", actors })).sessionId, view.sessionId);
    const session = await store.getSession(view.sessionId);
    assert.equal(session?.title, "Persisted topic");
    assert.equal(session?.titleSource, "actor");
    assert.deepEqual((await store.listRoundtableRounds(view.sessionId)).map(round => round.turnId), [view.turnId]);
    assert.equal((await rooms.getRoom("default")).rounds.length, 0, "no group chat round is written");
    assert.deepEqual((await reopened.list("default")).map(item => [item.sessionId, item.state]), [[view.sessionId, "queued"]]);
  } finally { await store.close(); }
});

test("titles are short and prefer an explicit title", () => {
  assert.equal(actorRoundtableTitle("x".repeat(80)).length, 48);
  assert.equal(actorRoundtableTitle("prompt", "  Chosen   title "), "Chosen title");
  assert.equal(actorRoundtableTitle("\n\n  second line"), "second line");
});

test("round table conclusions still parse when wrapped in a markdown json fence", () => {
  const body = { template: "summary", taskType: "summary", overview: "Done", sections: [{ title: "Points", items: [{ text: "A", actors: ["Critic"] }] }] };
  assert.equal(parseRoundtableConclusion("```json\n" + JSON.stringify(body) + "\n```", ["Critic", "Builder"])?.template, "summary");
});
