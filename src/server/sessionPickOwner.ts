import { buildCodexReference } from "../codexReference";
import { actorInProjectChat, type ActorRoom, type ActorRound, type ActorTaskBinding, type SubmitActorRequest } from "../domainActors";
import { actorSessionWork } from "./actorNativeAgents";
import type { CodexProject } from "./codexProjects";
import { actorExecutionModels } from "./domainActorModelSelection";
import { SessionMentionError, sessionMentionProject } from "./sessionActorMentions";

/** Pick owner: an unowned session asks its project group chat for an actor to take it over. See docs/session-pick-owner.md. */
export type PickOwnerReason = "session_actor_bound" | "session_project_unresolved" | "project_has_no_actors" | "pick_owner_pending";
export type PickOwnerPending = { requestId: string; roundId: string | null; status: string };
export type PickOwnerStatus = { eligible: boolean; reason: PickOwnerReason | null; projectId: string | null; projectName: string | null;
  actorCount: number; pending: PickOwnerPending | null };
export type PickOwnerSession = { id: string; workspaceId: string; cwd: string; title: string; description: string };
export type PickOwnerInput = { session: PickOwnerSession; projects: readonly CodexProject[]; room: ActorRoom; model: string;
  /** Group chat a round table session was opened in (ActorRoundtable.chatProjectId); it wins over the cwd. */
  roundtableChatProjectId?: string | null;
  /** A request accepted by this process whose round is not saved yet. */
  inFlightRequestId?: string };

export class PickOwnerError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: PickOwnerReason | "session_not_found" | "session_not_accepting" | "pick_owner_invalid", message: string,
    readonly pending?: PickOwnerPending) { super(message); }
  toJSON() { return { error: this.message, code: this.code, ...(this.pending ? { pending: this.pending } : {}) }; }
}

const OPEN = new Set<ActorRound["status"]>(["queued", "responding"]);
/** The latest unfinished Pick owner round of this session. Assigned rounds already bound the session. */
export function pendingPickOwner(room: ActorRoom, sessionId: string, inFlightRequestId?: string): PickOwnerPending | null {
  const round = [...room.rounds].reverse().find(round => round.sessionTarget?.takeover && round.sessionTarget.sessionId === sessionId && OPEN.has(round.status) && !round.stoppedAt);
  if (round) return { requestId: round.requestId, roundId: round.id, status: round.status };
  return inFlightRequestId && !room.rounds.some(round => round.requestId === inFlightRequestId) ? { requestId: inFlightRequestId, roundId: null, status: "queued" } : null;
}

const MESSAGES: Record<PickOwnerReason, string> = {
  session_actor_bound: "This session already has an actor owner.",
  session_project_unresolved: "This session does not belong to exactly one registered project.",
  project_has_no_actors: "This session's project has no worker that can run in this session's provider.",
  pick_owner_pending: "This session is already waiting for an owner in its group chat."
};

/** Eligibility, in order: no actor owner, one registered project, a permitted worker in it, no unfinished request. */
export function pickOwnerStatus(input: PickOwnerInput): PickOwnerStatus {
  const none = { projectId: null, projectName: null, actorCount: 0, pending: null };
  if (actorSessionWork(input.room, input.session.id)) return { eligible: false, reason: "session_actor_bound", ...none };
  let project: CodexProject;
  try {
    // A round table follows the group chat it was opened in, never a guess from its folder.
    const chat = input.roundtableChatProjectId;
    project = chat ? input.projects.find(item => item.id === chat) ?? (() => { throw new SessionMentionError(409, "session_project_unresolved", ""); })()
      : sessionMentionProject(input.session.cwd, input.projects);
  } catch (error) {
    if (error instanceof SessionMentionError) return { eligible: false, reason: "session_project_unresolved", ...none };
    throw error;
  }
  const actorCount = input.room.actors.filter(actor => actorInProjectChat(input.room.actors, actor.id, project.id)
    && actorExecutionModels(actor.allowedModels ?? [], input.model).length > 0).length;
  const pending = pendingPickOwner(input.room, input.session.id, input.inFlightRequestId);
  const reason = !actorCount ? "project_has_no_actors" : pending ? "pick_owner_pending" : null;
  return { eligible: !reason, reason, projectId: project.id, projectName: project.name, actorCount, pending };
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The group chat message: the user's follow-up verbatim, then the attached session and what taking it over means. */
export function pickOwnerMessage(session: PickOwnerSession, message: string, latestRequest?: string) {
  return [
    message,
    "",
    "--- Group follow-up of an existing session (attached by the user) ---",
    `Session: ${session.title.trim() || session.id}`,
    `Link: ${buildCodexReference(session.workspaceId, session.id)}`,
    ...(session.description.trim() ? [`Summary: ${clip(session.description.trim(), 1500)}`] : []),
    ...(latestRequest?.trim() ? [`Latest user request in the session: ${clip(latestRequest.trim(), 1500)}`] : []),
    "The session has no owner. The claiming actor becomes its owner and carries out the message above in this same session, which holds the full history; no new session is created."
  ].join("\n");
}

/** Validates the click and builds the round: the session's project group chat picks its owner. */
export function pickOwnerRequest(input: PickOwnerInput & { body: unknown; latestRequest?: string }): { request: SubmitActorRequest; binding: ActorTaskBinding } {
  const value = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  if (typeof value.requestId !== "string" || !/^[\w-]{1,100}$/.test(value.requestId)) throw new PickOwnerError(400, "pick_owner_invalid", "requestId is required (1–100 letters, digits, underscores or hyphens).");
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 90_000) throw new PickOwnerError(400, "pick_owner_invalid", "Type the follow-up message for the group chat.");
  if (value.attachments !== undefined && !(Array.isArray(value.attachments) && !value.attachments.length)) throw new PickOwnerError(400, "pick_owner_invalid", "Files cannot be sent with a group follow-up yet. Remove them or the session.");
  const status = pickOwnerStatus(input);
  // A retry of the request already pending is accepted again; a new click is not.
  if (status.reason === "pick_owner_pending" && status.pending!.requestId !== value.requestId)
    throw new PickOwnerError(409, "pick_owner_pending", MESSAGES.pick_owner_pending, status.pending!);
  if (status.reason && status.reason !== "pick_owner_pending") throw new PickOwnerError(409, status.reason, MESSAGES[status.reason]);
  const projectId = status.projectId!;
  // Sent from a group chat composer: that chat must be the session's own project chat.
  if (value.chatProjectId !== undefined && value.chatProjectId !== projectId)
    throw new PickOwnerError(409, "session_project_unresolved", `This session belongs to project ${status.projectName}; send its follow-up from that project's group chat.`);
  return {
    request: { workspaceId: input.session.workspaceId, requestId: value.requestId, userPrompt: pickOwnerMessage(input.session, value.message, input.latestRequest), chatProjectId: projectId,
      sessionTarget: { sessionId: input.session.id, projectId, model: input.model, takeover: true } },
    binding: { workspaceId: input.session.workspaceId, cwd: input.session.cwd, projectId, source: "session" }
  };
}
