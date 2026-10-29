import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActorMentionAvatar } from "./ActorMentionAvatar";
import {
  loadSessionMentionCandidates, orderedMentionedActors, removeActorMention, SESSION_ACTOR_MENTION_LIMIT, sessionActorMentionErrorMessage,
  sessionActorMentionFailure, sessionActorMentionHint, sessionActorMentionPayload, sessionActorMentionSuggestions, submitSessionActorMention,
  type SessionActorMentionResponse, type SessionMentionActor
} from "./sessionActorMentions";
import "./SessionActorMentions.css";

type Candidates =
  | { sessionId: string; status: "loading" }
  | { sessionId: string; status: "ready"; projectName: string; actors: SessionMentionActor[]; loadedAt: number }
  | { sessionId: string; status: "unavailable"; error: string };

const CANDIDATES_STALE_MS = 30_000;

export type SessionActorMentionSendResult =
  | { ok: true; response: SessionActorMentionResponse }
  | { ok: false; error: string };

/**
 * `@` workers in an ordinary session composer. Mentions live in the prompt text
 * (so drafts keep them); chips and the payload are derived from that text using
 * the session's mention candidates, matched by actor id.
 */
export function useSessionActorMentions(sessionId: string | null, input: string) {
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [sending, setSending] = useState<{ sessionId: string; names: string[] } | null>(null);
  const pendingRequest = useRef<{ key: string; requestId: string } | null>(null);
  const wantsCandidates = Boolean(sessionId) && input.includes("@");
  const current = candidates?.sessionId === sessionId ? candidates : null;
  const stale = current?.status === "ready" && Date.now() - current.loadedAt > CANDIDATES_STALE_MS;
  useEffect(() => {
    if (!sessionId || !wantsCandidates) return;
    if (current && current.status !== "unavailable" && !stale) return;
    const controller = new AbortController();
    if (!current) setCandidates({ sessionId, status: "loading" });
    loadSessionMentionCandidates(sessionId, controller.signal).then(result => {
      setCandidates({ sessionId, status: "ready", projectName: result.projectName, actors: result.actors, loadedAt: Date.now() });
    }, error => {
      if (controller.signal.aborted) return;
      setCandidates({ sessionId, status: "unavailable", error: sessionActorMentionErrorMessage(error) });
    });
    return () => {
      controller.abort();
      // An aborted first load must not leave the session stuck in "loading".
      setCandidates(value => value?.sessionId === sessionId && value.status === "loading" ? null : value);
    };
    // `current` changes on every load; the session, the need and staleness drive refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, wantsCandidates, stale]);
  const actors = current?.status === "ready" ? current.actors : [];
  const mentioned = useMemo(() => orderedMentionedActors(input, actors), [input, actors]);
  function parentName(id: string) { return actors.find(actor => actor.id === id)?.name; }
  function suggestions(query: string | undefined) { return query ? sessionActorMentionSuggestions(query, actors, parentName) : []; }
  /** Text for the suggestion popup when there is no actor to list for an `@` query. */
  function menuNotice(query: string | undefined) {
    if (!sessionId || !query?.startsWith("@")) return null;
    if (!current || current.status === "loading") return "Loading workers…";
    if (current.status === "unavailable") return `Cannot @ workers here: ${current.error}`;
    if (!current.actors.length) return `No workers in ${current.projectName}`;
    return null;
  }
  async function send(targetSessionId: string, message: string): Promise<SessionActorMentionSendResult> {
    if (mentioned.length > SESSION_ACTOR_MENTION_LIMIT) return { ok: false, error: `Address up to ${SESSION_ACTOR_MENTION_LIMIT} workers per prompt.` };
    const ids = mentioned.map(actor => actor.id);
    const key = JSON.stringify([targetSessionId, message, ids]);
    // A retry of the same prompt reuses its request id so the server can deduplicate it.
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, requestId: crypto.randomUUID() };
    const payload = sessionActorMentionPayload(pendingRequest.current.requestId, message, mentioned);
    setSending({ sessionId: targetSessionId, names: mentioned.map(actor => actor.name) });
    try {
      const response = await submitSessionActorMention(targetSessionId, payload);
      if (pendingRequest.current?.key === key) pendingRequest.current = null;
      const failure = sessionActorMentionFailure(response, mentioned);
      return failure ? { ok: false, error: failure } : { ok: true, response };
    } catch (error) {
      return { ok: false, error: sessionActorMentionErrorMessage(error) };
    } finally {
      setSending(null);
    }
  }
  return {
    actors, mentioned, suggestions, menuNotice, send,
    /** Candidates are still loading, so `@Name` text cannot be resolved yet. */
    resolving: wantsCandidates && (!current || current.status === "loading"),
    sendingNames: sending && sending.sessionId === sessionId ? sending.names : null,
    remove: (text: string, actor: SessionMentionActor) => removeActorMention(text, actor, actors)
  };
}

export function SessionActorMentionChips({ actors, sendingNames, disabled, onRemove }: {
  actors: SessionMentionActor[]; sendingNames: string[] | null; disabled?: boolean; onRemove: (actor: SessionMentionActor) => void;
}) {
  if (!actors.length && !sendingNames) return null;
  const hint = sendingNames ? `Handing off to ${sendingNames.map(name => `@${name}`).join(", ")}…` : sessionActorMentionHint(actors);
  return <div className="session-actor-mentions" aria-label="Mentioned workers">
    {actors.length > 0 && <ul className="session-actor-mention-chips">
      {actors.map(actor => <li key={actor.id} className="session-actor-mention-chip">
        <ActorMentionAvatar actor={actor} />
        <span className="session-actor-mention-name">{actor.name}</span>
        <button type="button" disabled={disabled} aria-label={`Remove @${actor.name}`} title={`Remove @${actor.name}`}
          onMouseDown={event => event.preventDefault()} onClick={() => onRemove(actor)}><X aria-hidden="true" /></button>
      </li>)}
    </ul>}
    {hint && <p className="session-actor-mention-hint" role="status" aria-live="polite"
      data-warning={!sendingNames && actors.length > SESSION_ACTOR_MENTION_LIMIT ? "true" : undefined}>
      {sendingNames && <Loader2 className="spin" aria-hidden="true" />}{hint}</p>}
  </div>;
}
