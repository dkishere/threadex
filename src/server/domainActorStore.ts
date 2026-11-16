import { randomUUID } from "node:crypto";
import { MODEL_OPTIONS, modelEfforts, normalizeModelId } from "../modelCatalog";
import type { ActorMemoryContent, ActorRoom, CreateDomainActor, DomainActor, UpdateDomainActor } from "../domainActors";
import type { SessionStore } from "./sessionStore";
import { captureActorConclusions, newActorConclusions } from "../actorConclusions";
import { actorTypeForRegistry } from "../actorTypes";
import { actorFollowupTurnId } from "./domainActorContext";
import { parseActorAvatar } from "../actorAvatar";
import { actorProjectIds } from "../domainActors";
import { normalizeMemoryDigests } from "./actorMemoryDigest";

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

const normalizeActorRoom = (room: ActorRoom) => normalizeMemoryDigests(normalizeNativeChildren(normalizeWorkerTypes(room)));

export type ActorPersistence = Pick<SessionStore, "getDomainActorRoom" | "changeDomainActorRoom" | "getWorkspace" | "captureActorCostBaseline" | "getDomainActorRunningSessions" | "getSessionTurn">;
export class ActorMemoryConflict extends Error {}
export class ActorDeletionConflict extends Error {}
export class ActorHierarchyConflict extends Error {}
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
export function validateActorRegistryEntry(actor: DomainActor) { validateActor(actor); }
type RunningActorSessions = Awaited<ReturnType<ActorPersistence["getDomainActorRunningSessions"]>>;
type ActorWork = ActorRoom["workItems"][number];

/** Every actor of the given roots' trees, including a sub-actor whose saved parent is one of them. */
export function actorTreeMembers(room: ActorRoom, rootIds: Iterable<string>) {
  const roots = new Set(rootIds);
  return new Set(room.actors.filter(other => roots.has(other.id) || roots.has(other.rootActorId)
    || other.parentActorId !== null && roots.has(other.parentActorId)).map(other => other.id));
}

/** Hierarchy changes alter authority over every affected actor's work, so all of it must be settled.
 * `management` exempts only the authenticated root's own current management work.
 * `liveOnly` (reorganizations) blocks only live activity: unfinished work that is not running keeps its
 * recorded owner and executor, and a pickup round without a lease no longer counts as active. */
export function assertActorTreesSettled(room: ActorRoom, runningSessions: RunningActorSessions, affected: ReadonlySet<string>,
  management?: { work: ActorWork; actorId: string }, options?: { liveOnly?: boolean }) {
  const conflict = (message: string): never => { throw new ActorHierarchyConflict(message); };
  const involves = (work: ActorWork) => affected.has(work.ownerActorId) || affected.has(work.executorActorId);
  const managementWork = management?.work;
  if (runningSessions.some(session => !(managementWork && session.workItemId === managementWork.id && session.actorId === management!.actorId)
    && (affected.has(session.actorId) || room.workItems.some(work => work.id === session.workItemId && involves(work)))))
    conflict("An affected actor tree has a running task, queued follow-up or loop. Finish or stop it before changing hierarchy.");
  if (!options?.liveOnly && room.workItems.some(work => work !== managementWork && involves(work) && work.status !== "completed" && !work.cancelledAt))
    conflict("An affected actor tree has unfinished work. Complete or explicitly cancel it before changing hierarchy.");
  if (room.workItems.some(work => work.dispatchLease && involves(work)
    || work.nativeAgent?.recovery && involves(work)
    || work.assignmentRequests.some(request => request.status === "pending" && (involves(work) || affected.has(request.executorActorId)
      || !!request.ownerSnapshot && affected.has(request.ownerSnapshot.id) || !!request.executorSnapshot && affected.has(request.executorSnapshot.id)))
    || work.parallelRequests?.some(request => request.status === "pending" && (involves(work) || affected.has(request.sourceActorId)
      || request.tasks.some(task => affected.has(task.executorActorId))))
    || work.completionReviews?.some(review => review.status === "pending" && (involves(work) || affected.has(review.actorId) || affected.has(review.ownerActorId))))
    || room.taskUpdates?.some(update => update.status === "pending" && (involves(update.workItem) || update.namedActorIds.some(actorId => affected.has(actorId))
      || room.workItems.some(work => work.id === update.workItemId && involves(work)))))
    conflict("An affected actor tree has a pending task operation or review. Finish it before changing hierarchy.");
  const activeRound = (round: ActorRoom["rounds"][number]) => {
    if (round.status !== "awaiting_pickup") return ["queued", "responding"].includes(round.status);
    // A pickup can retain its old status after all work finishes. Require every referenced
    // and round-associated work record before ignoring its workspace-wide snapshots.
    if (round.lease) return true;
    if (options?.liveOnly) return false;
    const workIds = new Set([...(round.workItemIds ?? []), ...(round.workItemId ? [round.workItemId] : []),
      ...room.workItems.filter(work => work.roundId === round.id).map(work => work.id)]);
    return !workIds.size || [...workIds].some(id => {
      const work = room.workItems.find(work => work.id === id);
      return !work || work.status !== "completed" && !work.cancelledAt;
    });
  };
  if (room.rounds.some(round => activeRound(round)
    && (round.actorSnapshots.some(snapshot => affected.has(snapshot.id)) || round.candidateSnapshots.some(snapshot => affected.has(snapshot.actorId))
      || round.namedActorIds.some(actorId => affected.has(actorId)) || round.stakeholderIds.some(actorId => affected.has(actorId))
      || !!round.ownerActorId && affected.has(round.ownerActorId)
      || round.replies.some(reply => affected.has(reply.actorId) || !!reply.executorActorId && affected.has(reply.executorActorId))
      || round.allocation?.assignments.some(assignment => affected.has(assignment.actorId))
      || room.workItems.some(work => work.roundId === round.id && involves(work)))))
    conflict("An affected actor tree is involved in an active discussion or task pickup. Finish it before changing hierarchy.");
}

/** Soft deletion: the entry moves to `deletedActors`, keeping its history and reserving its ID. */
export function archiveActor(room: ActorRoom, id: string, runningSessions: RunningActorSessions) {
  const actor = actorById(room, id);
  const conflict = (message: string): never => { throw new ActorDeletionConflict(message); };
  if (room.actors.some(other => other.parentActorId === id)) conflict("Delete this worker's sub-workers first.");
  const involves = (work: ActorWork) => work.ownerActorId === id || work.executorActorId === id;
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
}

/** Registry entry for a new actor; the caller validates and appends it. */
export function newDomainActor(room: ActorRoom, workspaceId: string, input: CreateDomainActor, now: string): DomainActor {
  actorTypeForRegistry("domain", input.type);
  const avatar = parseActorAvatar(input.avatar);
  const id = input.id ?? `actor_${randomUUID()}`;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid actor ID.");
  if (typeof input.name !== "string") throw new Error("Actor name must contain 1–80 characters.");
  if (room.deletedActors?.some(actor => actor.id === id) || room.actors.some(actor => actor.id === id || actor.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error("Actor ID or name already exists.");
  const parent = input.parentActorId ? actorById(room, input.parentActorId) : null;
  if (parent?.parentActorId) throw new Error("Actors support only one sub-actor level.");
  return { type: "worker", id, workspaceId, rootActorId: parent?.id ?? id, parentActorId: parent?.id ?? null,
    name: input.name.trim(), model: normalizeModelId(input.model), effort: input.effort ?? "medium", ...(avatar === undefined ? {} : { avatar }),
    allowedModels: [...new Set((input.allowedModels ?? MODEL_OPTIONS).map(normalizeModelId))],
    memory: { ...input.memory, version: 0, sourceEventIds: [] }, created: now, updated: now };
}

/** Explicit projection: memory writes and arbitrary request fields cannot alter permissions. */
export function applyActorUpdate(actor: DomainActor, input: Omit<UpdateDomainActor, "avatar">) {
  if (input.name !== undefined) actor.name = input.name.trim();
  if (input.model !== undefined) actor.model = normalizeModelId(input.model);
  if (input.effort !== undefined) actor.effort = input.effort;
  if (input.allowedModels !== undefined) actor.allowedModels = [...new Set(input.allowedModels.map(normalizeModelId))];
  if (input.projectIds !== undefined) {
    if (actor.parentActorId) throw new Error("Sub-actors belong to their root actor's projects.");
    const projectIds = [...new Set(input.projectIds.map(value => value.trim()))];
    if (projectIds.length) actor.projectIds = projectIds; else delete actor.projectIds;
  }
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
    // The generated ID is fixed outside the transaction so a CAS retry creates the same actor.
    input = { ...input, id: input.id ?? `actor_${randomUUID()}` };
    const now = new Date().toISOString();
    return this.change(workspaceId, room => {
      const actor = newDomainActor(room, workspaceId, input, now);
      validateActor(actor);
      room.actors.push(actor);
      return actor;
    });
  }
  async delete(workspaceId: string, id: string, runningSessions: Awaited<ReturnType<ActorPersistence["getDomainActorRunningSessions"]>> = []) {
    return this.change(workspaceId, (room, lockedRunningSessions) => {
      runningSessions = lockedRunningSessions ?? runningSessions;
      archiveActor(room, id, runningSessions);
      return { deletedActorId: id };
    }, { actorLifecycleLock: true });
  }
  async reparent(workspaceId: string, id: string, input: {
    parentActorId: string | null; expectedParentActorId: string | null; expectedRootActorId: string;
  }, callerActorId?: string, managementWorkItemId?: string): Promise<DomainActor> {
    return this.change(workspaceId, (room, runningSessions = []) => {
      const actor = actorById(room, id);
      if (!input || !(input.parentActorId === null || typeof input.parentActorId === "string" && input.parentActorId.length > 0)
        || !(input.expectedParentActorId === null || typeof input.expectedParentActorId === "string" && input.expectedParentActorId.length > 0)
        || typeof input.expectedRootActorId !== "string" || !input.expectedRootActorId.length) throw new Error("Invalid actor hierarchy input.");
      const conflict = (message: string): never => { throw new ActorHierarchyConflict(message); };
      if (callerActorId !== undefined) {
        const caller = actorById(room, callerActorId);
        if (caller.parentActorId !== null || caller.rootActorId !== caller.id
          || actor.id !== caller.id && (actor.parentActorId !== caller.id || actor.rootActorId !== caller.id))
          throw new Error("Only a root actor may change itself or its direct sub-actors.");
      }
      if (actor.parentActorId !== input.expectedParentActorId || actor.rootActorId !== input.expectedRootActorId)
        conflict("Actor hierarchy changed; reread before retrying.");
      if (actor.parentActorId === input.parentActorId) return actor;
      const parent = input.parentActorId === null ? null : actorById(room, input.parentActorId);
      if (parent?.id === actor.id) conflict("An actor cannot be its own parent.");
      if (parent && (parent.parentActorId !== null || parent.rootActorId !== parent.id))
        conflict("Actors support only one sub-actor level; the destination must be a root actor.");
      if (parent && room.actors.some(other => other.parentActorId === actor.id || other.rootActorId === actor.id && other.id !== actor.id))
        conflict("A root actor with sub-actors cannot become a sub-actor.");
      const projects = actorProjectIds(room.actors, actor.id);
      if (parent) {
        const destinationProjects = new Set(actorProjectIds(room.actors, parent.id));
        if (projects.length !== destinationProjects.size || projects.some(project => !destinationProjects.has(project)))
          conflict("Actor trees must have the same projects before moving an actor.");
        if (actor.allowedModels.some(model => !parent.allowedModels.includes(model)))
          conflict("The destination root does not allow all of this actor's models.");
      }
      // Both whole trees are affected: moving a child also changes its former root's authority.
      const affected = actorTreeMembers(room, [actor.rootActorId, ...(parent ? [parent.rootActorId] : [])]);
      // Only the authenticated root's current management work can remain active while moving its child.
      // The server supplies this binding; pending operations on that work still block below.
      const managementWork = callerActorId && actor.id !== callerActorId
        ? room.workItems.find(work => work.id === managementWorkItemId && work.ownerActorId === callerActorId
          && work.executorActorId === callerActorId && work.executionHistory.every(execution => execution.executorActorId === callerActorId))
        : undefined;
      assertActorTreesSettled(room, runningSessions, affected, managementWork && { work: managementWork, actorId: callerActorId! });
      actor.parentActorId = parent?.id ?? null;
      actor.rootActorId = parent?.id ?? actor.id;
      if (parent || !projects.length) delete actor.projectIds;
      else actor.projectIds = projects;
      actor.updated = new Date().toISOString();
      return actor;
    }, { actorLifecycleLock: true });
  }
  async update(workspaceId: string, id: string, input: UpdateDomainActor): Promise<DomainActor> {
    actorTypeForRegistry("domain", input.type);
    const avatar = input.avatar === null ? null : parseActorAvatar(input.avatar);
    return this.change(workspaceId, room => {
      const actor = actorById(room, id);
      if (avatar === null) delete actor.avatar;
      else if (avatar !== undefined) actor.avatar = avatar;
      applyActorUpdate(actor, input);
      if (room.actors.some(other => other.id !== id && other.name.toLowerCase() === actor.name.toLowerCase())) throw new Error("Actor name already exists.");
      validateActor(actor);
      actor.updated = new Date().toISOString();
      return actor;
    });
  }
  /** `recordApplied` runs in the same transaction, only when this call changes the memory. */
  async updateMemory(input: { workspaceId: string; actorId: string; sourceEventId: string; baseVersion: number; memory: ActorMemoryContent;
    recordApplied?: (room: ActorRoom) => void }): Promise<DomainActor> {
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
      input.recordApplied?.(room);
      return actor;
    });
  }
}
