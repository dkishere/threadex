import { createHash } from "node:crypto";
import { buildCodexReference } from "../codexReference";
import type { ActorRoom, ActorSessionOrigin, SubmitActorRequest } from "../domainActors";
import { actorSessionWork } from "./actorNativeAgents";
import type { CodexProject } from "./codexProjects";
import { SessionMentionError, sessionMentionProject } from "./sessionActorMentions";

/** post_group_chat: an agent in a task session or its side chat posts a message to a project group chat,
 * which runs the normal claim and Decision routing. The tool never names an owner. */
export type GroupChatPostSession = { id: string; workspaceId: string; cwd: string; title: string };
export type GroupChatPostInput = { session: GroupChatPostSession; projects: readonly CodexProject[]; room: ActorRoom;
  /** Group chat a round table session was opened in; it wins over the cwd. */
  roundtableChatProjectId?: string | null; body: unknown };

export class GroupChatPostError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export const GROUP_CHAT_POST_MESSAGE_LIMIT = 20_000;

/** The session's own project group chat; the Unassigned chat (null) when its folder is in no single registered project. */
function sessionGroupChat(input: GroupChatPostInput): string | null {
  if (input.roundtableChatProjectId !== undefined) return input.roundtableChatProjectId;
  try { return sessionMentionProject(input.session.cwd, input.projects).id; }
  catch (error) { if (error instanceof SessionMentionError) return null; throw error; }
}

/** The group chat text: the agent's message, then a footer naming its source so nobody mistakes it for the user's own words. */
export function groupChatPostMessage(session: GroupChatPostSession, message: string, origin: ActorSessionOrigin) {
  return [
    message.trim(),
    "",
    `--- Posted by an agent with post_group_chat from ${origin.sideChat ? "the side chat of " : ""}an existing session (agent-written, not the user's own words) ---`,
    `Session: ${session.title.trim() || session.id}`,
    `Link: ${buildCodexReference(session.workspaceId, session.id)}`,
    ...(origin.sourceActorName ? [`Actor: ${origin.sourceActorName}`] : [])
  ].join("\n");
}

/** Validates the post and builds the group chat round. */
export function groupChatPostRequest(input: GroupChatPostInput): SubmitActorRequest {
  const value = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {};
  if (typeof value.requestId !== "string" || !/^[\w-]{1,100}$/.test(value.requestId)) throw new GroupChatPostError(400, "requestId is required (1–100 letters, digits, underscores or hyphens).");
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > GROUP_CHAT_POST_MESSAGE_LIMIT)
    throw new GroupChatPostError(400, `message is required (at most ${GROUP_CHAT_POST_MESSAGE_LIMIT} characters).`);
  if (value.sourceTurnId !== undefined && (typeof value.sourceTurnId !== "string" || !value.sourceTurnId)) throw new GroupChatPostError(400, "Invalid sourceTurnId.");
  if (value.sideChat !== undefined && typeof value.sideChat !== "boolean") throw new GroupChatPostError(400, "Invalid sideChat.");
  let chatProjectId = sessionGroupChat(input);
  if (value.projectId !== undefined) {
    if (value.projectId !== null && (typeof value.projectId !== "string" || !input.projects.some(project => project.id === value.projectId)))
      throw new GroupChatPostError(400, "projectId must be a project registered in this session's workspace, or null for the Unassigned group chat.");
    chatProjectId = value.projectId as string | null;
  }
  const work = actorSessionWork(input.room, input.session.id);
  // One hop only: a task started from an agent's post reports back in its final response instead of posting again.
  const sourceRound = work ? input.room.rounds.find(round => round.id === work.roundId) : undefined;
  if (sourceRound?.sessionOrigin) throw new GroupChatPostError(409, "This task was started by an agent's group chat post and cannot post to the group chat again. Report in your final response instead.");
  const executorActorId = work?.taskSessionId === input.session.id ? work.executorActorId
    : work?.executionHistory.find(execution => execution.taskSessionId === input.session.id)?.executorActorId;
  const actor = executorActorId ? input.room.actors.find(actor => actor.id === executorActorId) : undefined;
  const origin: ActorSessionOrigin = { sourceSessionId: input.session.id, sourceSessionTitle: input.session.title,
    ...(typeof value.sourceTurnId === "string" ? { sourceTurnId: value.sourceTurnId } : {}), sideChat: value.sideChat === true,
    ...(actor ? { sourceActorId: actor.id, sourceActorName: actor.name } : {}), sourceRequestId: value.requestId };
  // Retrying the same requestId from this session is idempotent; another session never collides with it.
  const requestId = `gcp_${createHash("sha256").update(JSON.stringify([input.session.id, value.requestId])).digest("hex").slice(0, 40)}`;
  return { workspaceId: input.session.workspaceId, requestId, userPrompt: groupChatPostMessage(input.session, value.message, origin),
    chatProjectId, sessionOrigin: origin };
}
