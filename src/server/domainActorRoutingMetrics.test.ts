import assert from "node:assert/strict";
import test from "node:test";
import { emptyActorRoom, type ActorRoom, type ActorWorkItem, type DomainActor } from "../domainActors";
import { actorRoutingMetrics } from "./domainActorRoutingMetrics";

const actor = (id: string, extra: Partial<DomainActor> = {}): DomainActor => ({ type: "worker", id, workspaceId: "ws", rootActorId: id, parentActorId: null,
  name: id, model: "m", effort: "medium", allowedModels: ["m"], created: "2026-11-01T00:00:00Z", updated: "2026-11-01T00:00:00Z",
  memory: { rolePrompt: "Role", roleSummary: "Summary", longTerm: "", rolling: "", version: 0, sourceEventIds: [] }, ...extra });
const work = (id: string, created: string, extra: Partial<ActorWorkItem> = {}): ActorWorkItem => ({ id, roundId: "r", ownerActorId: "a", executorActorId: "a",
  model: "m", dispatchKey: id, taskSessionId: `s-${id}`, taskTurnId: `t-${id}`, status: "completed", dispatchError: null, created, updated: created,
  dispatched: true, dispatchLease: null, executionRevision: 1, executionHistory: [], assignmentRequests: [], ...extra });
const history = (executorActorId: string) => ({ executorActorId, model: "m", taskSessionId: "s", taskTurnId: "t", dispatchKey: "d", dispatched: true, status: "completed" as const });

test("routing metrics count executions, follow-ups, reassignments, handoffs and truncated memory within a window", () => {
  const room: ActorRoom = { ...emptyActorRoom("ws"), actors: [actor("a", { memory: { ...actor("a").memory, longTerm: "長".repeat(2000) } }), actor("b"), actor("c")],
    workItems: [
      work("old", "2026-11-01T00:00:00Z"),
      work("w1", "2026-11-04T01:00:00Z", { executorActorId: "b", executionHistory: [history("a"), history("a"), history("b")] }),
      work("w2", "2026-11-04T02:00:00Z", { executorActorId: "c", handoff: { sourceActorId: "b", sourceSessionId: "s" } }),
      work("w3", "2026-11-04T03:00:00Z")
    ],
    taskUpdates: [{ status: "delivered", workItemId: "w3" }, { status: "delivered", workItemId: "w3" }, { status: "pending", workItemId: "w3" },
      { status: "delivered", workItemId: "old" }] as ActorRoom["taskUpdates"],
    reorganizations: [{ created: "2026-11-04T00:00:00Z" }] as ActorRoom["reorganizations"] };
  const metrics = actorRoutingMetrics(room, { since: "2026-11-04T00:00:00Z" });
  assert.equal(metrics.lastReorganizationAt, "2026-11-04T00:00:00Z");
  const byId = Object.fromEntries(metrics.actors.map(entry => [entry.actorId, entry]));
  assert.deepEqual({ executed: byId.a.executed, followUps: byId.a.followUps, reassignedAway: byId.a.reassignedAway }, { executed: 1, followUps: 2, reassignedAway: 1 });
  assert.deepEqual({ executed: byId.b.executed, reassignedTo: byId.b.reassignedTo, handoffsSent: byId.b.handoffsSent }, { executed: 1, reassignedTo: 1, handoffsSent: 1 });
  assert.deepEqual({ executed: byId.c.executed, handoffsReceived: byId.c.handoffsReceived }, { executed: 1, handoffsReceived: 1 });
  assert.deepEqual(byId.a.truncatedMemoryFields, [{ field: "longTerm", bytes: 6000 }]);
  assert.equal(actorRoutingMetrics(room).actors.find(entry => entry.actorId === "a")!.executed, 2, "no window counts all work");
  assert.equal(actorRoutingMetrics(room, { until: "2026-11-04T00:00:00Z" }).actors.find(entry => entry.actorId === "a")!.followUps, 1);
  assert.throws(() => actorRoutingMetrics(room, { since: "yesterday" }), /ISO/);
});
