import { ApiError, apiJson } from "./apiClient";
import type { ComposerSuggestion } from "./appTypes";
import { domainActorMatchesMention } from "./domainActorIdentity";

/** Upper bound accepted by `POST /api/sessions/:id/actor-mentions`. */
export const SESSION_ACTOR_MENTION_LIMIT = 8;

export type SessionMentionActor = { id: string; name: string; avatar?: string; roleSummary: string; parentActorId: string | null };
export type SessionMentionCandidatesResponse = { projectId: string; projectName: string; actors: SessionMentionActor[] };
export type SessionActorMentionRequest = { requestId: string; message: string; mentionedActorIds: string[] };
export type SessionActorMentionResponse = {
  round: { id: string; status: string; error: string | null; namedActorIds: string[]; workItemIds: string[] };
  turnIds: string[];
};

const wordCharacter = /[\p{L}\p{N}_]/u;

/**
 * Actors addressed with `@Name`, in the order they first appear in the text,
 * each at most once. Longer names win, so "@Robin 2" does not also address "Robin".
 */
function mentionSpans<T extends { name: string }>(text: string, actors: T[]) {
  let rest = text.toLowerCase();
  // Case folding can change string length; spans then fall back to no match.
  if (rest.length !== text.length) rest = text;
  const spans: Array<{ actor: T; start: number; end: number }> = [];
  for (const actor of [...actors].sort((a, b) => b.name.trim().length - a.name.trim().length)) {
    const name = actor.name.trim().toLowerCase();
    if (!name) continue;
    const token = `@${name}`;
    for (let index = rest.indexOf(token); index >= 0; index = rest.indexOf(token, index + 1)) {
      const before = index > 0 ? rest.charAt(index - 1) : "";
      const after = rest.charAt(index + token.length);
      if ((before && wordCharacter.test(before)) || (after && wordCharacter.test(after))) continue;
      spans.push({ actor, start: index, end: index + token.length });
      rest = `${rest.slice(0, index)}${" ".repeat(token.length)}${rest.slice(index + token.length)}`;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Actors addressed with `@Name`, in the order they first appear in the text,
 * each at most once. Longer names win, so "@Robin 2" does not also address "Robin".
 */
export function orderedMentionedActors<T extends { name: string }>(text: string, actors: T[]): T[] {
  return [...new Set(mentionSpans(text, actors).map(span => span.actor))];
}

/** Removes every `@Name` token addressed to this actor (not a longer name's prefix), leaving the rest of the prompt intact. */
export function removeActorMention<T extends { id: string; name: string }>(text: string, actor: T, actors: T[]) {
  let next = text;
  for (const span of mentionSpans(text, actors).filter(span => span.actor.id === actor.id).reverse()) {
    const end = next.charAt(span.end) === " " ? span.end + 1 : span.end;
    next = `${next.slice(0, span.start)}${next.slice(end)}`;
  }
  return next;
}

export function sessionActorMentionPayload(requestId: string, message: string, actors: Array<{ id: string }>): SessionActorMentionRequest {
  return { requestId, message, mentionedActorIds: [...new Set(actors.map(actor => actor.id))] };
}

/** Composer hint only; execution is decided by the server. */
export function sessionActorMentionHint(actors: Array<{ name: string }>) {
  if (actors.length === 0) return null;
  if (actors.length === 1) return `@${actors[0].name} will run this prompt in this session`;
  if (actors.length > SESSION_ACTOR_MENTION_LIMIT) return `Address up to ${SESSION_ACTOR_MENTION_LIMIT} workers per prompt`;
  return `${actors.length} workers will split this prompt (partial claim)`;
}

export function sessionActorMentionSuggestions(query: string, actors: SessionMentionActor[], parentName: (id: string) => string | undefined = () => undefined): ComposerSuggestion[] {
  if (!query.startsWith("@")) return [];
  const search = query.slice(1);
  return actors.filter(actor => domainActorMatchesMention(actor, search)).map(actor => {
    const parent = actor.parentActorId ? parentName(actor.parentActorId) : undefined;
    return {
      kind: "actor" as const, name: actor.name, scope: "actor" as const, insertText: `@${actor.name} `,
      description: actor.parentActorId ? `Sub-actor${parent ? ` of ${parent}` : ""}${actor.roleSummary ? ` · ${actor.roleSummary}` : ""}` : actor.roleSummary,
      actor: { id: actor.id, name: actor.name, ...(actor.avatar ? { avatar: actor.avatar } : {}) }
    };
  });
}

/** A round that queued no turn is a failure the user must see, never a silent success. */
export function sessionActorMentionFailure(response: SessionActorMentionResponse, actors: Array<{ id: string; name: string }>): string | null {
  const failed = response.round.status === "no_claims" || response.round.status === "routing_failed" || response.turnIds.length === 0;
  if (!failed) return null;
  if (response.round.error) return response.round.error;
  const names = response.round.namedActorIds.map(id => actors.find(actor => actor.id === id)?.name ?? id).map(name => `@${name}`);
  return `${names.join(", ") || "The mentioned workers"} did not take this prompt.`;
}

export function sessionActorMentionErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "mention_attachments_unsupported") return "Attachments cannot be sent with @ workers yet. Remove them or the @ mentions.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Unexpected error. Please try again.";
}

export function loadSessionMentionCandidates(sessionId: string, signal?: AbortSignal) {
  return apiJson<SessionMentionCandidatesResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/actor-mentions/candidates`, { signal, fresh: true });
}

export function submitSessionActorMention(sessionId: string, body: SessionActorMentionRequest) {
  return apiJson<SessionActorMentionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/actor-mentions`, { method: "POST", body });
}
