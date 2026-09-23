import { defaultGearProfiles, modelLabel as modelOptionLabel, supportsUltraEffort } from "../modelCatalog";
import { LockKeyhole, Loader2, Quote, Send, X } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { InlineLinkComposer, type InlineLinkComposerHandle } from "./InlineLinkComposer";
import { MarkdownContent } from "./MarkdownContent";
import { EFFORT_OPTIONS, MODEL_OPTIONS, ULTRA_EFFORT_OPTIONS } from "./appConstants";
import type { ChatMessage } from "./appTypes";
import { formatResponseAnnotationsPrompt, type ResponseAnnotation } from "./responseAnnotations";
import { annotationLabel } from "./ResponseAnnotationList";
import { askSession, loadSideChats, type SessionSideChat } from "./sessionApi";
import {
  ComposerFrame,
  ComposerGearSelector,
  ComposerSurface,
  ComposerToolbar,
  type ComposerGearProfile
} from "./ComposerFrame";

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
};

export function SideChatPanel({ active, codexSessionId, sessionId, sessionReady, workspaceId, CompletedTurn, annotation, onClearAnnotation }: SideChatPanelProps) {
  const [messages, setMessages] = useState<SessionSideChat[]>([]);
  const [input, setInput] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [gearProfiles, setGearProfiles] = useState<ComposerGearProfile[]>(defaultGearProfiles);
  const [activeGearIndex, setActiveGearIndex] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<InlineLinkComposerHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionGeneration = useRef(0);
  const sendingRef = useRef(false);
  const loadedSession = useRef<string | null>(null);
  const activeGear = gearProfiles[activeGearIndex] ?? gearProfiles[0];

  useEffect(() => {
    if (annotation) window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [annotation]);

  function updateGearProfile(index: number, patch: Partial<ComposerGearProfile>) {
    setGearProfiles((current) => current.map((gear, gearIndex) => {
      if (gearIndex !== index) return gear;
      const next = { ...gear, ...patch };
      if ((next.effort === "max" || next.effort === "ultra") && !supportsUltraEffort(next.model)) next.effort = "xhigh";
      return next;
    }));
  }

  useEffect(() => {
    sessionGeneration.current++;
    loadedSession.current = null;
    sendingRef.current = false;
    setIsSending(false);
    setMessages([]);
    setInput("");
    setPendingQuestion("");
    setError(null);
    setIsLoading(true);
    return () => { sessionGeneration.current++; };
  }, [sessionId, sessionReady]);

  useEffect(() => {
    if (!active || !sessionReady || loadedSession.current === sessionId) return;
    const controller = new AbortController();
    setIsLoading(true);
    void loadSideChats(sessionId, controller.signal).then((sideChats) => {
      if (!controller.signal.aborted) {
        loadedSession.current = sessionId;
        setMessages((current) => {
          const savedIds = new Set(sideChats.map((entry) => entry.id));
          return [...sideChats, ...current.filter((entry) => !savedIds.has(entry.id))];
        });
        setError(null);
      }
    }).catch((loadError) => {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load side chat");
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [active, sessionId, sessionReady]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [isLoading, isSending, messages]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = annotation ? formatResponseAnnotationsPrompt([annotation], input.trim()) : input.trim();
    if (!question || sendingRef.current || isLoading || !sessionReady) return;
    const generation = sessionGeneration.current;
    sendingRef.current = true;
    setInput("");
    setPendingQuestion(question);
    setError(null);
    setIsSending(true);
    try {
      const sideChat = await askSession({
        sessionId,
        question,
        model: activeGear.model,
        modelReasoningEffort: activeGear.effort
      });
      if (sessionGeneration.current !== generation) return;
      setMessages((current) => [...current.filter((entry) => entry.id !== sideChat.id), sideChat]);
      onClearAnnotation?.();
    } catch (sendError) {
      if (sessionGeneration.current !== generation) return;
      setInput(input);
      setError(sendError instanceof Error ? sendError.message : "Unable to send side-chat message");
    } finally {
      if (sessionGeneration.current === generation) {
        sendingRef.current = false;
        setIsSending(false);
        setPendingQuestion("");
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <aside className="side-chat-panel" aria-label="Read-only side chat">
      <div ref={scrollRef} className="side-chat-messages messages" aria-live="polite">
        {isLoading ? (
          <div className="side-chat-state"><Loader2 className="spin" aria-hidden="true" /> {sessionReady ? "Loading side chat…" : "Preparing session…"}</div>
        ) : messages.length === 0 ? (
          <div className="side-chat-empty">
            <LockKeyhole aria-hidden="true" />
            <strong>Ask without changing the session</strong>
            <span>Side chat can use this session's saved context, but cannot edit files or run commands.</span>
          </div>
        ) : messages.map((entry) => {
          const message: ChatMessage = {
            id: `side-chat-answer:${entry.id}`,
            role: "assistant",
            content: entry.answer,
            conclusion: entry.answer,
            turnStatus: "done",
            createdAt: entry.created,
            completedAt: entry.created
          };
          return (
            <section className="side-chat-exchange" key={entry.id}>
              <div className="side-chat-question"><MarkdownContent>{entry.question}</MarkdownContent></div>
              <article className="message assistant side-chat-answer">
                <div className="message-content">
                  <CompletedTurn message={message} steerMessages={[]} codexSessionId={codexSessionId} sessionId={sessionId} workspaceId={workspaceId} />
                </div>
              </article>
            </section>
          );
        })}
        {isSending && (
          <section className="side-chat-exchange side-chat-pending">
            <div className="side-chat-question"><MarkdownContent>{pendingQuestion}</MarkdownContent></div>
            <div className="side-chat-state"><Loader2 className="spin" aria-hidden="true" /> Thinking…</div>
          </section>
        )}
        {error && <div className="side-chat-error" role="alert">{error}</div>}
      </div>
      <form className="side-chat-composer" onSubmit={(event) => void submit(event)}>
        <ComposerFrame>
          <ComposerGearSelector
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
          />
          <ComposerSurface>
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
              links={[]}
              placeholder="Ask about this session…"
              onChange={setInput}
              onPasteLink={() => null}
              onRemoveLink={() => undefined}
              onOpenLink={() => undefined}
              onUnhandledPaste={() => undefined}
              onKeyDown={handleKeyDown}
              onBlur={() => undefined}
            />
            <ComposerToolbar>
              <span className="composer-fill" />
              <button className="composer-icon" type="button" onClick={() => { setInput(""); onClearAnnotation?.(); }} disabled={!input && !annotation} title="Clear" aria-label="Clear">
                <X aria-hidden="true" />
              </button>
              <button className="send-button" type="submit" disabled={(!input.trim() && !annotation) || isLoading || isSending || !sessionReady} title="Send" aria-label="Send">
                {isSending ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              </button>
            </ComposerToolbar>
          </ComposerSurface>
        </ComposerFrame>
      </form>
    </aside>
  );
}

function capitalize(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
