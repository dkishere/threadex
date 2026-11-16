import type { ActorRoom, ActorWorkItem, DomainActor } from "../domainActors";
import { actorFollowupTurnId } from "./domainActorContext";

export const CROSS_WORKSPACE_ACTOR_DENIED = "Cross-workspace actor access needs one of the user's own messages in this task to explicitly name the target workspace "
  + "(its name, ID or a threadex://<workspace>/ link) or the target actor. Actor-written briefs, memory and other actors' replies do not count. "
  + "Ask the user to name the workspace or actor, or propose the follow-up in your final response.";

const ASCII_WORD = /[a-z0-9_\-]/;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();

/** A whole-token mention: an ASCII term must not be part of a longer ASCII word; CJK terms have no word boundaries. */
function mentions(message: string, term: string) {
  const needle = normalize(term).trim();
  if (needle.length < 2) return false;
  for (let index = message.indexOf(needle); index >= 0; index = message.indexOf(needle, index + 1)) {
    const before = message[index - 1], after = message[index + needle.length];
    const asciiStart = ASCII_WORD.test(needle[0]), asciiEnd = ASCII_WORD.test(needle.at(-1)!);
    if ((!asciiStart || !before || !ASCII_WORD.test(before)) && (!asciiEnd || !after || !ASCII_WORD.test(after))) return true;
  }
  return false;
}

/** The user's message names this workspace: its ID, its name or one of its threadex:// links. */
export function userMessageNamesWorkspace(message: string | undefined, workspace: { id: string; name: string }) {
  if (!message) return false;
  const text = normalize(message);
  return text.includes(normalize(`threadex://${encodeURIComponent(workspace.id)}/`)) || mentions(text, workspace.id) || mentions(text, workspace.name);
}

/** The user's message names this actor: its ID, its full name or one part of a "名字 · 職責" style name. */
export function userMessageNamesActor(message: string | undefined, actor: Pick<DomainActor, "id" | "name">) {
  if (!message) return false;
  const text = normalize(message);
  return mentions(text, actor.id) || mentions(text, actor.name) || actor.name.split(/[·・|｜/]/).some(part => mentions(text, part));
}

/**
 * The user's own message of this turn, read only from server-held records: a Composer turn the user sent,
 * the Actors-room request that started the task (its first turn), or an Actors-room follow-up delivered as this turn.
 * Actor envelopes, automation resumes and earlier turns never qualify.
 */
export function currentTurnUserMessage(room: Pick<ActorRoom, "workspaceId" | "rounds" | "taskUpdates">, binding: Pick<ActorWorkItem, "id" | "roundId">,
  execution: Pick<ActorWorkItem, "taskTurnId">, turn: { id: string; userInput?: string | null; requestMetadata?: Record<string, unknown> | null }) {
  if (turn.id === execution.taskTurnId) return room.rounds.find(round => round.id === binding.roundId)?.userPrompt;
  const update = room.taskUpdates?.find(update => update.status === "delivered" && update.workItemId === binding.id
    && actorFollowupTurnId(room.workspaceId, update.workItemId, update.requestId) === turn.id);
  if (update) return update.userPrompt;
  if (!["mobile", "tablet", "desktop"].includes(turn.requestMetadata?.clientLayout as string)) return undefined;
  return typeof turn.requestMetadata?.message === "string" ? turn.requestMetadata.message : turn.userInput ?? undefined;
}

/**
 * Every message the user sent for this task, oldest first: the Actors-room request (or saved canonical messages),
 * delivered Actors-room follow-ups, the session's own user turns, steers and answers, and this turn's message.
 * An explicit request in any of them authorizes cross-workspace access; actor-written text never does.
 */
export function taskUserMessages(room: Pick<ActorRoom, "workspaceId" | "rounds" | "taskUpdates">,
  binding: Pick<ActorWorkItem, "id" | "roundId" | "canonicalUserMessages" | "sessionScope">, execution: Pick<ActorWorkItem, "taskTurnId">,
  turn: { id: string; userInput?: string | null; requestMetadata?: Record<string, unknown> | null }, sessionUserMessages: string[]) {
  const round = room.rounds.find(round => round.id === binding.roundId);
  const canonical = binding.canonicalUserMessages ?? (round ? [round.userPrompt] : []);
  const followUps = (room.taskUpdates ?? []).filter(update => update.status === "delivered" && update.workItemId === binding.id).map(update => update.userPrompt);
  const current = currentTurnUserMessage(room, binding, execution, turn);
  // A Composer @mention is the newest message of an existing session, after that session's earlier turns.
  const messages = binding.sessionScope === "turn"
    ? [...sessionUserMessages, ...canonical, ...followUps, ...(current ? [current] : [])]
    : [...canonical, ...followUps, ...sessionUserMessages, ...(current ? [current] : [])];
  return [...new Set(messages.filter(message => typeof message === "string" && message.trim()))];
}
