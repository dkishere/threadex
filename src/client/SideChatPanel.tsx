import { modelLabel as modelOptionLabel, supportsUltraEffort, normalizeModelEffort } from "../modelCatalog";
import { Bot, LockKeyhole, Loader2, Quote, RotateCcw, Send, X } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { RoundtableActor } from "../roundtable";
import { roundtableLibraryEndpoint, syncRoundtableDraftAvatars, type RoundtableLibrary, type RoundtablePreset } from "../roundtablePresets";
import { ActorMultiSelect } from "./ActorMultiSelect";
import { findMentionTrigger, mentionedActors, SIDE_CHAT_MAX_ACTORS, sideChatSpeaker, type SideChatActor } from "../sideChatRoom";
import { ActorAvatar } from "./ActorAvatar";
import { apiJson } from "./apiClient";
import { InlineLinkComposer, type ComposerInlineLink, type InlineLinkComposerHandle } from "./InlineLinkComposer";
import { MarkdownContent } from "./MarkdownContent";
import { EFFORT_OPTIONS, MODEL_OPTIONS, ULTRA_EFFORT_OPTIONS } from "./appConstants";
import type { ChatMessage } from "./appTypes";
import { formatResponseAnnotationsPrompt, type ResponseAnnotation } from "./responseAnnotations";
import { annotationLabel } from "./ResponseAnnotationList";
import { RoundtableLibraryPopup } from "./Roundtable";
import { askSession, controlSideChat, loadSideChatState, type SessionSideChat } from "./sessionApi";
import { buildSideChatRounds, type OutgoingSideChatReply } from "./sideChatRounds";
import { readSideChatPreferences, saveSideChatPreferences } from "./sideChatPreferences";
import {
  ComposerFrame,
  ComposerGearSelector,
  ComposerSurface,
  ComposerToolbar,
  type ComposerGearProfile
} from "./ComposerFrame";
import "./Roundtable.css";

type CompletedTurnComponent = (props: {
  message: ChatMessage;
  steerMessages: ChatMessage[];
  codexSessionId?: string;
  sessionId: string;
  workspaceId?: string;
}) => React.ReactNode;

type SideChatPanelProps = {
  active: boolean;
  codexSessionId?: string;
  sessionId: string;
  sessionReady: boolean;
  workspaceId?: string;
  CompletedTurn: CompletedTurnComponent;
  annotation?: ResponseAnnotation | null;
  onClearAnnotation?: () => void;
  onRunningChange?: (running: boolean) => void;
};

type MentionState = { start: number; end: number; query: string; index: number };

// Stable: a new array each render would re-sync the editor from a value that can lag behind typing.
const NO_LINKS: ComposerInlineLink[] = [];

const rosterKey = (sessionId: string) => `threadex.sideChatActors:${sessionId}`;

function readRoster(sessionId: string): RoundtableActor[] {
  try {
    const value = JSON.parse(localStorage.getItem(rosterKey(sessionId)) ?? "[]");
    return Array.isArray(value) ? value.slice(0, SIDE_CHAT_MAX_ACTORS) : [];
  } catch {
    return [];
  }
}

function saveRoster(sessionId: string, actors: RoundtableActor[]) {
  try { localStorage.setItem(rosterKey(sessionId), JSON.stringify(actors)); } catch { /* The in-memory roster still works. */ }
}

export function SideChatPanel({ active, codexSessionId, sessionId, sessionReady, workspaceId, CompletedTurn, annotation, onClearAnnotation, onRunningChange }: SideChatPanelProps) {
  const [messages, setMessages] = useState<SessionSideChat[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingSideChatReply[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [initialPreferences] = useState(readSideChatPreferences);
  const [gearProfiles, setGearProfiles] = useState<ComposerGearProfile[]>(initialPreferences.gearProfiles);
  const [activeGearIndex, setActiveGearIndex] = useState(initialPreferences.activeGearIndex);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RoundtableActor[]>(() => readRoster(sessionId));
  const [presets, setPresets] = useState<RoundtablePreset[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const composerRef = useRef<InlineLinkComposerHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionGeneration = useRef(0);
  const loadedSession = useRef<string | null>(null);
  const submitting = useRef(new Set<string>());
  const activeGear = gearProfiles[activeGearIndex] ?? gearProfiles[0];
  const actors = syncRoundtableDraftAvatars(roster, presets);
  const isSending = outgoing.some((reply) => reply.status === "pending");
  useEffect(() => { onRunningChange?.(isSending); }, [isSending, onRunningChange]);
  useEffect(() => () => onRunningChange?.(false), [onRunningChange]);
  const mentionOptions = mention ? actors.filter((actor) => actor.name.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const rounds = buildSideChatRounds(messages, outgoing);
  const scrollKey = `${messages.length}:${messages.at(-1)?.id}:${outgoing.map(reply => `${reply.key}:${reply.status}`).join(",")}`;

  useEffect(() => {
    saveSideChatPreferences({ gearProfiles, activeGearIndex });
  }, [gearProfiles, activeGearIndex]);

  useEffect(() => {
    if (annotation) window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [annotation]);

  function updateGearProfile(index: number, patch: Partial<ComposerGearProfile>) {
    setGearProfiles((current) => current.map((gear, gearIndex) => {
      if (gearIndex !== index) return gear;
      const next = { ...gear, ...patch };
      next.effort = normalizeModelEffort(next.model, next.effort);
      return next;
    }));
  }

  function changeRoster(next: RoundtableActor[]) {
    saveRoster(sessionId, next);
    setRoster(next);
  }

  useEffect(() => {
    sessionGeneration.current++;
    loadedSession.current = null;
    setOutgoing([]);
    setMessages([]);
    setInput("");
    setMention(null);
    setError(null);
    setIsLoading(true);
    setRoster(readRoster(sessionId));
    return () => { sessionGeneration.current++; };
  }, [sessionId, sessionReady]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const refresh = () => {
      void apiJson<RoundtableLibrary>(roundtableLibraryEndpoint, { fresh: true, signal: controller.signal })
        .then((library) => { if (!controller.signal.aborted) setPresets(library.actors); })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("roundtable-library-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("roundtable-library-changed", refresh); };
  }, [active]);

  useEffect(() => {
    if (!sessionReady) return;
    const controller = new AbortController();
    if (loadedSession.current !== sessionId) setIsLoading(true);
    let timer: number;
    const refresh = () => void loadSideChatState(sessionId, controller.signal).then(({ sideChats, jobs = [] }) => {
      if (!controller.signal.aborted) {
        loadedSession.current = sessionId;
        setMessages((current) => {
          const savedIds = new Set(sideChats.map((entry) => entry.id));
          return [...sideChats, ...current.filter((entry) => !savedIds.has(entry.id))];
        });
        setError(null);
        const pending: OutgoingSideChatReply[] = jobs.map(job => ({
          key: `${job.roundId}:${job.actor?.id ?? "default"}`, jobId: job.id,
          roundId: job.roundId, actor: job.actor, question: job.question, model: job.model, effort: job.effort,
          replyToId: job.replyToId, status: job.status === "running" ? "pending" : "failed",
          error: job.error ?? (job.status === "stopped" ? "Stopped by the user." : undefined)
        }));
        setOutgoing(current => {
          const savedKeys = new Set(sideChats.map(entry => `${entry.roundId}:${entry.actor?.id ?? "default"}`));
          const pendingKeys = new Set(pending.map(reply => reply.key));
          return [...pending.filter(reply => !submitting.current.has(reply.key)), ...current.filter(reply =>
            submitting.current.has(reply.key) || (!savedKeys.has(reply.key) && !pendingKeys.has(reply.key)))];
        });
      }
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load side chat");
    }).finally(() => {
      if (!controller.signal.aborted) { setIsLoading(false); timer = window.setTimeout(refresh, 1500); }
    });
    refresh();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId, sessionReady]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [isLoading, scrollKey]);

  /** Every addressed speaker answers in parallel; each reply appears as soon as it is saved. */
  function dispatch(replies: OutgoingSideChatReply[]) {
    replies = replies.map(reply => ({ ...reply, requestId: reply.requestId ?? crypto.randomUUID() }));
    const generation = sessionGeneration.current;
    const keys = new Set(replies.map((reply) => reply.key));
    setOutgoing((current) => [...current.filter((reply) => !keys.has(reply.key)), ...replies.map((reply) => ({ ...reply, status: "pending" as const, error: undefined }))]);
    setError(null);
    const participants = actors.map((actor) => actor.name);
    for (const reply of replies) {
      submitting.current.add(reply.key);
      void askSession({
        requestId: reply.requestId,
        sessionId,
        question: reply.question,
        model: reply.model,
        modelReasoningEffort: reply.effort,
        ...(reply.actor ? { actor: reply.actor, participants } : {}),
        roundId: reply.roundId,
        ...(reply.replyToId ? { replyToId: reply.replyToId } : {})
      }).then(({ sideChat, jobId }) => {
        if (sessionGeneration.current !== generation) return;
        if (!sideChat) {
          setOutgoing(current => current.map(item => item.key === reply.key ? { ...item, jobId } : item));
          return;
        }
        setMessages((current) => [...current.filter((entry) => entry.id !== sideChat.id), sideChat]);
        setOutgoing((current) => current.filter((item) => item.key !== reply.key));
      }).catch((sendError) => {
        if (sessionGeneration.current !== generation) return;
        const message = sendError instanceof Error ? sendError.message : "Unable to send side-chat message";
        setOutgoing((current) => current.map((item) => item.key === reply.key ? { ...item, status: "failed", error: message } : item));
      }).finally(() => submitting.current.delete(reply.key));
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    const question = annotation ? formatResponseAnnotationsPrompt([annotation], text) : text;
    if (!question || isSending || isLoading || !sessionReady) return;
    const roundId = crypto.randomUUID();
    const addressed = mentionedActors(text, actors);
    const speakers: (RoundtableActor | null)[] = actors.length ? (addressed.length ? addressed : actors) : [null];
    dispatch(speakers.map((actor) => ({
      key: `${roundId}:${actor?.id ?? "default"}`,
      roundId,
      actor,
      question,
      model: actor?.model ?? activeGear.model,
      effort: actor?.effort ?? activeGear.effort,
      status: "pending"
    })));
    setInput("");
    setMention(null);
    onClearAnnotation?.();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }

  function requestReply(entry: SessionSideChat, actorId: string) {
    const actor = actors.find((item) => item.id === actorId);
    if (!actor || isSending) return;
    const roundId = crypto.randomUUID();
    dispatch([{
      key: `${roundId}:${actor.id}`,
      roundId,
      actor,
      question: `Please respond to ${sideChatSpeaker({ actor: entry.actor ?? null, model: entry.model })}'s message.`,
      model: actor.model,
      effort: actor.effort,
      replyToId: entry.id,
      status: "pending"
    }]);
  }

  function changeInput(value: string, caret?: number | null) {
    setInput(value);
    const trigger = actors.length ? findMentionTrigger(value, caret ?? value.length) : null;
    setMention((current) => trigger ? { ...trigger, index: current?.query === trigger.query ? current.index : 0 } : null);
  }

  function selectMention(actor: RoundtableActor) {
    if (!mention) return;
    const inserted = `@${actor.name} `;
    setInput(`${input.slice(0, mention.start)}${inserted}${input.slice(mention.end)}`);
    setMention(null);
    const caret = mention.start + inserted.length;
    window.requestAnimationFrame(() => composerRef.current?.setCaret(caret));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (mention && mentionOptions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMention({ ...mention, index: (mention.index + step + mentionOptions.length) % mentionOptions.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectMention(mentionOptions[Math.min(mention.index, mentionOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  /** Saved messages omit uploaded avatars; use the live roster or library copy when there is one. */
  function speakerAvatar(actor: SideChatActor) {
    if (actor.avatar) return actor;
    const live = actors.find((item) => item.id === actor.id)
      ?? presets.find((preset) => preset.id === actor.presetId);
    return live?.avatar ? { ...actor, avatar: live.avatar } : actor;
  }

  function speakerHeader(actor: SideChatActor | null, model: string, effort?: string, replyToId?: string | null) {
    const target = replyToId ? messages.find((entry) => entry.id === replyToId) : undefined;
    return <>
      {actor ? <ActorAvatar actor={speakerAvatar(actor)} /> : <span className="actor-avatar side-chat-default-avatar"><Bot aria-hidden="true" /></span>}
      <span className="side-chat-speaker">
        <strong>{actor?.name ?? "Side chat"}</strong>
        <small>{modelOptionLabel(model)}{effort ? ` · ${effort}` : ""}</small>
        {replyToId && <small className="side-chat-reply-target">↩ {target ? sideChatSpeaker({ actor: target.actor ?? null, model: target.model }) : "earlier message"}</small>}
      </span>
    </>;
  }

  return (
    <aside className="side-chat-panel" aria-label="Read-only side chat">
      <div className="side-chat-roster" aria-label="Side chat actors">
        <ActorMultiSelect actors={actors} presets={presets} onChange={changeRoster} onManage={() => setLibraryOpen(true)}
          max={SIDE_CHAT_MAX_ACTORS} disabled={isSending} emptyLabel={`Default · ${modelOptionLabel(activeGear.model)}`} />
      </div>
      <div ref={scrollRef} className="side-chat-messages messages" aria-live="polite">
        {isLoading ? (
          <div className="side-chat-state"><Loader2 className="spin" aria-hidden="true" /> {sessionReady ? "Loading side chat…" : "Preparing session…"}</div>
        ) : rounds.length === 0 ? (
          <div className="side-chat-empty">
            <LockKeyhole aria-hidden="true" />
            <strong>Ask without changing the session</strong>
            <span>Side chat can read this session, its project code and git history, local databases and the web, but never changes them.</span>
            <span>Add agent actors to turn it into a chat room. Everyone answers; @mention someone to ask only them.</span>
          </div>
        ) : rounds.map((round) => (
          <section className="side-chat-exchange" key={round.id}>
            {round.question !== null && <div className="side-chat-question"><MarkdownContent>{round.question}</MarkdownContent></div>}
            {round.items.map((item) => {
              if (item.kind === "outgoing") {
                const { reply } = item;
                return (
                  <article className="side-chat-bubble" data-status={reply.status} key={reply.key}>
                    <header>{speakerHeader(reply.actor, reply.model, reply.effort, reply.replyToId)}</header>
                    {reply.status === "pending" ? (
                      <div className="side-chat-state side-chat-thinking"><Loader2 className="spin" aria-hidden="true" /> Thinking…
                        {reply.jobId && <button type="button" onClick={() => void controlSideChat(sessionId, reply.jobId!, "stop").catch(error => setError(String(error)))}>Stop</button>}
                      </div>
                    ) : (
                      <div className="side-chat-error" role="alert">
                        <span>{reply.error}</span>
                        <button type="button" disabled={isSending} onClick={() => dispatch([{ ...reply, requestId: reply.jobId ? undefined : reply.requestId, jobId: undefined }])}><RotateCcw aria-hidden="true" />Retry</button>
                        <button type="button" onClick={() => {
                          if (reply.jobId) void controlSideChat(sessionId, reply.jobId, "dismiss").catch(error => setError(String(error)));
                          setOutgoing((current) => current.filter((entry) => entry.key !== reply.key));
                        }} aria-label="Dismiss"><X aria-hidden="true" /></button>
                      </div>
                    )}
                  </article>
                );
              }
              const { entry } = item;
              const message: ChatMessage = {
                id: `side-chat-answer:${entry.id}`,
                role: "assistant",
                content: entry.answer,
                conclusion: entry.answer,
                turnStatus: "done",
                createdAt: entry.created,
                completedAt: entry.created
              };
              const replyOptions = actors.filter((actor) => actor.id !== entry.actor?.id);
              const speaker = entry.actor?.name ?? "Side chat";
              return (
                <article className="side-chat-bubble" key={entry.id}>
                  <header>{speakerHeader(entry.actor ?? null, entry.model, entry.actor?.effort, entry.replyToId)}</header>
                  <div className="message assistant side-chat-answer">
                    <div className="message-content">
                      <CompletedTurn message={message} steerMessages={[]} codexSessionId={codexSessionId} sessionId={sessionId} workspaceId={workspaceId} />
                    </div>
                  </div>
                  {replyOptions.length > 0 && (
                    <footer>
                      <select
                        className="side-chat-reply-select"
                        aria-label={`Ask another actor to reply to ${speaker}`}
                        value=""
                        disabled={isSending || !sessionReady}
                        onChange={(event) => requestReply(entry, event.target.value)}
                      >
                        <option value="">Reply with…</option>
                        {replyOptions.map((actor) => <option key={actor.id} value={actor.id}>{actor.name}</option>)}
                      </select>
                    </footer>
                  )}
                </article>
              );
            })}
          </section>
        ))}
        {error && <div className="side-chat-error" role="alert">{error}</div>}
      </div>
      <form className="side-chat-composer" data-gearless={actors.length > 0 ? "true" : undefined} onSubmit={(event) => submit(event)}>
        <ComposerFrame>
          {actors.length === 0 && <ComposerGearSelector
            idPrefix="side-chat-composer-gear"
            label="Side chat model gears"
            gears={gearProfiles}
            activeGearIndex={activeGearIndex}
            modelOptions={MODEL_OPTIONS}
            effortOptions={EFFORT_OPTIONS}
            ultraEffortOptions={ULTRA_EFFORT_OPTIONS}
            supportsUltraEffort={supportsUltraEffort}
            modelOptionLabel={modelOptionLabel}
            effortOptionLabel={capitalize}
            onActivateGear={setActiveGearIndex}
            onModelChange={(index, model) => updateGearProfile(index, { model })}
            onEffortChange={(index, effort) => updateGearProfile(index, { effort })}
            disabled={isSending || !sessionReady}
            className="side-chat-gears"
          />}
          <ComposerSurface>
            {mention && <div className="slash-suggestions composer-suggestions side-chat-mentions" role="listbox" aria-label="Mention an actor">
              {mentionOptions.map((actor, index) => <button
                type="button"
                role="option"
                aria-selected={index === mention.index}
                data-active={index === mention.index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMention(actor)}
                key={actor.id}
              >
                <ActorAvatar actor={actor} />
                <span className="slash-suggestion-name">@{actor.name}</span>
                <small>{modelOptionLabel(actor.model)}</small>
              </button>)}
              {mentionOptions.length === 0 && <span className="slash-suggestions-empty">No matching actors</span>}
            </div>}
            {annotation && <div className="composer-response-quote" aria-label={annotationLabel(annotation)}>
              <span className="composer-response-quote-icon" aria-hidden="true"><Quote /></span>
              <div>
                <strong>{annotationLabel(annotation)}</strong>
                <span>{annotation.text}</span>
                {annotation.annotation && <small>{annotation.annotation}</small>}
              </div>
              <button type="button" onClick={onClearAnnotation} aria-label="Remove annotation"><X aria-hidden="true" /></button>
            </div>}
            <InlineLinkComposer
              ref={composerRef}
              value={input}
              links={NO_LINKS}
              placeholder={actors.length ? "Message the room… @ to mention an actor" : "Ask about this session…"}
              onChange={changeInput}
              onPasteLink={() => null}
              onRemoveLink={() => undefined}
              onOpenLink={() => undefined}
              onUnhandledPaste={() => undefined}
              onKeyDown={handleKeyDown}
              onBlur={() => setMention(null)}
            />
            <ComposerToolbar>
              <span className="composer-fill" />
              <button className="composer-icon" type="button" onClick={() => { setInput(""); setMention(null); onClearAnnotation?.(); }} disabled={!input && !annotation} title="Clear" aria-label="Clear">
                <X aria-hidden="true" />
              </button>
              <button className="send-button" type="submit" disabled={(!input.trim() && !annotation) || isLoading || isSending || !sessionReady} title="Send" aria-label="Send">
                {isSending ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              </button>
            </ComposerToolbar>
          </ComposerSurface>
        </ComposerFrame>
      </form>
      {libraryOpen && <RoundtableLibraryPopup onClose={() => setLibraryOpen(false)} />}
    </aside>
  );
}

function capitalize(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
