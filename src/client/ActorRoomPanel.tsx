import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Brain, ChevronDown, ChevronRight, ExternalLink, Globe, Loader2, MessageCircle, Paperclip, Plus, Quote, RefreshCw, RotateCcw, Send, Square, Users, X } from "lucide-react";
import { ChatMessageActions } from "./ChatMessageActions";
import { ResponseAnnotationList } from "./ResponseAnnotationList";
import { ResponseQuotePopover } from "./ResponseQuotePopover";
import { formatResponseAnnotationsPrompt, parseResponseAnnotations, type ResponseAnnotation } from "./responseAnnotations";
import { DomainActorIdentity } from "./DomainActorIdentity";
import { domainActorMatchesMention } from "./domainActorIdentity";
import { ActorConclusionMessages } from "./ActorConclusionMessages";
import { ActorMemoryNotices } from "./ActorMemoryNotices";
import { ActorBlockerList } from "./ActorBlockers";
import { visibleBlockers } from "./actorBlockerPresentation";
import { actorDialogConclusions } from "../actorConclusions";
import { actorTimeline, actorTimelineTime } from "./actorTimeline";
import { findMentionTrigger } from "../sideChatRoom";
import { ComposerFrame, ComposerGearSelector, ComposerSurface, ComposerToolbar } from "./ComposerFrame";
import { EFFORT_OPTIONS, ULTRA_EFFORT_OPTIONS } from "./appConstants";
import { useWorkspaceChatGears } from "./useWorkspaceChatGears";
import { useActorComposerSuggestions } from "./useActorComposerSuggestions";
import { ComposerSuggestionMenu } from "./ComposerSuggestions";
import type { ComposerSuggestion } from "./appTypes";
import { InlineLinkComposer, type ComposerInlineLink, type InlineLinkComposerHandle } from "./InlineLinkComposer";
import { MarkdownContent } from "./MarkdownContent";
import { actorInProjectChat, actorRoundChatKey, splitActorPromptPageContext, UNASSIGNED_ACTOR_PROJECT, type ActorMemoryContent, type ActorResponseProfile, type ActorRound, type CreateDomainActor, type DomainActor } from "../domainActors";
import { DEFAULT_MODEL, MODEL_OPTIONS, modelEfforts, modelLabel, supportsUltraEffort } from "../modelCatalog";
import { apiJson, ApiError } from "./apiClient";
import { actorMentionPreview, actorOwnerExplanation, actorRoutingFailure, actorRoundWorkItems, actorStoppableTurns, actorTaskPresentation, type ActorDialogMode } from "./actorRoomPresentation";
import { isAuthRequired, useActorRoom, type ActorRoomState } from "./actorRoomState";
import "./ActorRoomPanel.css";
import { AttachmentList } from "./attachments";
import { useActorAttachments } from "./useActorAttachments";
import { attachmentFilesFromPaste } from "./composerPaste";
import type { ActorAttachment, ActorTaskSelection, ActorWorkItem } from "../domainActors";
import { ActorRoundtableCard, ActorRoundtableComposerPanel, ActorRoundtableReceiptCard, useActorRoundtableDraft, useActorRoundtables } from "./ActorRoundtables";
import { groupChatEntries } from "./actorRoundtablePresentation";

const isLongActorText = (text: string) => text.length > 600 || text.split("\n").length > 8;
const blankMemory = (): ActorMemoryContent => ({ rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" });
const memoryLabels: Record<keyof ActorMemoryContent, string> = { rolePrompt: "Role and instructions", roleSummary: "Domain summary", longTerm: "Long-term knowledge", rolling: "Recent progress and handover" };
/** Without `actor` this is a project group chat (`chatKey`, default Unassigned); with `actor` it is the actor's unified timeline. */
type Props = { workspaceId: string; approvalPolicy?: ActorRound["approvalPolicy"]; onOpenSession: (id: string) => void; actor?: DomainActor; roomState?: ActorRoomState; disableEscapeStop?: boolean;
  /** Group chat key: a project ID or UNASSIGNED_ACTOR_PROJECT. Ignored with `actor`. */
  chatKey?: string; chatName?: string };
const NO_LINKS: ComposerInlineLink[] = [];
type Mention = NonNullable<ReturnType<typeof findMentionTrigger>> & { index: number };
type PendingRequest = ActorTaskSelection & { requestId: string; userPrompt: string; attachments?: ActorAttachment[]; namedActorIds: string[]; responseProfile?: ActorResponseProfile; approvalPolicy?: ActorRound["approvalPolicy"]; chatProjectId?: string | null };
type Receipt = PendingRequest & { error?: string; round?: ActorRound };
type ReplyContext = { actorId: string; actorName: string; roundId: string; text: string; tasks: Array<Pick<ActorWorkItem, "id" | "taskSessionId" | "taskTurnId">> };
type DialogKeys = { id: string; pending: string; draft: string | null };
function dialogKeys(workspaceId: string, actor: DomainActor | undefined, mode: ActorDialogMode, chatKey: string = UNASSIGNED_ACTOR_PROJECT): DialogKeys {
  // The Unassigned chat is where the former workspace-wide group chat lives, so it keeps that chat's
  // storage keys (drafts and unconfirmed receipts survive the upgrade); each project chat has its own.
  const group = chatKey === UNASSIGNED_ACTOR_PROJECT ? workspaceId : `${workspaceId}:chat:${chatKey}`;
  if (!actor) return { id: group, pending: `threadex.actorRoom.pending:${group}`, draft: `threadex.actorRoom.draft:${group}` };
  const suffix = `${workspaceId}:${actor.id}:${mode}`;
  return { id: suffix, pending: `threadex.actorRoom.pending:${suffix}`, draft: `threadex.actorRoom.draft:${suffix}` };
}
function readPending(key: string): Receipt[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return (Array.isArray(value) ? value : value ? [value] : []).filter(value => value && typeof value.requestId === "string" && typeof value.userPrompt === "string" && Array.isArray(value.namedActorIds) && value.namedActorIds.every((id: unknown) => typeof id === "string"));
  } catch { return []; }
}
function readDraft(key: string | null): string {
  if (!key) return "";
  try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; }
}
function writeDraft(key: string | null, value: string) {
  if (!key) return;
  try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* The in-memory draft remains. */ }
}
function readQuotes(key: string | null): ResponseAnnotation[] {
  return parseResponseAnnotations(readDraft(key ? `${key}:quotes` : null))?.annotations ?? [];
}
function readReply(key: string | null): ReplyContext | null {
  try {
    const value = JSON.parse(readDraft(key ? `${key}:reply` : null) || "null") as ReplyContext | null;
    return value && typeof value.actorId === "string" && typeof value.actorName === "string" && typeof value.roundId === "string" && typeof value.text === "string"
      && Array.isArray(value.tasks) && value.tasks.every(task => task && typeof task.id === "string" && typeof task.taskSessionId === "string" && typeof task.taskTurnId === "string") ? value : null;
  } catch { return null; }
}
function replyAnnotation(reply: ReplyContext, workspaceId: string): ResponseAnnotation {
  const tasks = reply.tasks.map(task => [
    `Work item: ${task.id}`,
    ...(task.taskSessionId.trim() ? [`Task: threadex://${encodeURIComponent(workspaceId)}/${encodeURIComponent(task.taskSessionId)}${task.taskTurnId ? `#${encodeURIComponent(task.taskTurnId)}` : ""}`] : [])
  ].join("\n"));
  return { text: [
    `Reply context from ${reply.actorName} (actor ${reply.actorId}${reply.roundId ? `, round ${reply.roundId}` : ""}):`,
    reply.text,
    ...(tasks.length ? ["", "Created task context (references only):", ...tasks] : [])
  ].join("\n") };
}

export function ActorRoomPanel({ workspaceId, approvalPolicy, onOpenSession, actor: viewActor, roomState, disableEscapeStop = false, chatKey: chatKeyProp, chatName }: Props) {
  const base = `/api/domain-actors/${encodeURIComponent(workspaceId)}`;
  const chatKey = viewActor ? undefined : chatKeyProp || UNASSIGNED_ACTOR_PROJECT;
  const chatProjectId = chatKey === undefined || chatKey === UNASSIGNED_ACTOR_PROJECT ? null : chatKey;
  // The server partitions group chats; a group chat always reads its own `room?chat=`.
  const ownRoom = useActorRoom(workspaceId, { enabled: !roomState, chat: chatKey ?? null });
  const { room, error, refresh } = roomState ?? ownRoom;
  const { gearProfiles, activeGearIndex, setActiveGearIndex, updateGear } = useWorkspaceChatGears(workspaceId);
  const suggestions = useActorComposerSuggestions(workspaceId, chatProjectId);
  const activeGear = gearProfiles[activeGearIndex] ?? gearProfiles[0];
  const keys = dialogKeys(workspaceId, viewActor, "individual", chatKey);
  const files = useActorAttachments(keys.id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const [requestError, setRequestError] = useState("");
  const [requestAuthRequired, setAuthRequired] = useState(false);
  const authRequired = (roomState ?? ownRoom).authRequired || requestAuthRequired;
  const [retryingRound, setRetryingRound] = useState<string | null>(null);
  const [prompt, setPromptValue] = useState(() => readDraft(keys.draft));
  const promptRef = useRef(prompt);
  const [quotes, setQuotesValue] = useState(() => readQuotes(keys.draft));
  const quotesRef = useRef(quotes);
  const [replyContext, setReplyContextValue] = useState(() => readReply(keys.draft));
  const replyContextRef = useRef(replyContext);
  function setReplyContext(value: ReplyContext | null) {
    replyContextRef.current = value; setReplyContextValue(value);
    writeDraft(keysRef.current.draft ? `${keysRef.current.draft}:reply` : null, value ? JSON.stringify(value) : "");
  }
  const [selectionQuote, setSelectionQuote] = useState<(ResponseAnnotation & { left: number; top: number }) | null>(null);
  function setQuotes(value: ResponseAnnotation[]) {
    quotesRef.current = value;
    setQuotesValue(value);
    writeDraft(keysRef.current.draft ? `${keysRef.current.draft}:quotes` : null, value.length ? formatResponseAnnotationsPrompt(value) : "");
  }
  function quoteSelection(quote: ResponseAnnotation) {
    setQuotes([...quotesRef.current, { text: quote.text, annotation: quote.annotation }]);
    setSelectionQuote(null);
    setMention(null); suggestions.dismiss();
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }
  function replyToMessage(actorId: string, roundId: string, text: string, tasks: ReplyContext["tasks"]) {
    const target = actors.find(candidate => candidate.id === actorId);
    if (!target) return;
    setReplyContext({ actorId, actorName: target.name, roundId, text, tasks: tasks.map(({ id, taskSessionId, taskTurnId }) => ({ id, taskSessionId, taskTurnId })) });
    setMention(null); suggestions.dismiss(); setSelectionQuote(null);
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }
  function captureSelection() {
    const selection = window.getSelection();
    const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
    const start = element(selection?.anchorNode ?? null)?.closest(".side-chat-answer .markdown-content, .actor-room-text");
    const end = element(selection?.focusNode ?? null)?.closest(".side-chat-answer .markdown-content, .actor-room-text");
    if (!selection || selection.isCollapsed || !selection.rangeCount || !start || start !== end || !scrollRef.current?.contains(start)) { setSelectionQuote(null); return; }
    const text = selection.toString().trim().slice(0, 4000);
    if (!text) { setSelectionQuote(null); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSelectionQuote({ text, left: Math.max(Math.min(190, innerWidth / 2), Math.min(innerWidth - Math.min(190, innerWidth / 2), rect.left + rect.width / 2)), top: Math.max(160, rect.top - 8) });
  }
  const [pending, setPending] = useState<Receipt[]>(() => readPending(keys.pending));
  const [, setReceiptRevision] = useState(0);
  const receipts = useRef(new Map([[keys.pending, pending]]));
  const inFlight = useRef(new Set<string>());
  const [sendingIds, setSendingIds] = useState<string[]>([]);
  function updatePending(target: DialogKeys, update: (items: Receipt[]) => Receipt[]) {
    const next = update(receipts.current.get(target.pending) ?? readPending(target.pending));
    receipts.current.set(target.pending, next);
    try { if (next.length) sessionStorage.setItem(target.pending, JSON.stringify(next)); else sessionStorage.removeItem(target.pending); } catch { /* Keep receipts in memory when storage is unavailable. */ }
    if (mounted.current) {
      setReceiptRevision(value => value + 1);
      if (keysRef.current.id === target.id) setPending(next);
    }
  }
  const loadedKey = useRef(keys.id);
  function setPrompt(value: string) {
    promptRef.current = value;
    setPromptValue(value);
    writeDraft(keysRef.current.draft, value);
  }
  const [editor, setEditor] = useState<{ actor: DomainActor | null; memory: ActorMemoryContent; version?: number } | null>(null);
  const [draft, setDraft] = useState<CreateDomainActor>({ name: "", model: DEFAULT_MODEL, effort: "medium", allowedModels: [...MODEL_OPTIONS], memory: blankMemory() });
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true);
  const [mention, setMention] = useState<Mention | null>(null);
  const composerRef = useRef<InlineLinkComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followReplies = useRef(true);
  const editorRef = useRef<HTMLFormElement>(null);
  const actors = room?.actors ?? [];
  // A project group chat addresses only that project's workers (membership: root projectIds).
  const chatActors = chatKey === undefined ? actors : actors.filter(candidate => actorInProjectChat(actors, candidate.id, chatProjectId));
  const preview = actorMentionPreview(prompt, chatActors);
  const chatTitle = chatKey === undefined ? "" : `${chatName || (chatKey === UNASSIGNED_ACTOR_PROJECT ? "Unassigned" : chatKey)} group chat`;
  const actor = viewActor ? actors.find(candidate => candidate.id === viewActor.id) ?? viewActor : undefined;
  // A private dialog always addresses only its actor; @ mentions do not change the recipient.
  const conclusions = room && actor ? actorDialogConclusions(room, actor.id) : [];
  const unacknowledgedConclusions = conclusions.filter(conclusion => !conclusion.acknowledgedAt).length;
  // Group chat round tables open their own session; the chat keeps only a link card.
  const roundtableDraft = useActorRoundtableDraft(workspaceId, gearProfiles, !viewActor);
  const roundtables = useActorRoundtables(workspaceId, actor ? undefined : room?.roundtables, actor ? undefined : room?.revision);
  const roundtableMode = !viewActor && roundtableDraft.enabled;
  const replyTargetUnavailable = !!replyContext && !actors.some(candidate => candidate.id === replyContext.actorId);
  const roundtableBlocked = roundtableMode && (roundtableDraft.actors.length < 2 || files.attachments.length > 0);
  const blocked = roundtableMode ? roundtableBlocked : replyTargetUnavailable || !actor && !replyContext && preview.tooMany;
  const dialogReceipts = (actor ? [dialogKeys(workspaceId, actor, "individual"), dialogKeys(workspaceId, actor, "group")] : [keys])
    .flatMap(target => (receipts.current.get(target.pending) ?? readPending(target.pending)).map(item => ({ item, target })))
    .filter(({ item }) => !room?.rounds.some(round => round.requestId === item.requestId));
  const visibleRoom = room ? { ...room, rounds: [...room.rounds, ...dialogReceipts.flatMap(({ item }) => item.round ? [item.round] : [])] } : null;
  const timeline = visibleRoom && actor ? actorTimeline(visibleRoom, actor) : [];
  const rounds = actor ? timeline.flatMap(entry => entry.kind === "conversation" ? [entry.round] : []) : visibleRoom?.rounds ?? [];
  const stoppable = visibleRoom ? actorStoppableTurns(visibleRoom.workItems, rounds) : [];
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const escapeStopUntil = useRef(0);
  const [stopHint, setStopHint] = useState("");
  const taskStopsInFlight = useRef(new Set<string>());
  const [taskStopStates, setTaskStopStates] = useState<Record<string, { stopping: boolean; error?: string }>>({});
  const taskCancelsInFlight = useRef(new Set<string>());
  const [taskCancelStates, setTaskCancelStates] = useState<Record<string, { cancelling: boolean; error?: string }>>({});
  const taskStopKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);
  const [replyStopStates, setReplyStopStates] = useState<Record<string, { stopping: boolean; error?: string }>>({});
  const replyStopsInFlight = useRef(new Set<string>());
  async function stopReply(roundId: string, actorId: string) {
    const key = JSON.stringify([roundId, actorId]);
    if (replyStopsInFlight.current.has(key)) return;
    replyStopsInFlight.current.add(key);
    setReplyStopStates(current => ({ ...current, [key]: { stopping: true } }));
    let error: string | undefined;
    try {
      await apiJson(`${base}/rounds/${encodeURIComponent(roundId)}/replies/${encodeURIComponent(actorId)}/stop`, { method: "POST", body: {} });
      await refresh();
    } catch (cause) { error = `Stop failed: ${cause instanceof Error ? cause.message : String(cause)}`; }
    finally {
      replyStopsInFlight.current.delete(key);
      if (mounted.current) setReplyStopStates(current => ({ ...current, [key]: { stopping: false, error } }));
    }
  }
  // A request stopped while sending may not have a saved round yet; it stays pending until the round appears.
  const [requestStopStates, setRequestStopStates] = useState<Record<string, { stopping: boolean; error?: string }>>({});
  const requestStopsPending = useRef(new Set<string>());
  const requestStopsInFlight = useRef(new Set<string>());
  async function stopRequest(requestId: string) {
    if (requestStopsInFlight.current.has(requestId)) return;
    requestStopsPending.current.add(requestId); requestStopsInFlight.current.add(requestId);
    setRequestStopStates(current => ({ ...current, [requestId]: { stopping: true } }));
    let error: string | undefined;
    let saved = false;
    try {
      saved = !!(await apiJson<{ round: ActorRound | null }>(`${base}/requests/${encodeURIComponent(requestId)}/stop`, { method: "POST", body: {} })).round;
      if (saved) await refresh();
    } catch (cause) { saved = true; error = `Stop failed: ${cause instanceof Error ? cause.message : String(cause)}`; }
    finally {
      requestStopsInFlight.current.delete(requestId);
      if (saved) requestStopsPending.current.delete(requestId);
      if (mounted.current) setRequestStopStates(current => ({ ...current, [requestId]: { stopping: !saved, error } }));
    }
  }
  useEffect(() => {
    for (const requestId of requestStopsPending.current)
      if (room?.rounds.some(round => round.requestId === requestId)) void stopRequest(requestId);
  }, [room]);
  const renderRequestStop = (requestId: string, label: string) => {
    const state = requestStopStates[requestId];
    return <button type="button" className="secondary actor-room-reply-stop" aria-label={label} title={state?.stopping ? `${label} · Stopping…` : label} disabled={state?.stopping} onClick={() => void stopRequest(requestId)}>
      {state?.stopping ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}{state?.stopping ? "Stopping…" : actor && "Stop"}
    </button>;
  };
  const [replyRetryStates, setReplyRetryStates] = useState<Record<string, { retrying: boolean; error?: string }>>({});
  // Group chat folds long prompts/briefs and unrelated replies; keys are per round so reloads start folded.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (key: string) => setExpanded(current => ({ ...current, [key]: !current[key] }));
  const renderFoldableText = (key: string, text: string, className = "actor-room-text") => {
    if (!isLongActorText(text)) return <p className={className}>{text}</p>;
    const open = !!expanded[key];
    const id = `actor-room-fold-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    return <div className="actor-room-fold" data-collapsed={!open || undefined}>
      <p id={id} className={className}>{text}</p>
      <button type="button" className="actor-room-fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => toggleExpanded(key)}>
        <ChevronDown aria-hidden="true" />{open ? "Show less" : "Show more"}
      </button>
    </div>;
  };
  const replyRetriesInFlight = useRef(new Set<string>());
  async function retryReply(roundId: string, actorId: string) {
    const key = JSON.stringify([roundId, actorId]);
    if (replyRetriesInFlight.current.has(key)) return;
    replyRetriesInFlight.current.add(key);
    setReplyRetryStates(current => ({ ...current, [key]: { retrying: true } }));
    let error: string | undefined;
    try {
      await apiJson(`${base}/rounds/${encodeURIComponent(roundId)}/replies/${encodeURIComponent(actorId)}/retry`, { method: "POST", body: {} });
      await refresh();
    } catch (cause) { error = `Retry failed: ${cause instanceof Error ? cause.message : String(cause)}`; await refresh().catch(() => {}); }
    finally {
      replyRetriesInFlight.current.delete(key);
      if (mounted.current) setReplyRetryStates(current => ({ ...current, [key]: { retrying: false, error } }));
    }
  }
  async function stopTask(turn: { sessionId: string; turnId: string }) {
    const key = taskStopKey(turn.sessionId, turn.turnId);
    if (taskStopsInFlight.current.has(key)) return;
    taskStopsInFlight.current.add(key);
    setTaskStopStates(current => ({ ...current, [key]: { stopping: true } }));
    let error: string | undefined;
    try {
      await apiJson("/api/runner/stop", { method: "POST", body: { sessionId: turn.sessionId, turnId: turn.turnId } });
      await refresh();
    } catch (cause) {
      error = `Stop failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      taskStopsInFlight.current.delete(key);
      if (mounted.current) setTaskStopStates(current => ({ ...current, [key]: { stopping: false, error } }));
    }
  }
  async function cancelTask(workItemId: string) {
    if (taskCancelsInFlight.current.has(workItemId)) return;
    taskCancelsInFlight.current.add(workItemId);
    setTaskCancelStates(current => ({ ...current, [workItemId]: { cancelling: true } }));
    let error: string | undefined;
    try {
      await apiJson(`${base}/work-items/${encodeURIComponent(workItemId)}/cancel`, { method: "POST" });
      await refresh();
    } catch (cause) {
      error = `Cancel failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally {
      taskCancelsInFlight.current.delete(workItemId);
      if (mounted.current) setTaskCancelStates(current => ({ ...current, [workItemId]: { cancelling: false, error } }));
    }
  }
  const stopRef = useRef<() => void>(() => {});
  async function stopWork() {
    if (!actor || stoppingRef.current || !stoppable.length) return;
    const dialogId = keys.id;
    stoppingRef.current = true;
    escapeStopUntil.current = 0;
    setStopHint(""); setStopping(true); setRequestError("");
    // Only the tasks of this dialog's rounds are stopped, through the same endpoint as the main Composer.
    const results = await Promise.allSettled(stoppable.map(turn => apiJson(`/api/runner/stop`, { method: "POST", body: { turnId: turn.turnId, sessionId: turn.sessionId } })));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    stoppingRef.current = false;
    if (mounted.current) {
      if (failed && keysRef.current.id === dialogId) setRequestError(`Stop failed: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`);
      setStopping(false); await refresh();
    }
  }
  stopRef.current = () => void stopWork();
  const mentionOptions = mention ? chatActors.filter(actor => domainActorMatchesMention(actor, mention.query)) : [];
  const mentionIndex = Math.min(mention?.index ?? 0, Math.max(0, mentionOptions.length - 1));
  function changePrompt(value: string, caret: number | null = value.length) {
    setPrompt(value);
    suggestions.change(value, caret);
    const trigger = findMentionTrigger(value, caret);
    setMention(current => trigger ? { ...trigger, index: current?.query === trigger.query ? current.index : 0 } : null);
  }
  function selectMention(actor: DomainActor) {
    if (!mention) return;
    const inserted = `@${actor.name} `;
    setPrompt(`${prompt.slice(0, mention.start)}${inserted}${prompt.slice(mention.end)}`);
    setMention(null);
    suggestions.dismiss();
    const caret = mention.start + inserted.length;
    window.requestAnimationFrame(() => composerRef.current?.setCaret(caret));
  }
  function selectSuggestion(suggestion: ComposerSuggestion) {
    const next = suggestions.replacement(promptRef.current, suggestion);
    if (!next) return;
    setPrompt(next.value); setMention(null);
    window.requestAnimationFrame(() => composerRef.current?.setCaret(next.caret));
  }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (mention) {
      if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
      if (mentionOptions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setMention({ ...mention, index: (mentionIndex + (event.key === "ArrowDown" ? 1 : -1) + mentionOptions.length) % mentionOptions.length });
        return;
      }
      if (mentionOptions.length && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault(); selectMention(mentionOptions[mentionIndex]); return;
      }
    }
    if (suggestions.trigger) {
      if (event.key === "Escape") { event.preventDefault(); suggestions.dismiss(); return; }
      const count = suggestions.suggestions.length;
      if (count && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        suggestions.setIndex(current => current < 0 ? event.key === "ArrowDown" ? 0 : count - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        return;
      }
      if (count && !event.shiftKey && (event.key === "Tab" || suggestions.index >= 0 && (event.key === "Enter" || event.key === " "))) {
        event.preventDefault(); selectSuggestion(suggestions.suggestions[suggestions.index] ?? suggestions.suggestions[0]); return;
      }
    }
    if (event.key === "Escape" && actor && !disableEscapeStop && stoppable.length) {
      event.preventDefault();
      if (event.repeat || stoppingRef.current) return;
      if (Date.now() < escapeStopUntil.current) stopRef.current();
      else { escapeStopUntil.current = Date.now() + 1800; setStopHint("Press Esc again to stop"); }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  }
  useEffect(() => {
    suggestions.dismiss();
    followReplies.current = true;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [workspaceId, viewActor?.id, chatKey]);
  useEffect(() => {
    if (followReplies.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [room?.revision, pending, roundtables.links.length, roundtables.receipts.length]);
  useEffect(() => {
    if (!editor) return;
    const previous = document.activeElement as HTMLElement | null;
    editorRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    return () => previous?.focus();
  }, [!!editor]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    escapeStopUntil.current = 0;
    setStopHint("");
  }, [keys.id, stoppable.length]);
  useEffect(() => {
    if (!stopHint) return;
    const timer = window.setTimeout(() => { setStopHint(""); escapeStopUntil.current = 0; }, 1800);
    return () => window.clearTimeout(timer);
  }, [stopHint]);
  // A successful room read clears a stale sign-in prompt from an earlier request.
  useEffect(() => { setAuthRequired(false); }, [room]);
  useEffect(() => {
    // Each actor dialog keeps its own draft and pending receipt.
    if (loadedKey.current === keys.id) return;
    loadedKey.current = keys.id;
    const saved = receipts.current.get(keys.pending) ?? readPending(keys.pending);
    receipts.current.set(keys.pending, saved);
    setPending(saved); promptRef.current = readDraft(keys.draft); setPromptValue(promptRef.current); setMention(null); setRequestError("");
    quotesRef.current = readQuotes(keys.draft); setQuotesValue(quotesRef.current);
    replyContextRef.current = readReply(keys.draft); setReplyContextValue(replyContextRef.current); setSelectionQuote(null);
  }, [keys.id]);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".actor-room-messages, .response-quote-popover")) setSelectionQuote(null); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setSelectionQuote(null); };
    document.addEventListener("mouseup", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mouseup", dismiss); document.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    // The POST can lose its connection after the server saves the request.
    // A room snapshot acknowledges delivery even if that POST failed or is still open.
    if (pending.some(item => room?.rounds.some(round => round.requestId === item.requestId))) {
      updatePending(keys, items => items.filter(item => !room?.rounds.some(round => round.requestId === item.requestId)));
    }
  }, [room, pending]);
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (roundtableMode) { await startRoundtable(); return; }
    if (!room || !chatActors.length || (!promptRef.current.trim() && !quotesRef.current.length && !files.attachments.length) || files.reading || blocked) return;
    const sent = keys;
    const reply = replyContextRef.current;
    const context = [...quotesRef.current, ...(reply ? [replyAnnotation(reply, workspaceId)] : [])];
    const request: PendingRequest = { requestId: crypto.randomUUID(), approvalPolicy, userPrompt: context.length ? formatResponseAnnotationsPrompt(context, promptRef.current) : promptRef.current, ...(files.attachments.length ? { attachments: files.attachments } : {}), namedActorIds: actor ? [actor.id] : reply ? [reply.actorId] : preview.named.map(actor => actor.id), responseProfile: { model: activeGear.model, effort: activeGear.effort },
      ...(chatKey !== undefined ? { chatProjectId } : {}) };
    updatePending(sent, items => [...items, request]);
    setPrompt(""); setQuotes([]); setReplyContext(null); files.clear(); setMention(null); suggestions.dismiss(); setRequestError("");
    followReplies.current = true;
    await submitReceipt(sent, request);
  }
  async function startRoundtable() {
    if ((!promptRef.current.trim() && !quotesRef.current.length && !replyContextRef.current) || files.reading || roundtableBlocked) return;
    const reply = replyContextRef.current;
    const context = [...quotesRef.current, ...(reply ? [replyAnnotation(reply, workspaceId)] : [])];
    const message = context.length ? formatResponseAnnotationsPrompt(context, promptRef.current) : promptRef.current;
    const cast = roundtableDraft.actors;
    // Like the session composer, the mode applies to one prompt and the cast is remembered.
    setPrompt(""); setQuotes([]); setReplyContext(null); setMention(null); suggestions.dismiss(); setRequestError(""); roundtableDraft.disable();
    followReplies.current = true;
    const view = await roundtables.start({ message, actors: cast, ...(reply?.roundId ? { sourceRoundId: reply.roundId } : {}) });
    if (view?.sessionId.trim() && mounted.current) onOpenSession(view.sessionId);
  }
  async function submitReceipt(sent: DialogKeys, receipt: Receipt) {
    if (inFlight.current.has(receipt.requestId)) return;
    const { requestId, userPrompt, attachments, namedActorIds, responseProfile, approvalPolicy, newSessionProjectId, newSessionCwd, chatProjectId } = receipt;
    const request: PendingRequest = { requestId, userPrompt, attachments, namedActorIds, responseProfile, approvalPolicy, newSessionProjectId, newSessionCwd, ...(chatProjectId !== undefined ? { chatProjectId } : {}) };
    inFlight.current.add(requestId); setSendingIds([...inFlight.current]);
    updatePending(sent, items => items.map(item => item.requestId === requestId ? { ...item, error: undefined } : item));
    try {
      const round = await apiJson<ActorRound>(`${base}/requests`, { method: "POST", body: request });
      updatePending(sent, items => items.map(item => item.requestId === requestId ? { ...item, round } : item));
      if (mounted.current) {
        void refresh();
      }
    } catch (cause) {
      updatePending(sent, items => items.map(item => item.requestId === requestId ? { ...item, error: cause instanceof Error ? cause.message : String(cause) } : item));
      if (mounted.current) {
        if (keysRef.current.id === sent.id) setAuthRequired(isAuthRequired(cause));
        void refresh();
      }
    } finally { inFlight.current.delete(requestId); if (mounted.current) setSendingIds([...inFlight.current]); }
  }
  async function retryLaunch(round: ActorRound) {
    if (retryingRound) return;
    setRetryingRound(round.id); setRequestError("");
    try {
      await apiJson(`${base}/requests`, { method: "POST", body: { ...round.taskSelection, requestId: round.requestId, userPrompt: round.userPrompt, attachments: round.attachments, namedActorIds: round.namedActorIds, responseProfile: round.responseProfile, approvalPolicy: round.approvalPolicy, chatProjectId: actorRoundChatKey(round) } });
      if (mounted.current) await refresh();
    } catch (cause) { if (mounted.current) { setAuthRequired(cause instanceof ApiError && (cause.code === "AUTH_REQUIRED" || cause.status === 401)); setRequestError(cause instanceof Error ? cause.message : String(cause)); } }
    finally { if (mounted.current) setRetryingRound(null); }
  }
  async function retryFailedRound(round: ActorRound) {
    // A new round reruns inference. Its stable identity makes double clicks/reloads safe.
    const requestId = `retry:${round.id}`;
    if (room?.workItems.some(work => work.roundId === round.id) || room?.rounds.some(round => round.requestId === requestId)) return;
    const request: PendingRequest = { ...round.taskSelection, requestId, userPrompt: round.userPrompt, attachments: round.attachments, namedActorIds: round.namedActorIds, responseProfile: round.responseProfile, approvalPolicy: round.approvalPolicy, chatProjectId: actorRoundChatKey(round) };
    updatePending(keys, items => items.some(item => item.requestId === requestId) ? items : [...items, request]);
    followReplies.current = true;
    await submitReceipt(keys, request);
  }
  function openEditor(actor: DomainActor | null, parent?: DomainActor) {
    setEditor({ actor, memory: actor ? { rolePrompt: actor.memory.rolePrompt, roleSummary: actor.memory.roleSummary, longTerm: actor.memory.longTerm, rolling: actor.memory.rolling } : blankMemory(), version: actor?.memory.version });
    setDraft({ name: "", parentActorId: parent?.id ?? null, model: parent?.model ?? DEFAULT_MODEL, effort: parent?.effort ?? "medium", allowedModels: [...(parent?.allowedModels ?? MODEL_OPTIONS)], memory: blankMemory() });
    setEditorError(""); setConflict(false);
  }
  async function saveActor(event: FormEvent) {
    event.preventDefault(); if (!editor || saving) return;
    setSaving(true); setEditorError("");
    try {
      if (editor.actor) await apiJson(`${base}/actors/${encodeURIComponent(editor.actor.id)}/memory`, { method: "PATCH", body: { expectedVersion: editor.version, sourceEventId: `user:${crypto.randomUUID()}`, memory: editor.memory } });
      else await apiJson(`${base}/actors`, { method: "POST", body: { ...draft, memory: editor.memory } });
      if (mounted.current) { setEditor(null); await refresh(); }
    } catch (cause) {
      if (mounted.current) { setAuthRequired(cause instanceof ApiError && (cause.code === "AUTH_REQUIRED" || cause.status === 401)); setConflict(cause instanceof ApiError && cause.status === 409); setEditorError(cause instanceof ApiError && cause.status === 409 ? "This memory changed while you were editing. Your draft is preserved. Load the latest version before merging your changes." : cause instanceof Error ? cause.message : String(cause)); await refresh(); }
    } finally { if (mounted.current) setSaving(false); }
  }
  const actorName = (id: string) => actors.find(actor => actor.id === id)?.name ?? id;
  const renderRound = (round: ActorRound) => {
    if (!room) return null;
    const works = actorRoundWorkItems(room, round);
    const waiting = ["queued", "responding"].includes(round.status);
    // Group chat: tasks go into one block at the bottom, claims into one block, unrelated replies fold.
    // An actor's own timeline keeps tasks and claims inside each reply.
    const grouped = !actor;
    const claims = round.replies.filter(reply => reply.status === "claimed");
    const relatedIds = new Set([...claims.map(reply => reply.actorId), ...works.flatMap(work => [work.ownerActorId, work.executorActorId])]);
    const unrelated = (reply: ActorRound["replies"][number]) => grouped && !relatedIds.has(reply.actorId)
      && (reply.status === "opinion" || reply.status === "stopped")
      && (relatedIds.size > 0 || (reply.intent === "work" && reply.inRole === false));
    const speakerIds = [...new Set([...round.stakeholderIds, ...round.replies.map(reply => reply.actorId), ...works.map(work => work.ownerActorId)])]
      .map((id, index) => ({ id, index, folded: (() => { const reply = round.replies.find(reply => reply.actorId === id); return !!reply && unrelated(reply); })() }))
      .sort((a, b) => Number(a.folded) - Number(b.folded) || a.index - b.index).map(item => item.id);
    const identityOf = (id: string) => actors.find(actor => actor.id === id) ?? round.actorSnapshots.find(actor => actor.id === id) ?? { id, name: actorName(id) };
    // An actor's own timeline: full task card inside the reply. Task stop lives in group chat only.
    const renderWork = (work: typeof works[number]) => {
      const presentation = actorTaskPresentation(work, room.events);
      const binding = room.rounds.find(source => source.id === work.roundId)?.taskBinding;
      const cancelState = taskCancelStates[work.id];
      const host = work.hostWorkItemId ? works.find(item => item.id === work.hostWorkItemId) : undefined;
      const hosting = works.some(item => item.hostWorkItemId === work.id);
      return <div key={work.id} className="actor-room-work" data-work-item-id={work.id} data-started={presentation.started || undefined} data-native-child={work.hostWorkItemId ? true : undefined}>
        <span>{round.continuation?.workItem?.id === work.id ? "Existing task" : work.hostWorkItemId ? "Sub-agent task" : hosting ? "Integration task" : "Created task"}</span><strong>{presentation.label}</strong><p>Owner: {actorName(work.ownerActorId)}{work.executorActorId !== work.ownerActorId ? ` · Working actor: ${actorName(work.executorActorId)}` : ""} · {modelLabel(work.model)}</p>
        {work.hostWorkItemId && <p className="actor-room-notice">Runs as a native sub-agent in {host ? actorName(host.executorActorId) : "the integration owner"}'s session; that session coordinates and verifies the split.</p>}
        {hosting && <p className="actor-room-notice">Hosts this split: runs the other assignments as sub-agents and verifies the integrated result.</p>}
        <p>{round.allocation?.assignments.find(item => item.id === work.allocationId)?.brief ?? work.delegatedTask ?? actorOwnerExplanation(round, actors)}</p>
        {binding && <p>Project directory: {binding.cwd}</p>}
        {!work.taskSessionId?.trim() && <p className="actor-room-notice">Session not available yet</p>}
        <div className="actor-room-work-actions">
        {work.taskSessionId?.trim() && <button type="button" className="secondary" onClick={() => onOpenSession(work.taskSessionId)}>{work.hostWorkItemId ? "Open host session" : "Open task"}</button>}
        {work.status === "failed" && !work.cancelledAt && <button type="button" className="secondary actor-room-task-cancel" aria-label={`Cancel ${actorName(work.executorActorId)} task`} disabled={cancelState?.cancelling} onClick={() => void cancelTask(work.id)}>
          {cancelState?.cancelling ? <Loader2 className="spin" aria-hidden="true" /> : <X aria-hidden="true" />}{cancelState?.cancelling ? "Cancelling…" : "Cancel task"}
        </button>}
        {work.dispatchError && (!work.hostWorkItemId || !work.dispatched) && !work.cancelledAt && <button type="button" className="secondary" disabled={!!retryingRound} onClick={() => void retryLaunch(round)}>{retryingRound === round.id ? "Retrying…" : "Retry task launch"}</button>}
        </div>
        {cancelState?.error && <p role="alert" className="actor-room-error">{cancelState.error}</p>}
        {work.dispatchError && <p role="alert">{work.dispatchError}</p>}
      </div>;
    };
    const renderClaim = (reply: ActorRound["replies"][number], ownedWork: typeof works) => <div className="actor-room-claim">
      <strong>{reply.claimKind === "partial" ? `Partial claim · ${reply.claimScope}` : "Full claim"}</strong>
      {!ownedWork.length && <span>No session for this claim</span>}
      {ownedWork.length === 1 && ownedWork[0].taskSessionId?.trim() && <button type="button" className="secondary" onClick={() => onOpenSession(ownedWork[0].taskSessionId)}>Open claim session</button>}
      {ownedWork.length > 1 && <span>Choose a created task below</span>}
    </div>;
    // Group chat task block: one line per task (executor, kind, status, icon actions); details expand in place.
    // Status, open and stop act on a whole task (a host session covers its sub-agents), so they render once per task.
    const renderTaskControls = (work: typeof works[number]) => {
      const presentation = actorTaskPresentation(work, room.events);
      const turn = actorStoppableTurns([work], [{ id: work.roundId }])[0];
      const stopState = turn ? taskStopStates[taskStopKey(turn.sessionId, turn.turnId)] : undefined;
      const openLabel = work.hostWorkItemId ? "Open host session" : "Open task";
      return <>
        <div className="actor-room-task-controls">
          <span className="actor-room-task-status" data-state={presentation.started ? "started" : undefined}>{work.taskSessionId?.trim() ? presentation.label : "Session not available yet"}</span>
          {work.taskSessionId?.trim() && <button type="button" className="secondary" aria-label={openLabel} title={openLabel} onClick={() => onOpenSession(work.taskSessionId)}><ExternalLink aria-hidden="true" /></button>}
          {turn && <button type="button" className="secondary actor-room-task-stop" aria-label={`Stop ${actorName(work.executorActorId)} task`} title={`Stop ${actorName(work.executorActorId)} task${stopState?.stopping ? " · Stopping…" : ""}`} disabled={stopState?.stopping} onClick={() => void stopTask(turn)}>
            {stopState?.stopping ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
          </button>}
        </div>
        {stopState?.error && <p role="alert" className="actor-room-error">{stopState.error}</p>}
      </>;
    };
    const renderTaskRow = (work: typeof works[number], withControls: boolean) => {
      const presentation = actorTaskPresentation(work, room.events);
      const binding = room.rounds.find(source => source.id === work.roundId)?.taskBinding;
      const cancelState = taskCancelStates[work.id];
      const host = work.hostWorkItemId ? works.find(item => item.id === work.hostWorkItemId) : undefined;
      const hosting = works.some(item => item.hostWorkItemId === work.id);
      // How the working actor relates to the owner, so a non-stakeholder executor is explained.
      const executorParent = (actors.find(item => item.id === work.executorActorId) ?? round.actorSnapshots.find(item => item.id === work.executorActorId))?.parentActorId;
      const relation = work.executorActorId === work.ownerActorId ? "" : executorParent === work.ownerActorId
        ? `Sub-actor of ${actorName(work.ownerActorId)}` : `Delegated by ${actorName(work.ownerActorId)}`;
      const kind =round.continuation?.workItem?.id === work.id ? "Existing task" : work.hostWorkItemId ? "Sub-agent" : hosting ? "Integration" : "Task";
      const brief = round.allocation?.assignments.find(item => item.id === work.allocationId)?.brief ?? work.delegatedTask ?? actorOwnerExplanation(round, actors);
      const key = `task:${work.id}`;
      const open = !!expanded[key];
      const detailId = `actor-room-fold-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      // A lone top-level task's block carries its id, since the block is that task's card.
      return <li key={work.id} className="actor-room-work" data-work-item-id={soleTask?.id === work.id ? undefined : work.id} data-owner-actor-id={work.ownerActorId}
        data-started={presentation.started || undefined} data-native-child={work.hostWorkItemId ? true : undefined} data-collapsed={!open || undefined}>
        <div className="actor-room-task-line">
          <button type="button" className="actor-room-task-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => toggleExpanded(key)}>
            <ChevronRight aria-hidden="true" />
            {/* The avatar is the working actor (whose session runs and whose task Stop stops); a different owner is named after "for". */}
            <DomainActorIdentity actor={identityOf(work.executorActorId)} detail={[relation, kind, modelLabel(work.model)].filter(Boolean).join(" · ")} />
            {!open && <span className="actor-room-task-brief">{brief.replace(/\s+/g, " ").trim()}</span>}
          </button>
          {withControls && renderTaskControls(work)}
          <div className="actor-room-work-actions">
            {work.status === "failed" && !work.cancelledAt && <button type="button" className="secondary actor-room-task-cancel" aria-label={`Cancel ${actorName(work.executorActorId)} task`} title={`Cancel ${actorName(work.executorActorId)} task${cancelState?.cancelling ? " · Cancelling…" : ""}`} disabled={cancelState?.cancelling} onClick={() => void cancelTask(work.id)}>
              {cancelState?.cancelling ? <Loader2 className="spin" aria-hidden="true" /> : <X aria-hidden="true" />}
            </button>}
            {work.dispatchError && (!work.hostWorkItemId || !work.dispatched) && !work.cancelledAt && <button type="button" className="secondary" aria-label="Retry task launch" title="Retry task launch" disabled={!!retryingRound} onClick={() => void retryLaunch(round)}><RotateCcw aria-hidden="true" />{retryingRound === round.id ? "Retrying…" : "Retry"}</button>}
          </div>
        </div>
        {cancelState?.error && <p role="alert" className="actor-room-error">{cancelState.error}</p>}
        {work.dispatchError && <p role="alert" className="actor-room-error">{work.dispatchError}</p>}
        <div id={detailId} className="actor-room-task-detail" hidden={!open}>
          <p>{relation ? `Working actor: ${actorName(work.executorActorId)} (${relation.toLowerCase().startsWith("sub-actor") ? "sub-actor" : "delegated"}) · Owner: ${actorName(work.ownerActorId)}` : `Owner: ${actorName(work.ownerActorId)}`}</p>
          {work.hostWorkItemId && <p className="actor-room-notice">Runs as a native sub-agent in {host ? actorName(host.executorActorId) : "the integration owner"}'s session; that session coordinates and verifies the split.</p>}
          {hosting && <p className="actor-room-notice">Hosts this split: runs the other assignments as sub-agents and verifies the integrated result.</p>}
          <p className="actor-room-work-brief">{brief}</p>
          {binding && <p>Project directory: {binding.cwd}</p>}
        </div>
      </li>;
    };
    // Sub-agents sit under their host; an orphaned child (host not in this round) stays top level.
    const topWorks = works.filter(work => !work.hostWorkItemId || !works.some(item => item.id === work.hostWorkItemId));
    const soleTask = topWorks.length === 1 ? topWorks[0] : undefined;
    const taskOnlyOwners = [...new Set(works.map(work => work.ownerActorId))].filter(owner => !round.replies.some(reply => reply.actorId === owner));
    const { page, text: promptText } = splitActorPromptPageContext(round.userPrompt);
    const annotations = parseResponseAnnotations(promptText);
    return <section key={round.id} className="actor-room-round side-chat-exchange" aria-label="Conversation round">
      <article className="side-chat-question" aria-label="You">
        {page && <p className="actor-room-page-context" title={[page.url, page.selector].filter(Boolean).join("\n")}><Globe aria-hidden="true" /><span>Page context · {page.title ?? page.url}{page.selector ? ` · ${page.selector}` : ""}</span></p>}
        {annotations && <ResponseAnnotationList annotations={annotations.annotations} />}
        {(annotations?.content ?? promptText) && (grouped ? renderFoldableText(`prompt:${round.id}`, annotations?.content ?? promptText) : <p className="actor-room-text">{annotations?.content ?? promptText}</p>)}
        {!!round.attachments?.length && <AttachmentList attachments={round.attachments} />}
        <ChatMessageActions text={promptText} />
      </article>
      {speakerIds.map(id => {
        const reply = round.replies.find(reply => reply.actorId === id);
        const replyStop = replyStopStates[JSON.stringify([round.id, id])];
        const replyRetry = replyRetryStates[JSON.stringify([round.id, id])];
        const ownedWork = works.filter(work => work.ownerActorId === id);
        // Grouped task-only owners appear in the task block, which carries their reply action.
        if (!reply && grouped && !waiting) return null;
        // Group chat folds unrelated replies (dimmed) into one expandable line.
        if (reply && unrelated(reply)) {
          const key = `reply:${round.id}:${id}`;
          const open = !!expanded[key];
          const bodyId = `actor-room-fold-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          const body = reply.text || "No reply text.";
          return <article className="side-chat-bubble actor-room-folded actor-room-unrelated" key={id} data-actor-id={id} data-reply-status={reply.status} data-collapsed={!open || undefined}>
            <header><button type="button" className="actor-room-unrelated-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => toggleExpanded(key)}>
              <ChevronRight aria-hidden="true" />
              <DomainActorIdentity actor={identityOf(id)} detail={reply.status === "stopped" ? "Stopped" : reply.inRole === false ? "Unrelated to my role" : "Not taking this"} />
              {!open && <span className="actor-room-unrelated-summary">{body.replace(/\s+/g, " ").trim()}</span>}
            </button></header>
            <div id={bodyId} hidden={!open}>
              <div className="side-chat-answer"><MarkdownContent>{body}</MarkdownContent></div>
              <ChatMessageActions text={reply.text || ""} replyLabel={`Reply to ${actorName(id)}`}
                onReply={actors.some(candidate => candidate.id === id) ? () => replyToMessage(id, round.id, body, ownedWork) : undefined} />
            </div>
          </article>;
        }
        if (!reply) return waiting || ownedWork.length ? <article className="side-chat-bubble" key={id} data-actor-id={id} data-reply-status={waiting ? "waiting" : "task"}>
          <header><DomainActorIdentity actor={actors.find(actor => actor.id === id) ?? round.actorSnapshots.find(actor => actor.id === id) ?? { id, name: actorName(id) }} detail={waiting ? "Waiting for reply" : "Created tasks"} /></header>
          {waiting && <div className="side-chat-answer">
            <div className="actor-room-reply-progress"><p className="side-chat-state" role="status"><Loader2 className="spin" aria-hidden="true" />Waiting for {actorName(id)}…</p>
              <button type="button" className="secondary actor-room-reply-stop" aria-label={`Stop ${actorName(id)} reply`} title={`Stop ${actorName(id)} reply${replyStop?.stopping ? " · Stopping…" : ""}`} disabled={replyStop?.stopping} onClick={() => void stopReply(round.id, id)}>
                {replyStop?.stopping ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}{replyStop?.stopping ? "Stopping…" : !grouped && "Stop"}
              </button>
            </div>
            {replyStop?.error && <p role="alert" className="actor-room-error">{replyStop.error}</p>}
          </div>}
          {!waiting && <ChatMessageActions text="" replyLabel={`Reply to ${actorName(id)}`}
            onReply={(!actor || actor.id === id) && actors.some(candidate => candidate.id === id) ? () => replyToMessage(id, round.id, "Created tasks", ownedWork) : undefined} />}
          {!grouped && ownedWork.map(renderWork)}
        </article> : null;
        // Group chat claims stay open: a badge beside the name, one body (reply text, falling back to the scope).
        const groupedClaim = grouped && reply.status === "claimed";
        const claimLabel = reply.claimKind !== "partial" ? "Full claim" : reply.claimScope ? `Partial claim · ${reply.claimScope}` : "Partial claim";
        return <article className="side-chat-bubble" key={id} data-actor-id={id} data-reply-status={reply.status}>
        <header><DomainActorIdentity actor={actors.find(actor => actor.id === reply.actorId) ?? round.actorSnapshots.find(actor => actor.id === reply.actorId) ?? { id: reply.actorId, name: actorName(reply.actorId) }} detail={`${reply.status === "stopped" ? "Stopped" : reply.status === "claimed" ? groupedClaim ? "" : "Offered to take this" : reply.status === "opinion" ? reply.intent === "work" && reply.inRole === false ? "Unrelated to my role" : "Opinion" : reply.status === "timeout" ? "Timed out" : "Reply failed"}${round.responseProfile ? ` · ${modelLabel(round.responseProfile.model)} · ${round.responseProfile.effort}` : reply.model ? ` · ${modelLabel(reply.model)}` : ""}`.replace(/^ · /, "")} />
          {groupedClaim && <span className="actor-room-claim-badge" data-claim-kind={reply.claimKind === "partial" ? "partial" : "full"} role="note" tabIndex={0}
            title={claimLabel} aria-label={claimLabel}>{reply.claimKind === "partial" ? "Partial claim" : "Claim"}</span>}</header>
        <div className="side-chat-answer"><MarkdownContent>{reply.text || reply.error || (groupedClaim && reply.claimScope) || (reply.status === "timeout" ? "No reply before the deadline." : "No reply text.")}</MarkdownContent></div>
        <ChatMessageActions text={reply.text || reply.error || ""} replyLabel={`Reply to ${actorName(id)}`}
          onReply={(!actor || actor.id === id) && actors.some(candidate => candidate.id === id) ? () => replyToMessage(id, round.id, reply.text || reply.error || "No reply text.", ownedWork) : undefined} />
        {!actor && (reply.status === "error" || reply.status === "timeout") && (round.status === "no_claims" || round.status === "routing_failed") && !works.length && !round.continuation?.workItem && <>
          <button type="button" className="secondary actor-room-reply-retry" aria-label={`Retry ${actorName(id)} reply`} title={`Retry ${actorName(id)} reply`} disabled={replyRetry?.retrying} onClick={() => void retryReply(round.id, id)}>
            {replyRetry?.retrying ? <Loader2 className="spin" aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}{replyRetry?.retrying ? "Retrying…" : "Retry"}
          </button>
          {replyRetry?.error && <p role="alert" className="actor-room-error">{replyRetry.error}</p>}
        </>}
        {!grouped && reply.status === "claimed" && renderClaim(reply, ownedWork)}
        {!grouped && ownedWork.map(renderWork)}
      </article>; })}
      {waiting && !speakerIds.length && <div className="actor-room-reply-progress"><p className="side-chat-state" role="status"><Loader2 className="spin" aria-hidden="true" />Choosing actors…</p>
        {!round.continuation?.workItem && renderRequestStop(round.requestId, "Stop choosing actors")}</div>}
      {waiting && !speakerIds.length && requestStopStates[round.requestId]?.error && <p role="alert" className="actor-room-error">{requestStopStates[round.requestId].error}</p>}
      {round.status === "no_claims" && <p className="actor-room-notice">{round.stoppedAt ? "Stopped. No actor was asked to reply." : round.replies.length > 0 && round.replies.every(reply => reply.status === "stopped") ? "Chat replies stopped." : "No actor offered to take this. Review the replies and send a follow-up."}</p>}
      {round.status === "awaiting_pickup" && <p className="actor-room-notice" role="status">{works.filter(work => work.pickedUpAt).length}/{round.workItemIds?.length ?? works.length} tasks picked up. {round.error}</p>}
      {round.status === "routing_failed" && <>
        <p role="alert" className="actor-room-error">Could not route this request. {actorRoutingFailure(round, actors)}</p>
        {!works.length && !room.rounds.some(candidate => candidate.requestId === `retry:${round.id}`) && <button type="button" className="secondary" aria-label="Retry request" title="Retry request"
          disabled={sendingIds.includes(`retry:${round.id}`)} onClick={() => void retryFailedRound(round)}>
          {grouped && <RotateCcw aria-hidden="true" />}{sendingIds.includes(`retry:${round.id}`) ? "Retrying…" : grouped ? "Retry" : "Retry request"}
        </button>}
      </>}
      {grouped && works.length > 0 && <section className="actor-room-tasks" aria-label="Tasks" data-work-item-id={soleTask?.id}>
        {/* One task (with any sub-agents): its controls sit once at the block's top right. Several independent tasks keep them per task. */}
        <div className="actor-room-tasks-head">
          <strong className="actor-room-block-title">Tasks ({works.length})</strong>
          {soleTask && renderTaskControls(soleTask)}
        </div>
        <ul className="actor-room-task-list">{topWorks.flatMap(work => {
          const children = works.filter(item => item.hostWorkItemId === work.id);
          return [renderTaskRow(work, !soleTask), ...(children.length ? [<li key={`${work.id}:children`} className="actor-room-task-children"><ul>{children.map(child => renderTaskRow(child, false))}</ul></li>] : [])];
        })}</ul>
        {taskOnlyOwners.map(owner => actors.some(candidate => candidate.id === owner) && <ChatMessageActions key={owner} text="" replyLabel={`Reply to ${actorName(owner)}`}
          onReply={() => replyToMessage(owner, round.id, "Created tasks", works.filter(work => work.ownerActorId === owner))} />)}
      </section>}
    </section>;
  };
  const pendingMessages = dialogReceipts.map(({ item, target }) => {
    const visible = rounds.some(round => round.requestId === item.requestId);
    if (visible) return null;
    const sending = sendingIds.includes(item.requestId);
    const { text, page } = splitActorPromptPageContext(item.userPrompt);
    const annotations = parseResponseAnnotations(text);
    return <section key={item.requestId} className="actor-room-round side-chat-exchange" aria-label="Message delivery">
      {actor && <div className="actor-timeline-meta"><span>{item.namedActorIds.length === 1 ? "Direct" : "Group chat"}</span></div>}
      {!visible && <article className="side-chat-question" aria-label="You">
        {page && <p className="actor-room-page-context"><Globe aria-hidden="true" />Page context · {page.title ?? page.url}</p>}
        {annotations && <ResponseAnnotationList annotations={annotations.annotations} />}
        <p className="actor-room-text">{annotations?.content ?? text}</p>
        {!!item.attachments?.length && <AttachmentList attachments={item.attachments} />}
        <ChatMessageActions text={text} />
      </article>}
      {item.error ? <p role="alert" className="actor-room-error">{item.error} Your message is saved.</p> : <div className="actor-room-reply-progress"><p className="side-chat-state" role="status">{sending ? "Sending…" : "Confirming delivery…"}</p>
        {sending && renderRequestStop(item.requestId, "Stop sending")}</div>}
      {requestStopStates[item.requestId]?.error && <p role="alert" className="actor-room-error">{requestStopStates[item.requestId].error}</p>}
      {!sending && !item.round && <button type="button" className="secondary" aria-label="Retry same request" title="Retry same request" onClick={() => void submitReceipt(target, item)}>{!actor && <RotateCcw aria-hidden="true" />}{actor ? "Retry same request" : "Retry"}</button>}
    </section>;
  });
  const workspaceEscalated = visibleBlockers(room?.blockers).filter(blocker => blocker.status === "escalated");
  return <>
    <div className="messages-pane actor-room-messages-pane" onKeyDown={event => {
      // Group chat has no aggregate stop target. Do not pass Esc to a session's global stop shortcut.
      if (!actor && event.key === "Escape") event.preventDefault();
    }}>
      <div className="messages side-chat-messages actor-room-messages" data-group-chat={!actor || undefined} ref={scrollRef} role="region" tabIndex={0} aria-label="Actor conversation" onMouseUp={captureSelection} onKeyUp={event => { if (event.key !== "Escape") captureSelection(); }} onScroll={event => {
        setSelectionQuote(null);
        const node = event.currentTarget;
        followReplies.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}>
        {actor && <div className="actor-room-tools side-chat-roster">
            <DomainActorIdentity actor={actor} detail={actor.parentActorId ? `Sub-actor of ${actorName(actor.parentActorId)}` : undefined} />
            {unacknowledgedConclusions > 0 && <span className="actor-dialog-conclusion-count"
              aria-label={`${unacknowledgedConclusions} unacknowledged conclusions`}>{unacknowledgedConclusions}</span>}
            <button type="button" className="secondary" onClick={() => openEditor(actor)}><Brain aria-hidden="true" /> Edit memory</button>
            {!actor.parentActorId && <button type="button" className="secondary" onClick={() => openEditor(null, actor)}><Plus aria-hidden="true" /> Add sub-actor</button>}
          <button type="button" className="ghost-icon" onClick={() => void refresh()} aria-label="Refresh actors"><RefreshCw aria-hidden="true" /></button>
        </div>}
        {actor && !actor.parentActorId && <section className="actor-room-tree actor-room-children" aria-label={`Sub-actors of ${actor.name}`}>
          <strong>Sub-actors ({actors.filter(child => child.parentActorId === actor.id).length})</strong>
          {actors.filter(child => child.parentActorId === actor.id).map(child => <button key={child.id} type="button" className="secondary actor-room-sub" onClick={() => openEditor(child)}>
            <DomainActorIdentity actor={child} detail={`Sub-actor of ${actor.name} · ${modelLabel(child.model)}`} />
          </button>)}
          {!actors.some(child => child.parentActorId === actor.id) && <p className="actor-room-notice">No sub-actors yet. Add one to give it a role in this actor’s team.</p>}
        </section>}
        {!actor && room && <ActorBlockerList compactActions className="project-blockers" blockers={workspaceEscalated}
          actorName={actorName} label="Escalated workspace blockers" title="Escalated blockers" onOpenSession={onOpenSession} onDecided={() => void refresh()} />}
        {error && <p role="alert" className="actor-room-error">{error}</p>}
        {!room && !error && <p className="side-chat-state" role="status"><Loader2 className="spin" aria-hidden="true" />Loading actors…</p>}
        {!actor && room && <div className="actor-room-chat-heading" data-chat-key={chatKey}>
          <Users aria-hidden="true" /><h2>{chatTitle}</h2><span>{chatActors.filter(candidate => !candidate.parentActorId).length} workers</span>
        </div>}
        {!actor && room && !actors.length && <div className="side-chat-empty"><Users aria-hidden="true" /><strong>Your workspace actors</strong><span>No actors in this workspace yet.</span></div>}
        {!actor && actors.length > 0 && !chatActors.length && <div className="side-chat-empty"><Users aria-hidden="true" /><strong>{chatTitle}</strong>
          <span>No workers in this project yet. Assign workers to it in Settings → Agent actors → Workers.</span></div>}
        {!actor && chatActors.length > 0 && room?.rounds.length === 0 && !roundtables.links.length && <div className="side-chat-empty"><MessageCircle aria-hidden="true" /><strong>{chatTitle}</strong><span>Send a request, or type @ to choose actors.</span></div>}
        {actor && room && <div id="actor-dialog-panel" role="region" tabIndex={0} aria-label={`${actor.name} timeline`} className="actor-dialog-panel">
          {!timeline.length && !dialogReceipts.length && <div className="side-chat-empty"><DomainActorIdentity actor={actor} /><span>No activity yet. Send a message to begin.</span></div>}
          {timeline.map(entry => <div key={entry.id} className="actor-timeline-entry" data-timeline-kind={entry.kind}
            data-round-id={entry.kind === "conversation" ? entry.round.id : entry.kind === "task" ? entry.event.roundId : undefined}>
            <div className="actor-timeline-meta">
              <span>{entry.kind === "conversation" ? entry.source === "group" ? "Group chat" : `Direct · ${actorName(entry.round.namedActorIds[0])}` : entry.kind === "conclusion" ? "Reviewed conclusion" : "Task activity"}</span>
              <time dateTime={entry.created}>{actorTimelineTime(entry.created)}</time>
            </div>
            {entry.kind === "conversation" ? renderRound(entry.round) : entry.kind === "conclusion" ?
              <ActorConclusionMessages workspaceId={workspaceId} actor={actor} conclusions={[entry.conclusion]}
                onRoom={(roomState ?? ownRoom).setRoom} onOpenSession={onOpenSession}
                onReply={conclusion => replyToMessage(actor.id, room.workItems.find(work => work.id === conclusion.workItemId)?.roundId ?? "", conclusion.text, [{ id: conclusion.workItemId, taskSessionId: conclusion.taskSessionId, taskTurnId: conclusion.taskTurnId }])} /> :
              <article className="actor-timeline-task" data-event-type={entry.event.type} data-work-item-id={entry.event.workItemId}>
                <strong>{({ "task.started": "Task started", "task.turn_completed": "Task turn ended", "task.failed": "Task failed", "task.needs_user": "Task needs your input", "sh.completed": "Replies completed" })[entry.event.type]}</strong>
                <span>{entry.event.actorIds.map(actorName).join(", ")}</span>
                <p>{entry.event.roundId ? splitActorPromptPageContext(room.rounds.find(round => round.id === entry.event.roundId)?.userPrompt ?? "").text.slice(0, 180) : entry.event.workItemId}</p>
                {entry.event.type === "task.turn_completed" && <small>Review is separate from task completion.</small>}
                {entry.event.taskSessionId && <button type="button" className="secondary" onClick={() => onOpenSession(entry.event.taskSessionId!)}>Open task</button>}
              </article>}
          </div>)}
          {pendingMessages}
        </div>}
        {!actor && groupChatEntries(rounds, roundtables.links).map(entry => entry.kind === "round" ? renderRound(entry.round)
          : <ActorRoundtableCard key={`roundtable:${entry.link.requestId}`} link={entry.link} onOpen={onOpenSession} />)}
        {!actor && pendingMessages}
        {!actor && roundtables.receipts.map(receipt => <ActorRoundtableReceiptCard key={`roundtable-receipt:${receipt.requestId}`} receipt={receipt}
          sending={roundtables.sending.includes(receipt.requestId)} onDiscard={() => roundtables.discard(receipt.requestId)}
          onRetry={() => void roundtables.retry(receipt).then(view => { if (view?.sessionId.trim() && mounted.current) onOpenSession(view.sessionId); })} />)}
        {!actor && roundtables.error && <p role="alert" className="actor-room-error">Round tables: {roundtables.error}</p>}
        {room && <ActorMemoryNotices workspaceId={workspaceId} room={room} actorId={actor?.id} actorName={actorName} onRoom={(roomState ?? ownRoom).setRoom} />}
      </div>
    </div>
    <form className="composer side-chat-composer actor-room-composer" aria-label="Message actors" onSubmit={event => void send(event)} onKeyDown={event => {
      if (!actor && event.key === "Escape") event.preventDefault();
    }}>
      {requestError && <p role="alert" className="actor-room-error">{requestError}</p>}
      {actor && stopHint && <p role="status" className="side-chat-state">{stopHint}</p>}
      {authRequired && <p className="actor-room-error"><a href="/">Sign in to Threadex</a> to continue. Your pending request can be retried after signing in.</p>}
      <ComposerFrame>
        <ComposerGearSelector idPrefix="actor-room-gear" label="Actor response model gears" gears={gearProfiles} activeGearIndex={activeGearIndex}
          modelOptions={MODEL_OPTIONS} effortOptions={EFFORT_OPTIONS} ultraEffortOptions={ULTRA_EFFORT_OPTIONS} supportsUltraEffort={supportsUltraEffort}
          modelOptionLabel={modelLabel} effortOptionLabel={value => value} onActivateGear={setActiveGearIndex}
          onModelChange={(index, model) => updateGear(index, { model })} onEffortChange={(index, effort) => updateGear(index, { effort })}
          />
        <ComposerSurface onDropFiles={files.add}>
        {replyContext && <div className="composer-response-quote actor-reply-context" aria-label={`Reply to ${replyContext.actorName}`}>
          <span className="composer-response-quote-icon" aria-hidden="true"><Quote /></span>
          <div><strong>Reply to {replyContext.actorName}</strong><span>{replyContext.text}</span>
            {replyContext.tasks.map(task => <small key={task.id}>Task · {task.taskSessionId || task.id}</small>)}</div>
          <button type="button" title="Cancel reply" aria-label="Cancel reply" onClick={() => setReplyContext(null)}><X aria-hidden="true" /></button>
        </div>}
        {roundtableMode && <ActorRoundtableComposerPanel draft={roundtableDraft} />}
        {quotes.map((quote, index) => <div className="composer-response-quote" aria-label="Quoted response" key={index}>
          <span className="composer-response-quote-icon" aria-hidden="true"><Quote /></span>
          <div><strong>Quoted response</strong><span>{quote.text}</span></div>
          <button type="button" title="Remove quote" aria-label="Remove quote" onClick={() => setQuotes(quotesRef.current.filter((_, item) => item !== index))}><X aria-hidden="true" /></button>
        </div>)}
        <input ref={fileInputRef} type="file" multiple hidden aria-label="Attach files to actor message" onChange={event => { if (event.currentTarget.files) void files.add(event.currentTarget.files); event.currentTarget.value = ""; }} />
        {!!files.attachments.length && <AttachmentList attachments={files.attachments} onRemove={files.remove} />}
        {files.error && <p role="alert" className="actor-room-error">{files.error}</p>}
        {files.reading && <p role="status" className="side-chat-state">Preparing attachments…</p>}
        {suggestions.error && <p role="status" className="actor-room-suggestion-error">{suggestions.error}</p>}
        {!mention && suggestions.trigger && (suggestions.trigger.slash || suggestions.suggestions.length > 0) && <ComposerSuggestionMenu
          suggestions={suggestions.suggestions} activeIndex={suggestions.index} onSelect={selectSuggestion} loading={suggestions.loading} />}
        {mention && <div id="actor-room-mentions" className="slash-suggestions actor-room-mentions" role="listbox" aria-label="Mention an actor">
          {mentionOptions.map((actor, index) => <button type="button" role="option" id={`actor-mention-${actor.id}`} key={actor.id} aria-selected={index === mentionIndex} data-active={index === mentionIndex} onMouseDown={event => event.preventDefault()} onClick={() => selectMention(actor)}>
            <DomainActorIdentity actor={actor} detail={`@${actor.name}${actor.parentActorId ? ` · Sub-actor of ${actorName(actor.parentActorId)}` : actor.memory.roleSummary ? ` · ${actor.memory.roleSummary}` : ""}`} />
          </button>)}
          {!mentionOptions.length && <span className="slash-suggestions-empty">No matching actors</span>}
        </div>}
        <InlineLinkComposer ref={composerRef} value={prompt} links={NO_LINKS}
          ariaLabel="Message actors" ariaControls={mention ? "actor-room-mentions" : undefined}
          ariaActiveDescendant={mention && mentionOptions.length ? `actor-mention-${mentionOptions[mentionIndex].id}` : undefined}
          placeholder={actor ? `Message ${actor.name} privately…` : roundtableMode ? "Topic for the round table…" : "Message actors… @ to choose a name"} onChange={changePrompt} onKeyDown={handleKeyDown}
          onBlur={() => { setMention(null); suggestions.dismiss(); }} onPasteLink={() => null} onRemoveLink={() => {}} onOpenLink={() => {}} onUnhandledPaste={event => { const pasted = attachmentFilesFromPaste(event.clipboardData, files.attachments.map(file => file.name)); if (pasted) { event.preventDefault(); void files.add(pasted); } }} />
        <ComposerToolbar><button type="button" className="composer-icon" aria-label="Attach files" title="Attach files" onClick={() => fileInputRef.current?.click()}><Paperclip aria-hidden="true" /></button>{!actor && <button type="button" className="composer-icon composer-roundtable" aria-label="Round table mode"
          aria-pressed={roundtableDraft.enabled} data-active={roundtableDraft.enabled ? "true" : undefined}
          title={roundtableDraft.enabled ? "Round table is on for the next prompt only; it opens in a new session" : "Discuss the next prompt at a round table in a new session (one time)"}
          onClick={() => { void roundtableDraft.toggle(); composerRef.current?.focus(); }}>
          <Users aria-hidden="true" />{roundtableDraft.enabled && <span><span className="roundtable-toggle-label">Next prompt only</span><span className="roundtable-toggle-count" aria-hidden="true">1×</span></span>}
        </button>}<span className="composer-fill" /><button type="button" className="composer-icon" aria-label="Clear" title="Clear" disabled={!prompt && !quotes.length && !replyContext && !files.attachments.length && !files.reading} onClick={() => { setPrompt(""); setQuotes([]); setReplyContext(null); files.clear(); setMention(null); suggestions.dismiss(); }}><X aria-hidden="true" /></button>{actor && stoppable.length > 0 && <button type="button" className="send-button stop-button actor-room-stop" aria-label="Stop" title={disableEscapeStop ? "Stop" : "Stop (Esc twice)"} disabled={stopping} onMouseDown={event => event.preventDefault()} onClick={() => void stopWork()}>{stopping ? <Loader2 className="spin" aria-hidden="true" /> : <Square aria-hidden="true" />}<span>{stopping ? "Stopping…" : "Stop"}</span></button>}<button type="submit" className="send-button" aria-label="Send" onMouseDown={event => event.preventDefault()} disabled={roundtableMode ? (!prompt.trim() && !quotes.length && !replyContext) || files.reading || blocked
            : !room || !chatActors.length || (!prompt.trim() && !quotes.length && !files.attachments.length) || files.reading || blocked}><Send aria-hidden="true" /></button></ComposerToolbar>
      </ComposerSurface></ComposerFrame>
      {blocked && <div className="actor-room-mention-preview" aria-live="polite">{roundtableMode ? files.attachments.length ? "Round tables in a new session cannot take attachments yet. Remove them or turn off Round table." : "Choose at least 2 actors for the round table." : replyTargetUnavailable ? "This actor is no longer available. Cancel the reply to choose another recipient." : "Address up to 8 actors per message."}</div>}
    </form>
    {selectionQuote && <ResponseQuotePopover quote={selectionQuote} onChange={setSelectionQuote} onAsk={() => quoteSelection(selectionQuote)} />}
    {editor && <div className="modal-backdrop actor-room-editor"><form ref={editorRef} role="dialog" aria-modal="true" aria-label={editor.actor ? `Edit ${editor.actor.name} memory` : "Create domain actor"} onKeyDown={event => {
      if (event.key === "Escape" && !saving) { event.preventDefault(); setEditor(null); }
      if (event.key === "Tab") {
        const nodes = editorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]');
        if (!nodes?.length) return;
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
      }
    }} onSubmit={event => void saveActor(event)}><header><h2>{editor.actor ? `${editor.actor.name} · Memory v${editor.version}` : "Create domain actor"}</h2><button type="button" disabled={saving} onClick={() => setEditor(null)} aria-label="Close memory editor"><X aria-hidden="true" /></button></header>{!editor.actor && <><label>Name<input required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>Parent<select value={draft.parentActorId ?? ""} onChange={event => setDraft({ ...draft, parentActorId: event.target.value || null })}><option value="">Root actor</option>{actors.filter(actor => !actor.parentActorId).map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</select></label><p>Choose Claude or GPT in the chat composer. Execution selects the workload tier for each request.</p><label>Effort<select value={draft.effort} onChange={event => setDraft({ ...draft, effort: event.target.value })}>{modelEfforts(draft.model).map(effort => <option key={effort}>{effort}</option>)}</select></label></>}{(Object.keys(memoryLabels) as Array<keyof ActorMemoryContent>).map(field => <label key={field}>{memoryLabels[field]}<textarea required={field === "rolePrompt" || field === "roleSummary"} rows={field === "roleSummary" ? 2 : 4} value={editor.memory[field]} onChange={event => setEditor({ ...editor, memory: { ...editor.memory, [field]: event.target.value } })} /></label>)}{editorError && <p role="alert">{editorError}</p>}{authRequired && <a href="/">Sign in to Threadex</a>}{conflict && <button type="button" onClick={() => { const latest = actors.find(actor => actor.id === editor.actor?.id); if (latest) openEditor(latest); }}>Replace draft with latest memory</button>}<button type="submit" disabled={saving || conflict || (!editor.actor && (!draft.allowedModels?.length || !draft.allowedModels.includes(draft.model)))}>{saving ? "Saving…" : editor.actor ? "Save memory" : "Create actor"}</button></form></div>}
  </>;
}
