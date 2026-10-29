import assert from "node:assert/strict";
import test from "node:test";
import { actorProjectGroups, actorRoomForChat, actorRoundChatKey, emptyActorRoom, type ActorRound, type DomainActor } from "../domainActors";
import { actorAccessibleContextRoundIds, actorConversationHistory } from "./domainActorContext";
import { actorSummary } from "./domainActorSummary";

const worker = (id: string, projectIds?: string[], parentActorId: string | null = null) =>
  ({ type: "worker", id, workspaceId: "ws", rootActorId: parentActorId ?? id, parentActorId, name: id, model: "m", effort: "medium",
    allowedModels: ["m"], ...(projectIds ? { projectIds } : {}),
    memory: { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "", version: 0, sourceEventIds: [] }, created: "", updated: "" }) as DomainActor;
const round = (id: string, extra: Partial<ActorRound> = {}) => ({ id, requestId: id, userPrompt: `prompt ${id}`, namedActorIds: [],
  candidateSnapshots: [], stakeholderIds: [], actorSnapshots: [], routingDecisions: {}, status: "assigned",
  replies: [{ actorId: "a", status: "opinion", text: `reply ${id}` }], ...extra }) as unknown as ActorRound;
const projects = [{ id: "dev", name: "dev" }, { id: "threadex", name: "session-manager" }, { id: "empty", name: "empty" }];

test("workers group by project in registry order, multi-project and unregistered projects, Unassigned last", () => {
  const actors = [worker("a", ["threadex"]), worker("b", ["dev", "threadex"]), worker("sub", undefined, "a"),
    worker("c"), worker("d", []), worker("gone", ["removed"])];
  assert.deepEqual(actorProjectGroups(actors, projects), [
    { key: "dev", projectId: "dev", name: "dev", registered: true, actorIds: ["b"] },
    { key: "threadex", projectId: "threadex", name: "session-manager", registered: true, actorIds: ["a", "b"] },
    { key: "empty", projectId: "empty", name: "empty", registered: true, actorIds: [] },
    { key: "removed", projectId: "removed", name: "removed", registered: false, actorIds: ["gone"] },
    { key: "unassigned", projectId: null, name: "Unassigned", registered: true, actorIds: ["c", "d"] }
  ]);
  const room = { ...emptyActorRoom("ws"), actors };
  const summary = actorSummary(room, [], new Map(), projects);
  assert.deepEqual(summary.groups, actorProjectGroups(actors, projects));
  assert.deepEqual(summary.actors.find(entry => entry.id === "b")?.projectIds, ["dev", "threadex"]);
  assert.equal(summary.actors.find(entry => entry.id === "c")?.projectIds, undefined);
  assert.equal(actorSummary(room, []).groups, undefined, "no registry: the summary still lists actors without groups");
});

test("legacy group history stays readable and is projected without rewriting", () => {
  const legacy = [round("old"), round("bound", { taskBinding: { workspaceId: "ws", cwd: "/dev", projectId: "dev", source: "message" } }),
    round("ws-bound", { taskBinding: { workspaceId: "ws", cwd: "/ws", source: "workspace" } }), round("private", { namedActorIds: ["a"] })];
  const room = { ...emptyActorRoom("ws"), actors: [worker("a")], rounds: legacy };
  const before = structuredClone(room);
  assert.deepEqual(legacy.map(actorRoundChatKey), [null, "dev", null, null]);
  assert.deepEqual(actorRoomForChat(room, "unassigned").rounds.map(item => item.id), ["old", "ws-bound"]);
  assert.deepEqual(actorRoomForChat(room, "dev").rounds.map(item => item.id), ["bound"]);
  assert.deepEqual(actorRoomForChat(room, "threadex").rounds, []);
  assert.deepEqual(room, before, "partitioning never moves or deletes saved rounds");
});

test("two project chats never share history or peer context", () => {
  const rounds = [round("dev-1", { chatProjectId: "dev" }), round("tx-1", { chatProjectId: "threadex" }), round("legacy"),
    round("dev-2", { chatProjectId: "dev" }), round("tx-2", { chatProjectId: "threadex", status: "responding" })];
  const room = { ...emptyActorRoom("ws"), actors: [worker("a", ["dev", "threadex"])], rounds };
  assert.deepEqual([...actorAccessibleContextRoundIds(room, "dev-2", "a")], ["dev-1"]);
  assert.deepEqual(actorConversationHistory(room, "dev-2", "a").map(entry => entry.roundId), ["dev-1"]);
  assert.deepEqual([...actorAccessibleContextRoundIds(room, "tx-2", "a")], ["tx-1"]);
  assert.deepEqual(actorRoomForChat(room, "dev").rounds.map(item => item.id), ["dev-1", "dev-2"]);
  assert.deepEqual(actorRoomForChat(room, "threadex").rounds.map(item => item.id), ["tx-1", "tx-2"]);
});
