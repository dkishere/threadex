import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorRound, type DomainActor, type ActorRoomEvent } from "../domainActors";
import { actorTimeline } from "./actorTimeline";

const actor = { id: "a", parentActorId: null } as DomainActor;
const at = (minute: number) => `2026-10-23T10:${String(minute).padStart(2, "0")}:00Z`;
const round = (id: string, minute: number, names: string[]): ActorRound => ({ id, requestId: id, userPrompt: id,
  created: at(minute), deadline: at(9), namedActorIds: names, stakeholderIds: [], replies: [], ownerActorId: null,
  candidateSnapshots: [], actorSnapshots: [], routingDecisions: {}, policies: { shPick: { order: ["fake"], threshold: {} }, claimTiebreak: { order: ["fake"], threshold: {} } },
  workItemId: null, status: "no_claims", error: null, lease: null });
const event = (id: string, minute: number, type: ActorRoomEvent["type"], workItemId: string) => ({ id, created: at(minute), type, workItemId, taskSessionId: workItemId, taskTurnId: "turn", actorIds: ["a"] }) as ActorRoomEvent;

test("interleaves exchanges, concurrent task events and published conclusions; deduplicates replay", () => {
  const room = emptyActorRoom("w"); room.actors = [actor];
  room.rounds = [round("direct", 3, ["a"]), round("group", 0, ["a", "b"]), round("unrelated", 1, ["b"])];
  room.events = [event("end-b", 5, "task.turn_completed", "b"), event("start-a", 1, "task.started", "a"),
    event("end-a", 4, "task.turn_completed", "a"), event("start-b", 2, "task.started", "b"), event("replay", 2, "task.started", "b")];
  const conclusion = { id: "c", actorId: "a", created: at(6), workItemId: "a", taskSessionId: "a", taskTurnId: "turn", reviewId: "review", text: "Reviewed" };
  room.conclusions = [conclusion, conclusion, { ...conclusion, id: "other", actorId: "b" }];
  const entries = actorTimeline(room, actor);
  assert.deepEqual(entries.map(entry => entry.kind), ["conversation", "task", "task", "conversation", "task", "task", "conclusion"]);
  assert.deepEqual(entries.flatMap(entry => entry.kind === "conversation" ? [entry.source] : []), ["group", "direct"]);
  assert.deepEqual(entries, actorTimeline({ ...room, rounds: [...room.rounds].reverse(), events: [...room.events].reverse().filter(e => e.id !== "replay") }, actor));
  room.conclusions = [];
  assert.equal(actorTimeline(room, actor).some(entry => entry.kind === "conclusion"), false, "task completion never creates a review verdict");
});

test("retains historical events and identifies a child's direct chat accurately", () => {
  const room = emptyActorRoom("w"); room.actors = [actor, { id: "child", parentActorId: "a" } as DomainActor];
  room.rounds = [round("child-direct", 1, ["child"])];
  room.events = [event("old", 0, "task.failed", "old")];
  const entries = actorTimeline(room, actor);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].kind === "conversation" && entries[1].source, "direct");
  assert.equal(actorTimeline(room, { id: "outsider", parentActorId: null } as DomainActor).length, 0);
});

test("hides a round the actor declared unrelated unless it was named, claimed or given a task", () => {
  const room = emptyActorRoom("w"); room.actors = [actor];
  const declined = (id: string, minute: number, names: string[], status: "opinion" | "claimed"): ActorRound => ({ ...round(id, minute, names), stakeholderIds: ["a"],
    replies: [{ actorId: "a", status, text: "not mine", intent: "work", inRole: status === "claimed" }] as ActorRound["replies"] });
  room.rounds = [declined("declined", 0, [], "opinion"), declined("named", 1, ["a"], "opinion"), declined("claimed", 2, [], "claimed")];
  assert.deepEqual(actorTimeline(room, actor).map(entry => entry.kind === "conversation" ? entry.round.id : entry.id), ["named", "claimed"]);
});
