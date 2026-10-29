import { emptyActorRoom, type ActorRoom, type DomainActor } from "../../domainActors";
import { DEFAULT_MODEL } from "../../modelCatalog";
import { DomainActorService, type DomainActorDependencies } from "../domainActorService";
import { DomainActorStore, type ActorPersistence } from "../domainActorStore";
import type { RingEvent } from "../eventRingLog";

/** Real producer/store/consumer pipeline; only persistence, task output and review inference are fakes. */
export function actorConclusionFlow(workspaceId = "actors-test") {
  const timestamp = "2026-10-23T12:00:00.000Z";
  const actor = (id: string, name: string, parentActorId: string | null = null): DomainActor => ({
    id, name, workspaceId, parentActorId, rootActorId: parentActorId ?? id, model: DEFAULT_MODEL, effort: "medium", allowedModels: [DEFAULT_MODEL],
    memory: { version: 0, sourceEventIds: [], rolePrompt: "Role", roleSummary: "Domain", longTerm: "", rolling: "" }, created: timestamp, updated: timestamp
  });
  const initial = emptyActorRoom(workspaceId);
  initial.revision = 10;
  initial.actors = [actor("root-1", "Planner"), actor("root-2", "Reviewer"), actor("sub-1", "Planner helper", "root-1")];
  initial.rounds.push({ id: "round", requestId: "request", userPrompt: "Implement the requested change", namedActorIds: ["root-1"],
    candidateSnapshots: [], actorSnapshots: initial.actors, stakeholderIds: ["root-1", "root-2"], replies: [], routingDecisions: {},
    policies: { shPick: { order: ["fake"], threshold: {} }, claimTiebreak: { order: ["fake"], threshold: {} } },
    ownerActorId: "root-1", workItemId: "work", status: "assigned", error: null, created: timestamp, deadline: timestamp, lease: null });
  initial.workItems.push({ id: "work", roundId: "round", ownerActorId: "root-1", executorActorId: "sub-1", model: DEFAULT_MODEL,
    taskSessionId: "task", taskTurnId: "turn", dispatchKey: "work", status: "started", dispatchError: null,
    created: timestamp, updated: timestamp, dispatched: true, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [] });
  const rooms = new Map<string, ActorRoom>([[workspaceId, initial]]);
  const persistence: ActorPersistence = {
    getWorkspace: async id => ({ id }) as Awaited<ReturnType<ActorPersistence["getWorkspace"]>>,
    getDomainActorRoom: async id => structuredClone(rooms.get(id) ?? emptyActorRoom(id)),
    changeDomainActorRoom: async (id, mutate) => {
      const room = structuredClone(rooms.get(id) ?? emptyActorRoom(id));
      const result = mutate(room); room.revision++; rooms.set(id, room); return result;
    },
    getDomainActorRunningSessions: async () => [],
    captureActorCostBaseline: async () => ({ capturedAt: timestamp, usage: [] }),
    getSessionTurn: async id => ({ id, sessionId: "task", userInput: "Implement the requested change", agentResponse: `Verified conclusion for ${id}`,
      status: "done", runnerExitCode: 0 }) as Awaited<ReturnType<ActorPersistence["getSessionTurn"]>>
  };
  let release!: (result: Awaited<ReturnType<NonNullable<DomainActorDependencies["reviewTask"]>>>) => void;
  let entered!: () => void;
  let reviewCalls = 0;
  let started = new Promise<void>(resolve => { entered = resolve; });
  let pending = new Promise<Awaited<ReturnType<NonNullable<DomainActorDependencies["reviewTask"]>>>>(resolve => { release = resolve; });
  const unused = async (): Promise<never> => { throw new Error("Unexpected routing in completion fixture"); };
  const store = new DomainActorStore(persistence);
  const deps: DomainActorDependencies = { decide: unused, policy: () => ({ order: ["fake"], threshold: {} }), respond: unused, startTask: unused,
    maintain: async ({ actor }) => actor.memory, reviewTask: async () => { reviewCalls++; entered(); return pending; } };
  const service = new DomainActorService(store, deps);
  const event = (type: string, turnId = "turn", eventId = `${type}:${turnId}`, timestamp = "2026-10-23T12:01:00.000Z"): Omit<RingEvent, "pos"> =>
    ({ type, eventId, turnId, timestamp, workspaceId, sessionId: "task", payload: {} });
  return { workspaceId, rooms, store, service, deps, event, reviewCalls: () => reviewCalls,
    complete: async (turnId = "turn") => { await service.observe(event("runner.result", turnId)); await started; },
    finish: async (verdict: "passed" | "issues_found" = "passed") => { release({ verdict, issues: verdict === "passed" ? [] : ["Verification is incomplete"] }); await service.settled(); },
    resetReview: () => {
      started = new Promise<void>(resolve => { entered = resolve; });
      pending = new Promise(resolve => { release = resolve; });
    }
  };
}
