import assert from "node:assert/strict";
import test from "node:test";
import type { ActorRoom, ActorRoomEvent, ActorRound, ActorWorkItem, DomainActor } from "../domainActors";
import { actorDialogRounds, actorGroupRecipients,actorMentionPreview, actorOwnedSessions, actorOwnerExplanation, actorRoundWorkItems, actorStoppableTurns, actorTaskPresentation, actorTreeIds, actorWorkloadBadge } from "./actorRoomPresentation";

const treeActor = (id: string, parentActorId: string | null = null) => ({ id, name: id.toUpperCase(), parentActorId, rootActorId: parentActorId ?? id }) as DomainActor;
const tree = [treeActor("a"), treeActor("a1", "a"), treeActor("a2", "a"), treeActor("b"), treeActor("b1", "b")];
const dialogRound = (id: string, fields: Partial<ActorRound> = {}) => ({ id, namedActorIds: [], stakeholderIds: [], replies: [], ownerActorId: null, ...fields }) as ActorRound;
const work = (id: string, fields: Partial<ActorWorkItem> = {}) => ({ id, roundId: "r", ownerActorId: "a", executorActorId: "a", taskSessionId: `s-${id}`, status: "started", updated: "2026-10-23T10:00:00.000Z", executionHistory: [], ...fields }) as ActorWorkItem;

test("a continuation shows the live existing task under its new reply without creating or duplicating a task card", () => {
  const existing = work("existing", { roundId: "old", status: "started" });
  const unrelated = work("other", { roundId: "other" });
  const room = { workItems: [existing, unrelated] } as ActorRoom;
  const round = dialogRound("followup", { workItemIds: [existing.id], continuation: {
    decision: { ok: false, attempts: [] }, workItem: { ...existing, status: "completed" }
  } });
  assert.deepEqual(actorRoundWorkItems(room, round), [existing]);
  assert.equal(actorRoundWorkItems(room, round)[0].status, "started", "display live state rather than the old delivery snapshot");
  assert.deepEqual(actorRoundWorkItems(room, dialogRound("old")), [existing]);
});

test("actor trees: a root covers its subs; a sub covers only itself", () => {
  assert.deepEqual([...actorTreeIds(tree, "a")].sort(), ["a", "a1", "a2"]);
  assert.deepEqual([...actorTreeIds(tree, "a1")], ["a1"]);
  assert.deepEqual([...actorTreeIds(tree, "missing")], ["missing"]);
});

test("individual dialog keeps only rounds addressed solely to the actor", () => {
  const rounds = [dialogRound("only-a", { namedActorIds: ["a"] }), dialogRound("a-and-b", { namedActorIds: ["a", "b"] }), dialogRound("only-a1", { namedActorIds: ["a1"] })];
  assert.deepEqual(actorDialogRounds({ rounds, actors: tree }, tree[0], "individual").map(round => round.id), ["only-a"]);
  assert.deepEqual(actorDialogRounds({ rounds, actors: tree }, tree[1], "individual").map(round => round.id), ["only-a1"]);
});

test("group dialog includes tree participation by stakeholder, reply or owner, never individual rounds", () => {
  const rounds = [
    dialogRound("private", { namedActorIds: ["a"], stakeholderIds: ["a"], replies: [{ actorId: "a", status: "opinion", text: "" }] }),
    dialogRound("stakeholder", { stakeholderIds: ["a"] }),
    dialogRound("sub-reply", { replies: [{ actorId: "a1", status: "claimed", text: "" }] }),
    dialogRound("sub-owner", { ownerActorId: "a2" }),
    dialogRound("other-tree", { stakeholderIds: ["b"], replies: [{ actorId: "b1", status: "opinion", text: "" }], ownerActorId: "b" }),
    dialogRound("sub-private", { namedActorIds: ["a1"], stakeholderIds: ["a1"] })
  ];
  assert.deepEqual(actorDialogRounds({ rounds, actors: tree }, tree[0], "group").map(round => round.id), ["stakeholder", "sub-reply", "sub-owner", "sub-private"]);
  // A sub-actor's group view only uses its own participation.
  assert.deepEqual(actorDialogRounds({ rounds, actors: tree }, tree[1], "group").map(round => round.id), ["sub-reply"]);
});

test("owned sessions: roots by tree ownership, subs by execution, with history deduplicated", () => {
  const workItems = [
    work("own", { updated: "2026-10-23T09:00:00.000Z" }),
    work("delegated", { executorActorId: "a1", updated: "2026-10-23T11:00:00.000Z", executionHistory: [
      { executorActorId: "a", model: "m", taskSessionId: "s-old", taskTurnId: "t", dispatchKey: "k", dispatched: true, status: "failed" },
      { executorActorId: "a1", model: "m", taskSessionId: "s-delegated", taskTurnId: "t", dispatchKey: "k", dispatched: true, status: "started" }] }),
    work("sub-owned", { ownerActorId: "a2", executorActorId: "a2", taskSessionId: "s-old" }),
    work("other", { ownerActorId: "b", executorActorId: "a1", updated: "2026-10-23T08:00:00.000Z" })
  ];
  const root = actorOwnedSessions({ workItems, actors: tree }, tree[0]);
  assert.deepEqual(root.map(entry => [entry.sessionId, entry.current, entry.executorActorId]), [
    ["s-delegated", true, "a1"], ["s-old", true, "a2"], ["s-own", true, "a"]]);
  const sub = actorOwnedSessions({ workItems, actors: tree }, tree[1]);
  assert.deepEqual(sub.map(entry => [entry.sessionId, entry.current, entry.status]), [["s-delegated", true, "started"], ["s-other", true, "started"]]);
  const history = actorOwnedSessions({ workItems: [work("w", { taskSessionId: "s-new", executionHistory: [
    { executorActorId: "a", model: "m", taskSessionId: "s-first", taskTurnId: "t", dispatchKey: "k", dispatched: true, status: "failed" },
    { executorActorId: "a", model: "m", taskSessionId: "s-first", taskTurnId: "t2", dispatchKey: "k2", dispatched: true, status: "failed" }] })], actors: tree }, tree[0]);
  assert.deepEqual(history.map(entry => [entry.sessionId, entry.current, entry.status]), [["s-new", true, "started"], ["s-first", false, "failed"]]);
  // A sub only sees history it executed itself.
  const subHistory = actorOwnedSessions({ workItems: [work("w", { executorActorId: "a", executionHistory: [
    { executorActorId: "a1", model: "m", taskSessionId: "s-a1", taskTurnId: "t", dispatchKey: "k", dispatched: true, status: "failed" }] })], actors: tree }, tree[1]);
  assert.deepEqual(subHistory.map(entry => [entry.sessionId, entry.current, entry.executorActorId]), [["s-a1", false, "a1"]]);
});

test("group recipients put the actor first, deduplicate and require another actor", () => {
  assert.deepEqual(actorGroupRecipients({ id: "a" }, []), { ids: ["a"], ready: false, tooMany: false });
  assert.deepEqual(actorGroupRecipients({ id: "a" }, [{ id: "a" }]), { ids: ["a"], ready: false, tooMany: false });
  assert.deepEqual(actorGroupRecipients({ id: "a" }, [{ id: "b" }, { id: "a" }, { id: "b" }, { id: "c" }]), { ids: ["a", "b", "c"], ready: true, tooMany: false });
  const seven = ["1", "2", "3", "4", "5", "6", "7"].map(id => ({ id }));
  assert.equal(actorGroupRecipients({ id: "a" }, seven).tooMany, false);
  assert.equal(actorGroupRecipients({ id: "a" }, [...seven, { id: "8" }]).tooMany, true);
  assert.equal(actorGroupRecipients({ id: "a" }, [...seven, { id: "a" }]).tooMany, false);
});

test("workload badge always shows open work and only shows attention when needed", () => {
  assert.deepEqual(actorWorkloadBadge({ open: 3, attention: 1 }), { open: "Open 3", attention: "Needs you 1" });
  assert.deepEqual(actorWorkloadBadge({ open: 0, attention: 0 }), { open: "Open 0", attention: null });
});

test("mentions preserve longer-name precedence, direct sub actors and reject over eight", () => {
  const actors = ["Robin", "Robin 2", "UI", "A", "B", "C", "D", "E", "F"].map((name, index) => ({ id: String(index), name, parentActorId: index ? "0" : null }) as DomainActor);
  assert.deepEqual(actorMentionPreview("Please @Robin 2 and @UI: give advice", actors).named.map(actor => actor.name), ["Robin 2", "UI"]);
  assert.equal(actorMentionPreview(actors.map(actor => `@${actor.name}`).join(" "), actors).tooMany, true);
});

test("claim and assignment never advertise started; require the matching start event", () => {
  const item = { id: "work", status: "claimed", taskSessionId: "session", taskTurnId: "turn" } as ActorWorkItem;
  const started = { type: "task.started", workItemId: "work", taskSessionId: "session", taskTurnId: "turn" } as ActorRoomEvent;
  assert.equal(actorTaskPresentation(item, [started]).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "assigned" }, [started]).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "started" }, []).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "started" }, [{ ...started, workItemId: "other" }]).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "started" }, [started]).started, true);
  assert.equal(actorTaskPresentation({ ...item, status: "started" }, [{ ...started, taskSessionId: "historical-session" }]).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "started", activeTurnId: "new-turn" }, [started]).started, false);
  assert.equal(actorTaskPresentation({ ...item, status: "started", activeTurnId: "new-turn" }, [{ ...started, taskTurnId: "new-turn" }]).started, true);
});

test("a cancelled failed task reads Cancelled, even after a later Stop or event", () => {
  const item = { id: "work", status: "failed", dispatched: true, taskSessionId: "session", taskTurnId: "turn" } as ActorWorkItem;
  assert.equal(actorTaskPresentation(item, []).label, "Failed");
  assert.equal(actorTaskPresentation({ ...item, cancelledAt: "2026-10-26T00:00:00Z", stoppedAt: "2026-10-26T00:00:01Z" }, []).label, "Cancelled");
});

test("owner explanation uses persisted selection and never suggests an error reply claimed", () => {
  const actors = [{ id: "a", name: "Product" }, { id: "b", name: "Platform" }, { id: "c", name: "Failed actor" }] as DomainActor[];
  const round: Pick<ActorRound, "namedActorIds" | "ownerActorId" | "replies" | "routingDecisions"> = { namedActorIds: [], ownerActorId: "b", replies: [{ actorId: "a", status: "claimed", text: "Product scope" }, { actorId: "b", status: "claimed", text: "Platform scope" }, { actorId: "c", status: "error", text: "" }], routingDecisions: { owner: { ok: true, backend: "fake", model: "test", calibrated: true, latencyMs: 0, answers: { owner: { kind: "choice", choice: "b", probabilities: { a: .2, b: .8 }, confidence: .8 } } } } };
  const explanation = actorOwnerExplanation(round, actors);
  assert.match(explanation, /Platform was selected over Product/);
  assert.match(explanation, /Platform 80%/);
  assert.doesNotMatch(explanation, /Failed actor/);
});

test("stoppable turns: only running dispatched tasks of visible rounds, newest active turn", () => {
  const running = (id: string, fields: Partial<ActorWorkItem> = {}) => work(id, { dispatched: true, dispatchError: null, taskTurnId: `t-${id}`, ...fields });
  const items = [
    running("run"),
    running("retried", { activeTurnId: "t-new" }),
    running("done", { status: "completed" }),
    running("stopped", { stoppedAt: "2026-10-23T10:00:00.000Z" }),
    running("resumed", { stoppedAt: "2026-10-23T10:00:00.000Z", lastEventAt: "2026-10-23T10:05:00.000Z" }),
    running("undispatched", { dispatched: false }),
    running("elsewhere", { roundId: "other" }),
    running("child", { hostWorkItemId: "run", taskSessionId: "s-run", taskTurnId: "t-run" })
  ];
  assert.deepEqual(actorStoppableTurns(items, [{ id: "r" }]).map(turn => [turn.workItemId, turn.turnId]), [["run", "t-run"], ["retried", "t-new"], ["resumed", "t-resumed"]]);
  assert.deepEqual(actorStoppableTurns(items, []), []);
  assert.equal(actorTaskPresentation(items[3], []).label, "Stopped");
  assert.equal(actorTaskPresentation(items[4], []).label, "Waiting for start confirmation");
});
