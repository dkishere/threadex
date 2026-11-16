import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorWorkItem } from "../domainActors";
import { openActorBlocker, requestActorBlockerUserDecision } from "../actorBlockers";
import { deliverActorBlockerInput } from "./domainActorBlockerInput";
import type { SessionTurnRecord } from "./sessionStore";

function harness() {
  const room = emptyActorRoom("ws");
  room.workItems.push({ id: "work", taskSessionId: "session", taskTurnId: "turn", executorActorId: "actor", roundId: "round" } as ActorWorkItem);
  const { blocker } = openActorBlocker(room, { workItemId: "work", roundId: "round", taskSessionId: "session", ownerActorId: "actor", executorActorId: "actor", kind: "error", source: "agent", description: "Need user choice", by: "actor" }, "2026-01-01T00:00:00Z");
  requestActorBlockerUserDecision(blocker, { question: "Which version?", reason: "Both intentional", options: [{ label: "Local", description: "Keep local changes" }, { label: "Incoming", description: "Keep incoming changes" }] }, "actor", "2026-01-01T00:01:00Z");
  const input = { workspaceId: "ws", blockerId: blocker.id, decisionId: blocker.userDecision!.id };
  const turn = { id: "turn", sessionId: "session", runnerPid: 42, status: "running", runnerLogPath: "log" } as SessionTurnRecord;
  const state = { receipt: "new", writes: 0, sends: [] as Array<{ commandId: string; message: string }>, turn: turn as SessionTurnRecord | null };
  const store = {
    getDomainActorRoom: async () => structuredClone(room), getSession: async () => ({ id: "session", workspaceId: "ws", cwd: "/project" }),
    getLatestRunningTurn: async () => state.turn, getSessionTurn: async () => turn,
    changeDomainActorRoom: async (_id: string, change: (value: typeof room) => unknown) => change(room),
    collaborationSteerReceipt: async () => state.receipt,
    recordSessionTurnEvent: async () => { state.writes++; state.receipt = "pending"; }
  } as unknown as Parameters<typeof deliverActorBlockerInput>[0];
  const control = { alive: () => true, result: () => null, send: async (_turn: SessionTurnRecord, commandId: string, message: string) => {
    state.sends.push({ commandId, message }); state.receipt = "delivered"; return { ok: true };
  } };
  return { room, blocker, input, turn, state, store, control };
}

test("running blocker input uses a stable durable steer receipt without creating work or resending", async () => {
  const h = harness();
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "delivered" });
  assert.equal(h.state.writes, 1); assert.equal(h.state.sends.length, 1);
  assert.equal(h.state.sends[0].commandId, `collab_blocker_${h.input.decisionId}_turn_steer`);
  assert.match(h.state.sends[0].message, /Which version/); assert.equal(h.blocker.userDecision!.turnId, "turn");
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "delivered" });
  assert.equal(h.state.sends.length, 1); assert.equal(h.room.workItems.length, 1);
});

test("only confirmed unsent delivery permits idle continuation, unknown delivery never does", async () => {
  const h = harness(); h.state.turn = null;
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "not_sent" });
  h.state.turn = h.turn; h.state.receipt = "uncertain";
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "uncertain" });
  assert.equal(h.state.sends.length, 0);
  h.state.receipt = "pending"; h.control.alive = () => false;
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "uncertain" });
});

test("payload revision, actor/session reassignment and cancellation are rejected before delivery", async () => {
  for (const change of [(h: ReturnType<typeof harness>) => { h.input.decisionId = "old-decision"; },
    (h: ReturnType<typeof harness>) => { h.room.workItems[0].executorActorId = "other"; },
    (h: ReturnType<typeof harness>) => { h.room.workItems[0].taskSessionId = "other"; },
    (h: ReturnType<typeof harness>) => { h.room.workItems[0].cancelledAt = "now"; }]) {
    const h = harness(); change(h);
    await assert.rejects(deliverActorBlockerInput(h.store, h.input, h.control), /binding changed/);
    assert.equal(h.state.sends.length, 0);
  }
});

test("binding changes during receipt persistence prevent a late steer", async () => {
  const h = harness();
  h.store.recordSessionTurnEvent = async () => { h.room.workItems[0].cancelledAt = "now"; return undefined as never; };
  await assert.rejects(deliverActorBlockerInput(h.store, h.input, h.control), /binding changed/);
  assert.equal(h.state.sends.length, 0);
});

test("an ordinary session running an unrelated mention turn is never steered or queued for this blocker", async () => {
  const h = harness();
  h.room.workItems[0].sessionScope = "turn";
  h.state.turn = { ...h.turn, id: "another-mention-turn" };
  const receipt = await deliverActorBlockerInput(h.store, h.input, h.control);
  assert.equal(receipt.delivery, "pending"); assert.match(receipt.error!, /another task/);
  assert.equal(h.state.sends.length, 0); assert.equal(h.state.writes, 0); assert.equal(h.blocker.userDecision!.turnId, undefined);
});

test("a dispatch timeout preserves its pinned command identity for recovery", async () => {
  const h = harness();
  h.control.send = async (_turn, commandId, message) => { h.state.sends.push({ commandId, message }); throw new Error("receipt timed out"); };
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "pending" });
  h.state.receipt = "uncertain";
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "uncertain" });
  assert.equal(h.state.sends.length, 1); assert.equal(h.state.writes, 1);
});

test("a confirmed unsent old turn retargets the same work's current turn with a fresh command receipt", async () => {
  const h = harness(); h.blocker.userDecision!.turnId = "turn";
  const next = { ...h.turn, id: "next-turn" };
  h.state.turn = next;
  h.store.getSessionTurn = async id => id === "next-turn" ? next : { ...h.turn, status: "done" };
  h.store.collaborationSteerReceipt = async (_commandId, id) => id === "turn" ? "not_sent" : "new";
  const result = await deliverActorBlockerInput(h.store, h.input, h.control);
  assert.equal(result.delivery, "delivered"); assert.equal(h.blocker.userDecision!.turnId, "next-turn");
  assert.equal(h.state.sends.length, 1); assert.match(h.state.sends[0].commandId, /_next-turn_steer$/);
});

test("an uncertain old turn never retargets even when the same work has a newer running turn", async () => {
  const h = harness(); h.blocker.userDecision!.turnId = "turn"; h.state.turn = { ...h.turn, id: "next-turn" }; h.state.receipt = "uncertain";
  assert.deepEqual(await deliverActorBlockerInput(h.store, h.input, h.control), { delivery: "uncertain" });
  assert.equal(h.blocker.userDecision!.turnId, "turn"); assert.equal(h.state.sends.length, 0);
});
