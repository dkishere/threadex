import assert from "node:assert/strict";
import test from "node:test";
import type { ActorRoom, ActorWorkItem } from "../domainActors";
import { actorTaskPromptOrigin, normalizePromptOrigin, resolvePromptOrigin } from "./promptOrigin.js";
import type { WaitEventRecord } from "./sessionStore.js";
import { taskEndWakeOrigin } from "./taskEndWait.js";

type Room = Pick<ActorRoom, "actors" | "workItems">;
const work = (extra: Record<string, unknown>) => ({ id: "w", roundId: "r1", ownerActorId: "owner", executorActorId: "exec", ...extra }) as unknown as ActorWorkItem;
const room = (workItems: unknown[] = []): Room => ({
  actors: [{ id: "owner", name: "Owner Actor" }, { id: "exec", name: "Exec Actor" }, { id: "root", name: "Root Actor" }],
  workItems
} as unknown as Room);

test("normalizePromptOrigin rejects non-objects, wrong kind, unknown trigger and origins with no source", () => {
  for (const value of [undefined, null, "x", 1, [], {},
    { kind: "user", trigger: "handoff", sourceActorId: "a" },
    { kind: "inter-actor", trigger: "bogus", sourceActorId: "a" },
    { kind: "inter-actor", sourceActorId: "a" },
    { kind: "inter-actor", trigger: "handoff" },
    { kind: "inter-actor", trigger: "handoff", sourceActorId: "  ", sourceSessionId: "", sourceRoundId: "round" },
    { kind: "inter-actor", trigger: "handoff", sourceActorId: 5, sourceSessionId: {} }]) {
    assert.equal(normalizePromptOrigin(value), undefined, JSON.stringify(value));
  }
});

test("normalizePromptOrigin trims text and drops undefined fields", () => {
  const origin = normalizePromptOrigin({ kind: "inter-actor", trigger: "task-update", sourceActorId: "  a1 ", sourceActorName: " ", sourceSessionId: " s1 ", sourceTurnId: 3, extra: "x" });
  assert.deepEqual(origin, { kind: "inter-actor", trigger: "task-update", sourceActorId: "a1", sourceSessionId: "s1" });
  assert.ok(!Object.hasOwn(origin!, "sourceActorName"));
  assert.equal(normalizePromptOrigin({ kind: "inter-actor", trigger: "recovery", sourceActorId: "a".repeat(300) })!.sourceActorId!.length, 200);
});

test("actorTaskPromptOrigin describes a handoff with its source session", () => {
  const origin = actorTaskPromptOrigin(room(), work({ handoff: { sourceActorId: "root", sourceSessionId: "parent-session" } }));
  assert.deepEqual(origin, { kind: "inter-actor", trigger: "handoff", sourceActorId: "root", sourceActorName: "Root Actor",
    sourceSessionId: "parent-session", sourceRoundId: "r1" });
});

test("actorTaskPromptOrigin describes an assignment child from the parent work item", () => {
  const parent = { id: "p", taskSessionId: "parent-session", taskTurnId: "t-old", activeTurnId: "t-active" };
  const origin = actorTaskPromptOrigin(room([parent]), work({ parentWorkItemId: "p" }));
  assert.deepEqual(origin, { kind: "inter-actor", trigger: "assignment", sourceActorId: "owner", sourceActorName: "Owner Actor",
    sourceSessionId: "parent-session", sourceTurnId: "t-active", sourceRoundId: "r1" });
  const fallback = actorTaskPromptOrigin(room([{ ...parent, activeTurnId: undefined }]), work({ parentWorkItemId: "p" }));
  assert.equal(fallback.sourceTurnId, "t-old");
});

test("actorTaskPromptOrigin describes a Decision dispatch by owner and round without a session", () => {
  const origin = actorTaskPromptOrigin(room(), work({}));
  assert.deepEqual(origin, { kind: "inter-actor", trigger: "decision-dispatch", sourceActorId: "owner", sourceActorName: "Owner Actor", sourceRoundId: "r1" });
  assert.ok(!Object.hasOwn(origin, "sourceSessionId"));
});

test("resolvePromptOrigin never records an origin for a user's own prompt", async () => {
  const raw = { kind: "inter-actor", trigger: "handoff", sourceActorId: "root" };
  assert.equal(await resolvePromptOrigin({ promptOrigin: raw, fromUser: true, workspaceId: "ws" }, async () => { assert.fail("no room read"); }), undefined);
  assert.equal(await resolvePromptOrigin({ promptOrigin: "junk", fromUser: false, workspaceId: "ws" }, async () => room()), undefined);
});

test("resolvePromptOrigin fills actor id and name from the source session's executor", async () => {
  const getRoom = async () => room([{ id: "w", taskSessionId: "src-session", executorActorId: "exec" }]);
  const origin = await resolvePromptOrigin({ promptOrigin: { kind: "inter-actor", trigger: "session-tool", sourceSessionId: "src-session" }, fromUser: false, workspaceId: "ws" }, getRoom);
  assert.deepEqual(origin, { kind: "inter-actor", trigger: "session-tool", sourceSessionId: "src-session", sourceActorId: "exec", sourceActorName: "Exec Actor" });
  const named = await resolvePromptOrigin({ promptOrigin: { kind: "inter-actor", trigger: "session-tool", sourceActorId: "owner" }, fromUser: false, workspaceId: "ws" }, getRoom);
  assert.deepEqual(named, { kind: "inter-actor", trigger: "session-tool", sourceActorId: "owner", sourceActorName: "Owner Actor" });
  const unknown = await resolvePromptOrigin({ promptOrigin: { kind: "inter-actor", trigger: "session-tool", sourceSessionId: "other" }, fromUser: false, workspaceId: "ws" }, getRoom);
  assert.deepEqual(unknown, { kind: "inter-actor", trigger: "session-tool", sourceSessionId: "other" });
});

test("resolvePromptOrigin returns the original origin when the room read fails or is missing", async () => {
  const raw = { kind: "inter-actor", trigger: "concurrent", sourceSessionId: "src-session" };
  const expected = { kind: "inter-actor", trigger: "concurrent", sourceSessionId: "src-session" };
  assert.deepEqual(await resolvePromptOrigin({ promptOrigin: raw, fromUser: false, workspaceId: "ws" }, async () => { throw new Error("db down"); }), expected);
  assert.deepEqual(await resolvePromptOrigin({ promptOrigin: raw, fromUser: false, workspaceId: "ws" }, async () => null), expected);
  assert.deepEqual(await resolvePromptOrigin({ promptOrigin: raw, fromUser: false }, async () => { assert.fail("no workspace"); }), expected);
});

test("taskEndWakeOrigin builds a task-wake origin from the ended session and turn", () => {
  const event = (payload: unknown) => ({ id: "e", workspaceId: "ws", topic: "task.ended", subjectKey: "k", status: "fired", expectedAt: null, payload, firedAt: null, created: "", updated: "" }) as WaitEventRecord;
  assert.deepEqual(taskEndWakeOrigin(event({ sessionId: "blocker", turnId: "blocker-turn" })), { kind: "inter-actor", trigger: "task-wake", sourceSessionId: "blocker", sourceTurnId: "blocker-turn" });
  assert.deepEqual(taskEndWakeOrigin(event({ sessionId: "blocker" })), { kind: "inter-actor", trigger: "task-wake", sourceSessionId: "blocker" });
  assert.equal(taskEndWakeOrigin(event(null)), undefined);
  assert.equal(taskEndWakeOrigin(event({ turnId: "only-turn" })), undefined);
});
