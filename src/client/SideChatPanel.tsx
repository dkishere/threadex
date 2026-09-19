import { LockKeyhole, Loader2, Quote, Send, X } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { InlineLinkComposer, type InlineLinkComposerHandle } from "./InlineLinkComposer";
import { MarkdownContent } from "./MarkdownContent";
import { EFFORT_OPTIONS, MODEL_OPTIONS, ULTRA_EFFORT_OPTIONS } from "./appConstants";
import type { ChatMessage } from "./appTypes";
import { formatResponseAnnotationsPrompt, type ResponseAnnotation } from "./responseAnnotations";
import { annotationLabel } from "./ResponseAnnotationList";
import {
  ComposerFrame,
  ComposerGearSelector,
  ComposerSurface,
  ComposerToolbar,
  type ComposerGearProfile
} from "./ComposerFrame";

type SessionSideChat = {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  model: string;
  created: string;
};

type InspectionResponse = {
  sideChats?: SessionSideChat[];
};

type AskResponse = {
  sideChat: SessionSideChat;
};

type CompletedTurnComponent = (props: {
  message: ChatMessage;
  steerMessages: ChatMessage[];
  codexSessionId?: string;
  sessionId: string;
  workspaceId?: string;
}) => React.ReactNode;

type SideChatPanelProps = {
  codexSessionId?: string;
  sessionId: string;
  sessionReady: boolean;
  workspaceId?: string;
  CompletedTurn: CompletedTurnComponent;
  annotation?: ResponseAnnotation | null;
  onClearAnnotation?: () => void;
};

async function readApiError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function SideChatPanel({ codexSessionId, sessionId, sessionReady, workspaceId, CompletedTurn, annotation, onClearAnnotation }: SideChatPanelProps) {
  const [messages, setMessages] = useState<SessionSideChat[]>([]);
  const [input, setInput] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [gearProfiles, setGearProfiles] = useState<ComposerGearProfile[]>([
    { model: "gpt-5.6-sol", effort: "xhigh" },
    { model: "gpt-5.6-luna", effort: "medium" },
    { model: "gpt-5.6-terra", effort: "xhigh" },
    { model: "gpt-5.6-terra", effort: "low" },
    { model: "gpt-5.6-luna", effort: "high" },
    { model: "gpt-5.6-sol", effort: "high" }
  ]);
  const [activeGearIndex, setActiveGearIndex] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<InlineLinkComposerHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeGear = gearProfiles[activeGearIndex] ?? gearProfiles[0];

  useEffect(() => {
    if (annotation) window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [annotation]);

  function updateGearProfile(index: number, patch: Partial<ComposerGearProfile>) {
    setGearProfiles((current) => current.map((gear, gearIndex) => {
      if (gearIndex !== index) return gear;
      const next = { ...gear, ...patch };
      if (next.effort === "ultra" && !supportsUltraEffort(next.model)) next.effort = "xhigh";
      return next;
    }));
  }

  useEffect(() => {
    const controller = new AbortController();
    setMessages([]);
    setInput("");
    setPendingQuestion("");
    setError(null);
    setIsLoading(true);
    if (!sessionReady) {
      return () => controller.abort();
    }
    void fetch("/api/session-inspector/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        includeSideChats: true,
        sideChatLimit: 100,
        order: "asc",
        turnLimit: 1,
        maxTextChars: 200
      }),
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error(await readApiError(response, `Side chat API returned ${response.status}`));
      const body = await response.json() as InspectionResponse;
      setMessages(Array.isArray(body.sideChats) ? body.sideChats : []);
    }).catch((loadError) => {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load side chat");
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });
    return () => controller.abort();
  }, [sessionId, sessionReady]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [isLoading, isSending, messages]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = annotation ? formatResponseAnnotationsPrompt([annotation], input.trim()) : input.trim();
    if (!question || isSending || !sessionReady) return;
    setInput("");
    setPendingQuestion(question);
    setError(null);
    setIsSending(true);
    try {
      const response = await fetch("/api/session-inspector/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          question,
          model: activeGear.model,
          modelReasoningEffort: activeGear.effort
        })
      });
      if (!response.ok) throw new Error(await readApiError(response, `Side chat API returned ${response.status}`));
      const body = await response.json() as AskResponse;
      setMessages((current) => [...current, body.sideChat]);
      onClearAnnotation?.();
    } catch (sendError) {
      setInput(input);
      setError(sendError instanceof Error ? sendError.message : "Unable to send side-chat message");
    } finally {
      setIsSending(false);
      setPendingQuestion("");
      window.requestAnimationFrame(() => composerRef.current?.focus());
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
              <button className="send-button" type="submit" disabled={(!input.trim() && !annotation) || isSending || !sessionReady} title="Send" aria-label="Send">
                {isSending ? <Loader2 className="spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
              </button>
            </ComposerToolbar>
          </ComposerSurface>
        </ComposerFrame>
      </form>
    </aside>
  );
}

function supportsUltraEffort(model: string) {
  return /^gpt-5\.6(?:-|\s|$)/i.test(model);
}

function modelOptionLabel(model: string) {
  const gpt56Match = /^gpt-5\.6-(terra|luna|sol)$/i.exec(model);
  return gpt56Match ? `5.6 ${capitalize(gpt56Match[1])}` : model.replace(/^gpt-/i, "");
}

function capitalize(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}
