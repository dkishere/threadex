import { randomUUID } from "node:crypto";
import type { ActorModelTier } from "../modelCatalog";
import { isDeepStrictEqual } from "node:util";
import { actorProjectIds, type ActorMemoryContent, type ActorReorganization, type ActorReorganizationInitiator,
  type ActorReorganizationOperation, type ActorReorganizationRequest, type ActorRoom, type DomainActor } from "../domainActors";
import { ActorHierarchyConflict, ActorMemoryConflict, actorById, actorTreeMembers, applyActorUpdate, archiveActor, assertActorTreesSettled, assertChildModelTiers,
  newDomainActor, validateActorMemory, validateActorRegistryEntry, type ActorPersistence } from "./domainActorStore";

const MAX_REORGANIZATION_OPERATIONS = 100;
const MEMORY_FIELDS = ["rolePrompt", "roleSummary", "longTerm", "rolling"] as const;
type RunningActorSessions = Awaited<ReturnType<ActorPersistence["getDomainActorRunningSessions"]>>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isActorId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const optionalStrings = (value: unknown) => value === undefined || Array.isArray(value) && value.length <= 50
  && value.every(item => typeof item === "string" && !!item.trim() && item.length <= 200);

/** Shape check of an untrusted request body; values are copied field by field so extra fields never reach the registry. */
export function parseActorReorganizationRequest(body: unknown): ActorReorganizationRequest {
  if (!isRecord(body)) throw new Error("Invalid reorganization request.");
  const { requestId, reason, operations, dryRun } = body;
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(requestId)) throw new Error("Reorganization requires a stable request ID.");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 4000) throw new Error("Reorganization requires a reason of 1–4000 characters.");
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_REORGANIZATION_OPERATIONS)
    throw new Error(`Reorganization requires 1–${MAX_REORGANIZATION_OPERATIONS} operations.`);
  if (dryRun !== undefined && typeof dryRun !== "boolean") throw new Error("dryRun must be a boolean.");
  return { requestId, reason: reason.trim(), operations: operations.map(parseOperation), ...(dryRun === undefined ? {} : { dryRun }) };
}

function parseProfile(value: Record<string, unknown>) {
  const { name, model, effort, allowedModelTiers, allowedModels, projectIds } = value;
  if (name !== undefined && typeof name !== "string" || model !== undefined && typeof model !== "string" || effort !== undefined && typeof effort !== "string"
    || (allowedModelTiers !== null && !optionalStrings(allowedModelTiers)) || !optionalStrings(allowedModels) || !optionalStrings(projectIds)) throw new Error("Invalid actor profile fields.");
  return Object.fromEntries(Object.entries({ name, model, effort, allowedModelTiers, allowedModels, projectIds }).filter(([, field]) => field !== undefined)) as {
    name?: string; model?: string; effort?: string; allowedModelTiers?: ActorModelTier[] | null; allowedModels?: string[]; projectIds?: string[] };
}

function parseOperation(value: unknown, index: number): ActorReorganizationOperation {
  try {
    if (!isRecord(value)) throw new Error("Invalid operation.");
    if (value.op === "create") {
      if (!isRecord(value.actor) || !isRecord(value.actor.memory)) throw new Error("Create requires an actor with memory.");
      const actor = value.actor;
      const memory = actor.memory as Record<string, unknown>;
      if (actor.id !== undefined && !isActorId(actor.id) || !(actor.parentActorId === undefined || actor.parentActorId === null || isActorId(actor.parentActorId))
        || actor.avatar !== undefined && typeof actor.avatar !== "string" || typeof actor.model !== "string" || typeof actor.name !== "string")
        throw new Error("Invalid actor to create.");
      return { op: "create", actor: { ...parseProfile(actor), name: actor.name, model: actor.model,
        ...(actor.id === undefined ? {} : { id: actor.id }), parentActorId: (actor.parentActorId as string | null | undefined) ?? null,
        ...(actor.avatar === undefined ? {} : { avatar: actor.avatar as string }),
        memory: Object.fromEntries(MEMORY_FIELDS.map(field => [field, memory[field]])) as ActorMemoryContent } };
    }
    if (!isActorId(value.actorId)) throw new Error("Choose an actor ID.");
    if (value.op === "update") {
      if (!isRecord(value.changes)) throw new Error("Update requires changes.");
      const changes = parseProfile(value.changes);
      if (!Object.keys(changes).length) throw new Error("Update requires at least one change.");
      return { op: "update", actorId: value.actorId, changes };
    }
    if (value.op === "move") {
      if (!(value.parentActorId === null || isActorId(value.parentActorId)) || !(value.expectedParentActorId === null || isActorId(value.expectedParentActorId)))
        throw new Error("Move requires parentActorId and expectedParentActorId (null for a root).");
      return { op: "move", actorId: value.actorId, parentActorId: value.parentActorId, expectedParentActorId: value.expectedParentActorId };
    }
    if (value.op === "memory") {
      if (!Number.isInteger(value.expectedVersion) || !isRecord(value.memory)) throw new Error("Memory requires expectedVersion and memory fields.");
      const memory = value.memory;
      const fields = MEMORY_FIELDS.filter(field => memory[field] !== undefined);
      if (!fields.length || fields.some(field => typeof memory[field] !== "string")) throw new Error("Memory requires at least one string field.");
      return { op: "memory", actorId: value.actorId, expectedVersion: value.expectedVersion as number,
        memory: Object.fromEntries(fields.map(field => [field, memory[field]])) };
    }
    if (value.op === "archive") return { op: "archive", actorId: value.actorId };
    throw new Error("Unknown operation; use create, update, move, memory or archive.");
  } catch (error) { throw prefixed(error, index); }
}

function prefixed(error: unknown, index: number) {
  if (error instanceof Error) { error.message = `Operation ${index + 1}: ${error.message}`; return error; }
  return new Error(`Operation ${index + 1}: ${String(error)}`);
}

/** Every project a request names, for checking against the workspace registry. */
export function reorganizationProjectIds(request: ActorReorganizationRequest) {
  return request.operations.flatMap(operation => operation.op === "create" ? operation.actor.projectIds ?? []
    : operation.op === "update" ? operation.changes.projectIds ?? [] : []).map(value => value.trim());
}

/**
 * Applies the operations in order to `room` (mutating it) and validates the final registry as a whole, so
 * intermediate states may be invalid but a failure anywhere leaves nothing to persist. Actor IDs, history,
 * work, sessions and memory stay attached: no operation re-creates an actor or reassigns work.
 * Returns the audit record (already appended unless nothing changed); a repeated request ID returns its saved record.
 */
export function applyActorReorganization(room: ActorRoom, runningSessions: RunningActorSessions, request: ActorReorganizationRequest,
  initiator: ActorReorganizationInitiator, now: string): ActorReorganization {
  // The initiating actor's own current task keeps running while it reorganizes, as root management work does.
  const initiatingWork = initiator.kind === "actor" ? room.workItems.find(work => work.id === initiator.workItemId) : undefined;
  const exemption = initiator.kind === "actor" && initiatingWork ? { work: initiatingWork, actorId: initiator.actorId } : undefined;
  const saved = room.reorganizations?.find(record => record.requestId === request.requestId);
  if (saved) {
    if (!isDeepStrictEqual(saved.operations, request.operations)) throw new Error("This request ID was already used for a different reorganization.");
    return saved;
  }
  const initial = structuredClone(room.actors);
  const initialById = new Map(initial.map(actor => [actor.id, actor]));
  const touched = new Set<string>();
  const hierarchyRoots = new Set<string>();
  const explicitProjectRoots = new Set<string>();
  const conflict = (message: string): never => { throw new ActorHierarchyConflict(message); };
  request.operations.forEach((operation, index) => {
    try {
      if (operation.op === "create") {
        const { projectIds, ...input } = operation.actor;
        const actor = newDomainActor(room, room.workspaceId, input, now);
        if (projectIds !== undefined) { applyActorUpdate(actor, { projectIds }); explicitProjectRoots.add(actor.id); }
        room.actors.push(actor);
        touched.add(actor.id);
        return;
      }
      const actor = actorById(room, operation.actorId);
      touched.add(actor.id);
      if (operation.op === "update") {
        applyActorUpdate(actor, operation.changes);
        if (operation.changes.projectIds !== undefined) explicitProjectRoots.add(actor.id);
      } else if (operation.op === "move") {
        if (actor.parentActorId !== operation.expectedParentActorId) conflict("Actor hierarchy changed; reread before retrying.");
        if (actor.parentActorId === operation.parentActorId) return;
        const parent = operation.parentActorId === null ? null : actorById(room, operation.parentActorId);
        if (parent?.id === actor.id) conflict("An actor cannot be its own parent.");
        hierarchyRoots.add(actor.rootActorId);
        if (parent) hierarchyRoots.add(parent.rootActorId);
        // A promoted actor keeps the projects it had through its former root; a sub-actor reads its root's.
        const projects = actorProjectIds(room.actors, actor.id);
        actor.parentActorId = parent?.id ?? null;
        actor.rootActorId = parent?.id ?? actor.id;
        if (parent || !projects.length) delete actor.projectIds; else actor.projectIds = projects;
      } else if (operation.op === "memory") {
        if (actor.memory.version !== operation.expectedVersion) throw new ActorMemoryConflict("Actor memory version changed; reread and merge.");
        const content = { ...Object.fromEntries(MEMORY_FIELDS.map(field => [field, actor.memory[field]])), ...operation.memory } as ActorMemoryContent;
        validateActorMemory(content);
        actor.memory = { ...content, version: actor.memory.version + 1,
          sourceEventIds: [...actor.memory.sourceEventIds, `reorganization:${request.requestId}`] };
      } else {
        // Checked against the current batch state: its sub-actors must already be moved or archived.
        archiveActor(room, actor.id, runningSessions);
        const archived = room.deletedActors!.at(-1)!;
        archived.deletedAt = now;
      }
    } catch (error) { throw prefixed(error, index); }
  });
  validateFinalRegistry(room, initial, touched, explicitProjectRoots);
  if (hierarchyRoots.size) {
    // Authority changes over both the former and the resulting trees.
    const affected = new Set([...actorTreeMembers({ ...room, actors: initial }, hierarchyRoots), ...actorTreeMembers(room, hierarchyRoots)]);
    assertActorTreesSettled(room, runningSessions, affected, exemption, { liveOnly: true });
  }
  const changes: ActorReorganization["changes"] = [];
  for (const actorId of touched) {
    const before = initialById.get(actorId) ?? null;
    const current = room.actors.find(actor => actor.id === actorId);
    if (current && !isDeepStrictEqual(before, current)) current.updated = now;
    const after = current ? structuredClone(current) : null;
    if (!isDeepStrictEqual(before, after)) changes.push({ actorId, before, after });
  }
  const record: ActorReorganization = { id: `actor_reorg_${randomUUID()}`, requestId: request.requestId, reason: request.reason,
    initiator, created: now, operations: structuredClone(request.operations), changes };
  if (changes.length) (room.reorganizations ??= []).push(record);
  return record;
}

const PROFILE_FIELDS = ["name", "parentActorId", "rootActorId", "projectIds", "model", "effort", "allowedModelTiers", "allowedModels"] as const;
/** Compact change summary for model context: profile fields that changed, and memory by version and field name. */
export function actorReorganizationDelta(before: DomainActor | null, after: DomainActor | null) {
  if (!before || !after) {
    const actor = (after ?? before)!;
    return { [after ? "created" : "archived"]: Object.fromEntries(PROFILE_FIELDS.map(field => [field, actor[field] ?? null])) };
  }
  const changed = PROFILE_FIELDS.filter(field => !isDeepStrictEqual(before[field], after[field]));
  const memoryFields = MEMORY_FIELDS.filter(field => before.memory[field] !== after.memory[field]);
  return { name: after.name,
    ...(changed.length ? { before: Object.fromEntries(changed.map(field => [field, before[field] ?? null])), after: Object.fromEntries(changed.map(field => [field, after[field] ?? null])) } : {}),
    ...(memoryFields.length ? { memory: { fromVersion: before.memory.version, toVersion: after.memory.version, fields: memoryFields } } : {}) };
}

function validateFinalRegistry(room: ActorRoom, initial: DomainActor[], touched: ReadonlySet<string>, explicitProjectRoots: ReadonlySet<string>) {
  const conflict = (message: string): never => { throw new ActorHierarchyConflict(message); };
  const byId = new Map(room.actors.map(actor => [actor.id, actor]));
  // Pre-existing entries outside this request are only checked structurally, so older data never blocks it.
  const checked = new Set([...touched, ...room.actors.filter(actor => actor.parentActorId && touched.has(actor.parentActorId)).map(actor => actor.id)]);
  for (const actor of room.actors) {
    if (actor.parentActorId === null) {
      if (actor.rootActorId !== actor.id) conflict(`${actor.name} has no parent and must be its own root.`);
      continue;
    }
    const parent = byId.get(actor.parentActorId);
    if (!parent) conflict(`${actor.name}'s parent is not in the registry.`);
    if (parent!.parentActorId !== null) conflict(`${actor.name}'s parent ${parent!.name} is a sub-actor; actors support only one sub-actor level.`);
    if (actor.rootActorId !== parent!.id) conflict(`${actor.name} must belong to its parent's tree.`);
    if (!checked.has(actor.id)) continue;
    if (actor.projectIds?.length) conflict(`Sub-actor ${actor.name} belongs to its root's projects.`);
    assertChildModelTiers(actor, parent!);
  }
  const names = new Map<string, string>();
  for (const actor of room.actors) {
    const name = actor.name.trim().toLowerCase();
    if (names.has(name) && (touched.has(actor.id) || touched.has(names.get(name)!))) throw new Error(`Actor name ${actor.name} already exists.`);
    names.set(name, actor.id);
  }
  for (const actorId of checked) { const actor = byId.get(actorId); if (actor) validateActorRegistryEntry(actor); }
  // Moving an actor between trees changes its project membership; that must be requested explicitly.
  for (const before of initial) {
    const after = byId.get(before.id);
    if (!after) continue;
    const previous = actorProjectIds(initial, before.id).sort();
    const next = actorProjectIds(room.actors, before.id).sort();
    if (!isDeepStrictEqual(previous, next) && !explicitProjectRoots.has(after.rootActorId))
      conflict(`This reorganization changes ${after.name}'s projects; set projectIds on its root ${byId.get(after.rootActorId)?.name ?? after.rootActorId} in the same request.`);
  }
}
