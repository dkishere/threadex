import { randomUUID } from "node:crypto";
import { MODEL_OPTIONS, modelEfforts, normalizeModelId } from "../modelCatalog";
import type { ActorMemoryContent, ActorRoom, CreateDomainActor, DomainActor, UpdateDomainActor } from "../domainActors";
import type { SessionStore } from "./sessionStore";
import { captureActorConclusions, newActorConclusions } from "../actorConclusions";
import { actorTypeForRegistry } from "../actorTypes";
import { actorFollowupTurnId } from "./domainActorContext";
import { parseActorAvatar } from "../actorAvatar";

/** Idempotent projection, including validation before any record is changed. */
export function normalizeWorkerTypes(room: ActorRoom) {
  for (const actor of room.actors) actorTypeForRegistry("domain", actor.type);
  for (const actor of room.actors) actor.type = "worker";
  return room;
}

/** Repairs native child state saved by earlier versions:
 * - A recovery's turn is the idempotent follow-up updateTask queued for its saved request on the host;
 *   recomputing it repairs recoveries without the field or holding a claiming turn's ID.
 * - A child started before run sequences existed gets one: a running run becomes `run-1`, which cannot
 *   collide with earlier hash or agent-ID review keys; an ended run keeps its reviewed key and the next
 *   start becomes `run-2`. */
export function normalizeNativeChildren(room: ActorRoom) {
  for (const work of room.workItems ?? []) {
    const agent = work.nativeAgent;
    if (!agent) continue;
    if (agent.recovery && work.hostWorkItemId) agent.recovery.turnId = actorFollowupTurnId(room.workspaceId, work.hostWorkItemId, agent.recovery.requestId);
    if (agent.runSeq === undefined && agent.startedAt) {
      agent.runSeq = 1;
      if (!agent.endedAt) agent.runId = "run-1";
    }
    if (agent.agentId && !agent.agentIds) agent.agentIds = [agent.agentId];
    // The recorded start event is the evidence, never equal times: an observed start can fail in its own
    // millisecond, and a run opened by its terminal signal never records a start. A start event at the run's
    // start time therefore marks it observed, correcting a `true` an earlier time-only rule persisted; a run
    // saved without the flag and without that event, ending in its start millisecond, was opened by its terminal.
    if (agent.startedAt && agent.startMissed !== false) {
      const observed = room.events?.some(event => event.workItemId === work.id && event.type === "task.started" && event.created === agent.startedAt);
      if (observed) agent.startMissed = false;
      else if (agent.startMissed === undefined && agent.startedAt === agent.endedAt) agent.startMissed = true;
    }
  }
  return room;
}

const normalizeActorRoom = (room: ActorRoom) => normalizeNativeChildren(normalizeWorkerTypes(room));

export type ActorPersistence = Pick<SessionStore, "getDomainActorRoom" | "changeDomainActorRoom" | "getWorkspace" | "captureActorCostBaseline" | "getDomainActorRunningSessions" | "getSessionTurn">;
export class ActorMemoryConflict extends Error {}
export class ActorDeletionConflict extends Error {}
export function actorById(room: ActorRoom, id: string): DomainActor {
  const actor = room.actors.find(actor => actor.id === id);
  if (!actor) throw new Error("Actor not found in this workspace.");
  return actor;
}
export function validateActorMemory(memory: ActorMemoryContent) {
  for (const key of ["rolePrompt", "roleSummary", "longTerm", "rolling"] as const) {
    if (typeof memory[key] !== "string" || memory[key].length > (key === "roleSummary" ? 4000 : 100_000)) throw new Error(`Invalid actor memory ${key}.`);
  }
}
function validateActor(actor: DomainActor) {
  if (!actor.name.trim() || actor.name.length > 80) throw new Error("Actor name must contain 1–80 characters.");
  if (!actor.allowedModels.length || actor.allowedModels.some(model => !MODEL_OPTIONS.includes(model))
    || !actor.allowedModels.includes(actor.model) || !modelEfforts(actor.model).includes(actor.effort as never)) throw new Error("Invalid actor model permissions or effort.");
  validateActorMemory(actor.memory);
}

export class DomainActorStore {
  constructor(readonly persistence: ActorPersistence) {}
  async captureCostBaseline(workspaceId: string) {
    const room = await this.getRoom(workspaceId);
    if (room.costBaseline) return room.costBaseline;
    const baseline = await this.persistence.captureActorCostBaseline(workspaceId);
    return this.change(workspaceId, current => { current.costBaseline ??= baseline; return current.costBaseline; });
  }
  runningSessions(workspaceId: string) { return this.persistence.getDomainActorRunningSessions(workspaceId); }
  async taskOutcome(sessionId: string, turnId: string | null) {
    if (!turnId) return null;
    const turn = await this.persistence.getSessionTurn(turnId);
    return turn?.sessionId === sessionId ? { userPrompt: turn.userInput, result: turn.agentResponse,
      status: turn.status, runnerExitCode: turn.runnerExitCode } : null;
  }
  async getRoom(workspaceId: string): Promise<ActorRoom> {
    if (!await this.persistence.getWorkspace(workspaceId)) throw new Error("Actor workspace not found.");
    const room = normalizeActorRoom(await this.persistence.getDomainActorRoom(workspaceId));
    // Adopt already-passed current results when upgrading an existing room.
    if (!newActorConclusions(room).length) return room;
    await this.change(workspaceId, () => {});
    return normalizeActorRoom(await this.persistence.getDomainActorRoom(workspaceId));
  }
  async change<T>(workspaceId: string, mutate: (room: ActorRoom, runningSessions?: Awaited<ReturnType<ActorPersistence["getDomainActorRunningSessions"]>>) => T,
    options?: { actorLifecycleLock: true }): Promise<T> {
    if (!await this.persistence.getWorkspace(workspaceId)) throw new Error("Actor workspace not found.");
    return this.persistence.changeDomainActorRoom(workspaceId, (room, runningSessions) => {
      normalizeActorRoom(room);
      captureActorConclusions(room);
      const result = mutate(room, runningSessions);
      // Persist the consumed publication in the same transaction as its review.
      captureActorConclusions(room);
      return result;
    }, options);
  }
  async acknowledgeConclusion(workspaceId: string, actorId: string, conclusionId: string): Promise<ActorRoom> {
    await this.change(workspaceId, room => {
      actorById(room, actorId);
      const conclusion = room.conclusions?.find(item => item.id === conclusionId && item.actorId === actorId);
      if (!conclusion) throw new Error("Conclusion not found in this actor's dialog.");
      conclusion.acknowledgedAt ??= new Date().toISOString();
    });
    return this.getRoom(workspaceId);
  }
  /** Dismissal only hides the notice; the failure stays recorded so recovery does not retry it. */
  async dismissMemoryError(workspaceId: string, actorId: string, eventId: string): Promise<ActorRoom> {
    await this.change(workspaceId, room => {
      const entries = room.memoryErrors.filter(entry => entry.actorId === actorId && entry.eventId === eventId);
      if (!entries.length) throw new Error("Memory notice not found.");
      const now = new Date().toISOString();
      for (const entry of entries) entry.dismissedAt ??= now;
    });
    return this.getRoom(workspaceId);
  }
  async create(workspaceId: string, input: CreateDomainActor): Promise<DomainActor> {
    actorTypeForRegistry("domain", input.type);
    const avatar = parseActorAvatar(input.avatar);
    const id = input.id ?? `actor_${randomUUID()}`;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid actor ID.");
    const now = new Date().toISOString();
    return this.change(workspaceId, room => {
      if (room.deletedActors?.some(actor => actor.id === id) || room.actors.some(actor => actor.id === id || actor.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error("Actor ID or name already exists.");
      const parent = input.parentActorId ? actorById(room, input.parentActorId) : null;
      if (parent?.parentActorId) throw new Error("Actors support only one sub-actor level.");
      const actor: DomainActor = { type: "worker", id, workspaceId, rootActorId: parent?.id ?? id, parentActorId: parent?.id ?? null,
        name: input.name.trim(), model: normalizeModelId(input.model), effort: input.effort ?? "medium", ...(avatar === undefined ? {} : { avatar }),
        allowedModels: [...new Set((input.allowedModels ?? MODEL_OPTIONS).map(normalizeModelId))],
        memory: { ...input.memory, version: 0, sourceEventIds: [] }, created: now, updated: now };
      validateActor(actor);
      room.actors.push(actor);
      return actor;
    });
  }
  async delete(workspaceId: string, id: string, runningSessions: Awaited<ReturnType<ActorPersistence["getDomainActorRunningSessions"]>> = []) {
    return this.change(workspaceId, (room, lockedRunningSessions) => {
      runningSessions = lockedRunningSessions ?? runningSessions;
      const actor = actorById(room, id);
      const conflict = (message: string): never => { throw new ActorDeletionConflict(message); };
      if (room.actors.some(other => other.parentActorId === id)) conflict("Delete this worker's sub-workers first.");
      const involves = (work: ActorRoom["workItems"][number]) => work.ownerActorId === id || work.executorActorId === id;
      if (runningSessions.some(session => session.actorId === id || room.workItems.some(work => work.id === session.workItemId && involves(work))))
        conflict("This worker has a running task or follow-up. Finish or stop it before deleting the worker.");
      if (room.workItems.some(work => involves(work) && work.status !== "completed" && !work.cancelledAt))
        conflict("This worker has unfinished work. Complete or explicitly cancel it before deleting the worker.");
      if (room.rounds.some(round => (["queued", "responding"].includes(round.status)
        || round.status === "awaiting_pickup" && room.workItems.some(work => work.roundId === round.id && work.status !== "completed" && !work.cancelledAt))
        && (round.actorSnapshots.some(snapshot => snapshot.id === id) || round.candidateSnapshots.some(snapshot => snapshot.actorId === id)
          || round.namedActorIds.includes(id) || round.stakeholderIds.includes(id))))
        conflict("This worker is involved in an active discussion or task pickup. Finish it before deleting the worker.");
      if (room.workItems.some(work => work.dispatchLease && involves(work)
        || work.nativeAgent?.recovery && involves(work)
        || work.assignmentRequests.some(request => request.status === "pending" && (involves(work) || request.executorActorId === id))
        || work.parallelRequests?.some(request => request.status === "pending" && (involves(work) || request.sourceActorId === id || request.tasks.some(task => task.executorActorId === id)))
        || work.completionReviews?.some(review => review.status === "pending" && (involves(work) || review.actorId === id || review.ownerActorId === id)))
        || room.taskUpdates?.some(update => update.status === "pending" && (involves(update.workItem) || update.namedActorIds.includes(id))))
        conflict("This worker has a pending task operation or review. Finish it before deleting the worker.");
      if (room.blockers?.some(blocker => !["resolved", "dismissed"].includes(blocker.status)
        && (blocker.ownerActorId === id || blocker.executorActorId === id || blocker.proposals.some(proposal => proposal.actorId === id))))
        conflict("This worker has an active blocker. Resolve or dismiss it before deleting the worker.");
      (room.deletedActors ??= []).push({ ...structuredClone(actor), deletedAt: new Date().toISOString() });
      room.actors = room.actors.filter(other => other.id !== id);
      return { deletedActorId: id };
    }, { actorLifecycleLock: true });
  }
  async update(workspaceId: string, id: string, input: UpdateDomainActor): Promise<DomainActor> {
    actorTypeForRegistry("domain", input.type);
    const avatar = input.avatar === null ? null : parseActorAvatar(input.avatar);
    return this.change(workspaceId, room => {
      const actor = actorById(room, id);
      if (avatar === null) delete actor.avatar;
      else if (avatar !== undefined) actor.avatar = avatar;
      // Explicit projection: memory writes and arbitrary request fields cannot alter permissions.
      if (input.name !== undefined) actor.name = input.name.trim();
      if (input.model !== undefined) actor.model = normalizeModelId(input.model);
      if (input.effort !== undefined) actor.effort = input.effort;
      if (input.allowedModels !== undefined) actor.allowedModels = [...new Set(input.allowedModels.map(normalizeModelId))];
      if (input.projectIds !== undefined) {
        if (actor.parentActorId) throw new Error("Sub-actors belong to their root actor's projects.");
        const projectIds = [...new Set(input.projectIds.map(value => value.trim()))];
        if (projectIds.length) actor.projectIds = projectIds; else delete actor.projectIds;
      }
      if (room.actors.some(other => other.id !== id && other.name.toLowerCase() === actor.name.toLowerCase())) throw new Error("Actor name already exists.");
      validateActor(actor);
      actor.updated = new Date().toISOString();
      return actor;
    });
  }
  async updateMemory(input: { workspaceId: string; actorId: string; sourceEventId: string; baseVersion: number; memory: ActorMemoryContent }): Promise<DomainActor> {
    validateActorMemory(input.memory);
    if (!input.sourceEventId) throw new Error("Memory updates require a source event ID.");
    return this.change(input.workspaceId, room => {
      const actor = actorById(room, input.actorId);
      if (actor.memory.sourceEventIds.includes(input.sourceEventId)) return actor;
      if (actor.memory.version !== input.baseVersion) throw new ActorMemoryConflict("Actor memory version changed; reread and merge.");
      actor.memory = { rolePrompt: input.memory.rolePrompt, roleSummary: input.memory.roleSummary,
        longTerm: input.memory.longTerm, rolling: input.memory.rolling, version: actor.memory.version + 1,
        sourceEventIds: [...actor.memory.sourceEventIds, input.sourceEventId] };
      actor.updated = new Date().toISOString();
      return actor;
    });
  }
}
