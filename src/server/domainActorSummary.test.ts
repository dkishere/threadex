import assert from "node:assert/strict";
import test from "node:test";
import { ACTOR_SUMMARY_BLOCKER_LIMIT, actorSummary } from "./domainActorSummary";
import type { ActorRoom, ActorRunningSession, ActorWorkItem, DomainActor } from "../domainActors";
import type { ActorBlocker } from "../actorBlockers";

const actor = (id: string, rootActorId: string, parentActorId: string | null) =>
  ({ id, name: `Name ${id}`, rootActorId, parentActorId, model: "gpt-6-luna", memory: { longTerm: "private" } }) as unknown as DomainActor;
const item = (id: string, ownerActorId: string, executorActorId: string, status: ActorWorkItem["status"]) =>
  ({ id, ownerActorId, executorActorId, status }) as ActorWorkItem;
const room = (actors: DomainActor[], workItems: ActorWorkItem[]) =>
  ({ workspaceId: "workspace", revision: 7, actors, workItems, rounds: [] }) as unknown as ActorRoom;
const session = (actorId: string, sessionId: string) =>
  ({ actorId, sessionId, turnId: `${sessionId}-turn`, workItemId: "w", status: "running" }) as ActorRunningSession;

test("summary classifies every work item status into open or attention", () => {
  const statuses: ActorWorkItem["status"][] = ["claimed", "assigned", "started", "completed", "failed", "needs_user"];
  const summary = actorSummary(room([actor("a", "a", null)], statuses.map(status => item(status, "a", "a", status))),
    [{ ...session("a", "s"), workItemId: "needs_user" }]);
  assert.deepEqual(summary.actors[0].counts, { open: 3, attention: 2 });
});

const asking = (id: string, workItemId: string, retryable = false) =>
  ({ id, workItemId, status: "open", updated: "t", taskSessionId: "task", proposals: [], history: [],
    userDecision: { id: `${id}:decision:1`, state: "waiting", question: "q", options: [], reason: "r", created: "t", ...(retryable ? { retryable: true } : {}) } }) as unknown as ActorBlocker;

test("needs_user counts only while a question is still asked or an approval is pending in a live turn", () => {
  const items = ["question", "ended-question", "approval", "approval-turn-ended", "approvals-resolved", "legacy-ended"].map(id => item(id, "a", "a", "needs_user"));
  items[2].pendingApprovalIds = ["x"]; items[3].pendingApprovalIds = ["y"]; items[4].pendingApprovalIds = [];
  const blockers = [asking("b1", "question"), asking("b2", "ended-question", true), asking("b3", "legacy-ended", true), asking("b4", "legacy-ended", true)];
  const live = ["approval", "approvals-resolved"].map(workItemId => ({ ...session("a", `s-${workItemId}`), workItemId }));
  const summary = actorSummary({ ...room([actor("a", "a", null)], items), blockers }, live);
  // question: asked; approval: pending in a live turn. A question that ended unanswered, an approval of an ended turn,
  // resolved approvals, and a needs_user left over after all its questions ended (an earlier replay) do not hold Needs you.
  assert.deepEqual(summary.actors[0].counts, { open: 0, attention: 2 });
});

test("one asked question keeps Needs you while another question of the same work has ended", () => {
  const work = item("w", "a", "a", "needs_user");
  const summary = actorSummary({ ...room([actor("a", "a", null)], [work]), blockers: [asking("ended", "w", true), asking("open", "w")] }, []);
  assert.equal(summary.actors[0].counts.attention, 1);
});

test("a failed attempt superseded by the same executor's later work for the same round is not Needs you", () => {
  const at = (id: string, executor: string, status: ActorWorkItem["status"], roundId: string, created: string, cancelledAt?: string) =>
    ({ ...item(id, "owner", executor, status), roundId, created, ...(cancelledAt ? { cancelledAt } : {}) }) as ActorWorkItem;
  const actors = [actor("owner", "owner", null), actor("x", "x", null), actor("y", "y", null), actor("z", "z", null)];
  const summary = actorSummary(room(actors, [
    at("x-native", "x", "failed", "r1", "2026-11-03T14:12:51Z"), at("x-handoff", "x", "completed", "r1", "2026-11-03T14:15:18Z"),
    at("y-native", "y", "failed", "r1", "2026-11-03T14:12:51Z"), at("y-other-round", "y", "completed", "r2", "2026-11-03T15:00:00Z"),
    at("z-native", "z", "failed", "r1", "2026-11-03T14:12:51Z"), at("z-cancelled-retry", "z", "started", "r1", "2026-11-03T14:20:00Z", "2026-11-03T14:21:00Z")
  ]), []);
  const byId = Object.fromEntries(summary.actors.map(entry => [entry.id, entry.counts.attention]));
  assert.deepEqual(byId, { owner: 2, x: 0, y: 1, z: 1 }, "only another round or a cancelled retry leaves the failure needing the user");
});

test("running counts each actor session once, however many work items share it", () => {
  const running = [session("a", "shared"), { ...session("a", "shared"), workItemId: "w2" }, session("a", "other"), session("b", "shared")];
  const summary = actorSummary(room([actor("a", "a", null), actor("b", "b", null)], []), running);
  assert.deepEqual(summary.actors.map(entry => entry.running), [2, 1]);
});

test("summary includes configured avatars and leaves missing avatars undefined", () => {
  const actors = [{ ...actor("with-avatar", "with-avatar", null), avatar: "data:image/png;base64,example" }, actor("without-avatar", "without-avatar", null)];
  const summary = actorSummary(room(actors, []), []);
  assert.equal(summary.actors[0].avatar, actors[0].avatar);
  assert.equal(summary.actors[1].avatar, undefined);
  assert.equal(JSON.parse(JSON.stringify(summary)).actors[0].avatar, actors[0].avatar);
  assert.equal("avatar" in JSON.parse(JSON.stringify(summary)).actors[1], false);
});

test("sub-actors count executed work while roots roll up owned and executed tree work without duplicates", () => {
  const actors = [actor("root", "root", null), actor("sub", "root", "root"), actor("other", "other", null), actor("other-sub", "other", "other")];
  const summary = actorSummary(room(actors, [
    item("own", "root", "root", "claimed"),
    item("delegated", "root", "sub", "started"),
    item("owned-by-sub", "sub", "other", "needs_user"),
    item("executed-for-other", "other", "sub", "failed"),
    item("other-only", "other", "other-sub", "assigned"),
    item("own", "root", "root", "claimed")
  ]), [{ ...session("other", "s"), workItemId: "owned-by-sub" }]);
  const byId = Object.fromEntries(summary.actors.map(entry => [entry.id, entry.counts]));
  assert.deepEqual(byId.root, { open: 2, attention: 2 }, "root counts own, delegated, sub-owned and sub-executed items once each");
  assert.deepEqual(byId.sub, { open: 1, attention: 1 }, "sub counts only items it executes, not items it owns");
  assert.deepEqual(byId.other, { open: 1, attention: 2 }, "a root counts items it owns even when another tree executes them");
  assert.deepEqual(byId["other-sub"], { open: 1, attention: 0 });
});

test("summary counts running sessions only for the actor running them (no double count in root) and keeps room order, revision and no memory", () => {
  const actors = [actor("sub", "root", "root"), actor("root", "root", null), actor("other", "other", null)];
  const summary = actorSummary(room(actors, []), [session("root", "s1"), session("sub", "s2"), session("sub", "s3"), session("other", "s4"), session("ghost", "s5")]);
  assert.equal(summary.workspaceId, "workspace"); assert.equal(summary.revision, 7);
  assert.deepEqual(summary.actors.map(entry => [entry.id, entry.running]), [["sub", 2], ["root", 1], ["other", 1]]);
  assert.deepEqual(summary.actors[1], { type: "worker", id: "root", name: "Name root", rootActorId: "root", parentActorId: null, model: "gpt-6-luna",
    counts: { open: 0, attention: 0 }, running: 1, unreadConclusions: 0 });
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("summary of a room without actors is empty", () => {
  assert.deepEqual(actorSummary(room([], [item("w", "gone", "gone", "claimed")]), [session("gone", "s")]), { workspaceId: "workspace", revision: 7, actors: [], blockers: [] });
});

const blocker = (id: string, status: ActorBlocker["status"], updated: string, selfClearing = false, taskSessionId = "task") =>
  ({ id, status, updated, selfClearing, taskSessionId, proposals: [], history: [] }) as unknown as ActorBlocker;

test("summary lists active non-self-clearing blockers newest first, titled when known, as copies", () => {
  const blockers = [
    blocker("open", "open", "2026-10-26T01:00:00Z", false, "titled"),
    blocker("escalated", "escalated", "2026-10-26T03:00:00Z"),
    blocker("proposed", "solution_proposed", "2026-10-26T02:00:00Z"),
    blocker("wait", "open", "2026-10-26T09:00:00Z", true),
    ...(["resolved", "dismissed"] as const).map(status => blocker(status, status, "2026-10-26T08:00:00Z"))
  ];
  const source = { ...room([], []), blockers } as ActorRoom;
  const summary = actorSummary(source, [], new Map([["titled", "Fix the build"], ["task", undefined]]));
  assert.deepEqual(summary.blockers.map(entry => [entry.id, entry.taskSessionTitle ?? null]), [["escalated", null], ["proposed", null], ["open", "Fix the build"]]);
  summary.blockers[0].proposals.push({} as ActorBlocker["proposals"][number]);
  assert.equal(blockers[1].proposals.length, 0, "summary entries never alias room state");
});

test("summary blockers are capped at the limit, keeping the newest", () => {
  const blockers = Array.from({ length: ACTOR_SUMMARY_BLOCKER_LIMIT + 5 }, (_, index) =>
    blocker(`b${index}`, "open", new Date(Date.UTC(2026, 9, 26, 0, index)).toISOString()));
  const summary = actorSummary({ ...room([], []), blockers } as ActorRoom, []);
  assert.equal(ACTOR_SUMMARY_BLOCKER_LIMIT, 50);
  assert.equal(summary.blockers.length, ACTOR_SUMMARY_BLOCKER_LIMIT);
  assert.equal(summary.blockers[0].id, `b${ACTOR_SUMMARY_BLOCKER_LIMIT + 4}`);
  assert.equal(summary.blockers.at(-1)!.id, "b5");
});
