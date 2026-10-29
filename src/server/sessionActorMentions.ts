import { resolve } from "node:path";
import { actorInProjectChat, type ActorRoom, type ActorRound, type ActorTaskBinding, type DomainActor, type SubmitActorRequest } from "../domainActors";
import { actorSessionWork } from "./actorNativeAgents";
import type { CodexProject } from "./codexProjects";
import { actorExecutionModels } from "./domainActorModelSelection";

/** Composer @mentions of workers in an ordinary session. See docs/session-actor-mentions.md. */
export const SESSION_MENTION_LIMIT = 8;

export type SessionMentionErrorCode = "session_not_found" | "session_project_unresolved" | "session_actor_bound" | "session_not_accepting"
  | "mention_invalid" | "mention_limit" | "mention_attachments_unsupported" | "mention_actor_not_found" | "mention_actor_wrong_project" | "mention_actor_not_permitted";

export class SessionMentionError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: SessionMentionErrorCode, message: string, readonly actorIds?: string[]) { super(message); }
  toJSON() { return { error: this.message, code: this.code, ...(this.actorIds?.length ? { actorIds: this.actorIds } : {}) }; }
}

export type SessionMentionScope = { workspaceId: string; sessionId: string; cwd: string; project: { id: string; name: string }; model: string; room: ActorRoom };
export type SessionMentionCandidate = { id: string; name: string; avatar?: string; roleSummary: string; parentActorId: string | null };

/** The registered project whose most specific root contains the session cwd; never a guess from other evidence. */
export function sessionMentionProject(cwd: string, projects: readonly CodexProject[]) {
  const target = resolve(cwd);
  const matches = projects.flatMap(project => project.roots.map(root => ({ project, root: resolve(root) })))
    .filter(entry => target === entry.root || target.startsWith(`${entry.root}/`));
  const length = Math.max(...matches.map(entry => entry.root.length));
  const best = [...new Map(matches.filter(entry => entry.root.length === length).map(entry => [entry.project.id, entry.project])).values()];
  if (best.length !== 1) throw new SessionMentionError(409, "session_project_unresolved", best.length
    ? "This session's folder belongs to several registered projects; workers cannot be @mentioned here."
    : "This session's folder is not in a project registered in this workspace's CODEX_HOME; workers cannot be @mentioned here.");
  return best[0];
}

export function resolveSessionMentionScope(input: { session: { id: string; workspaceId: string; cwd: string } | null; projects: readonly CodexProject[];
  room: ActorRoom; model: string }): SessionMentionScope {
  const { session } = input;
  if (!session) throw new SessionMentionError(404, "session_not_found", "Session not found.");
  // An actor task session already carries one actor binding for every turn; a mention there would mix identities.
  if (actorSessionWork(input.room, session.id)) throw new SessionMentionError(409, "session_actor_bound", "This session is already an actor task session; @mention workers from an ordinary session.");
  const project = sessionMentionProject(session.cwd, input.projects);
  return { workspaceId: session.workspaceId, sessionId: session.id, cwd: session.cwd, project: { id: project.id, name: project.name }, model: input.model, room: input.room };
}

/** An actor may execute here only with a model in the session's provider group. */
const permitted = (actor: DomainActor, model: string) => actorExecutionModels(actor.allowedModels ?? [], model).length > 0;

export function sessionMentionCandidates(scope: SessionMentionScope): SessionMentionCandidate[] {
  return scope.room.actors.filter(actor => actorInProjectChat(scope.room.actors, actor.id, scope.project.id) && permitted(actor, scope.model))
    .map(actor => ({ id: actor.id, name: actor.name, ...(actor.avatar ? { avatar: actor.avatar } : {}),
      roleSummary: actor.memory.roleSummary, parentActorId: actor.parentActorId }));
}

/** Validates the Composer payload; every named actor must exist, belong to the session's project and be permitted. */
export function sessionMentionRequest(scope: SessionMentionScope, body: unknown): { request: SubmitActorRequest; binding: ActorTaskBinding } {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (value.attachments !== undefined && !(Array.isArray(value.attachments) && !value.attachments.length)) throw new SessionMentionError(400, "mention_attachments_unsupported", "Attachments cannot be sent with an @mention of workers yet. Remove them or the mentions.");
  if (typeof value.requestId !== "string" || !value.requestId.trim() || value.requestId.length > 100) throw new SessionMentionError(400, "mention_invalid", "requestId is required.");
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 100_000) throw new SessionMentionError(400, "mention_invalid", "Message is required.");
  const ids = value.mentionedActorIds;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim())) throw new SessionMentionError(400, "mention_invalid", "mentionedActorIds must list at least one actor ID.");
  if (new Set(ids).size !== ids.length) throw new SessionMentionError(400, "mention_invalid", "mentionedActorIds must not repeat an actor.");
  if (ids.length > SESSION_MENTION_LIMIT) throw new SessionMentionError(400, "mention_limit", `At most ${SESSION_MENTION_LIMIT} workers can be @mentioned in one prompt.`);
  const actors = scope.room.actors;
  const missing = (ids as string[]).filter(id => !actors.some(actor => actor.id === id));
  if (missing.length) throw new SessionMentionError(400, "mention_actor_not_found", `Unknown worker: ${missing.join(", ")}.`, missing);
  const name = (id: string) => actors.find(actor => actor.id === id)!.name;
  const foreign = (ids as string[]).filter(id => !actorInProjectChat(actors, id, scope.project.id));
  if (foreign.length) throw new SessionMentionError(400, "mention_actor_wrong_project", `${foreign.map(name).join(", ")} ${foreign.length > 1 ? "do" : "does"} not belong to project ${scope.project.name}.`, foreign);
  const denied = (ids as string[]).filter(id => !permitted(actors.find(actor => actor.id === id)!, scope.model));
  if (denied.length) throw new SessionMentionError(400, "mention_actor_not_permitted", `${denied.map(name).join(", ")} ${denied.length > 1 ? "have" : "has"} no allowed model in this session's provider group.`, denied);
  return {
    request: { workspaceId: scope.workspaceId, requestId: value.requestId.trim(), userPrompt: value.message, namedActorIds: ids as string[],
      sessionTarget: { sessionId: scope.sessionId, projectId: scope.project.id, model: scope.model } },
    binding: { workspaceId: scope.workspaceId, cwd: scope.cwd, projectId: scope.project.id, source: "session" }
  };
}

/** Response of a mention: the round summary and the turns it queued in the mentioning session. */
export function sessionMentionResult(room: ActorRoom, round: ActorRound, sessionId: string) {
  const works = room.workItems.filter(work => work.roundId === round.id);
  return {
    round: { id: round.id, status: round.status, error: round.error, namedActorIds: round.namedActorIds, workItemIds: works.map(work => work.id) },
    turnIds: [...new Set(works.filter(work => work.taskSessionId === sessionId && !work.hostWorkItemId && work.dispatched).map(work => work.taskTurnId))]
  };
}
