import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  EllipsisVertical,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  ShieldAlert,
  ShieldCheck,
  X
} from "lucide-react";

export type TodoPlanItemStatus = "todo" | "active" | "paused" | "hold" | "skipped" | "done" | "blocked";

export type TodoPlanMessage = {
  id: string;
  type: "update" | "challenge" | "blocker";
  title: string;
  body?: string;
  resolved?: boolean;
  challengeId?: string | number | null;
};

export type TodoPlanComment = {
  id: string;
  type: "status" | "blocker" | "note";
  body: string;
};

export type TodoPlanSession = {
  id: string;
  title: string;
  status?: "idle" | "running" | "blocked" | "done";
};

export type TodoPlanItem = {
  id: string;
  title: string;
  status: TodoPlanItemStatus;
  details?: string;
  context?: string;
  activeStatus?: string | null;
  lockReason?: string | null;
  changedFileCount?: number;
  taskStatus?: string;
  selected?: boolean;
  sessions?: TodoPlanSession[];
  messages?: TodoPlanMessage[];
  comments?: TodoPlanComment[];
  children?: TodoPlanItem[];
};

export type TodoPlanSection = {
  id: string;
  label?: string;
  items: TodoPlanItem[];
};

type EditPatch = {
  title: string;
  details: string;
  context: string;
};

type TodoPlanPanelProps = {
  className?: string;
  showItemContext?: boolean;
  sections: TodoPlanSection[];
  itemCount: number;
  paused: boolean;
  pauseReason?: string | null;
  problem?: string | null;
  objective?: string | null;
  collapseKey?: number | string;
  agentEvents?: TodoPlanMessage[];
  agentEmptyLabel?: string;
  onTogglePause?: () => void;
  onSelectItem?: (itemId: string) => void;
  onEditItem?: (itemId: string, patch: EditPatch) => void | Promise<void>;
  onCreateItem?: (parentId: string) => void | Promise<void>;
  onUpdateStatus?: (itemId: string, status: "hold" | "skipped" | "done") => void | Promise<void>;
  onComment?: (itemId: string, type: "note" | "blocker", body?: string) => void | Promise<void>;
  onResolveChallenge?: (challengeId: string | number) => void | Promise<void>;
  onOpenSession?: (sessionId: string) => void;
};

function statusIcon(status: TodoPlanItemStatus) {
  if (status === "active") return <Loader2 className="spin" aria-hidden="true" />;
  if (status === "done") return <CheckCircle2 aria-hidden="true" />;
  if (status === "blocked") return <ShieldAlert aria-hidden="true" />;
  if (status === "skipped") return <ArrowDown aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

function messageDisplayType(message: TodoPlanMessage) {
  if (message.type === "update" && /^solution applied/i.test(message.title)) return "challenge";
  if (message.type === "update" && /^(workaround applied|blocker)/i.test(message.title)) return "blocker";
  return message.type;
}

function messageIsRecovery(message: TodoPlanMessage) {
  return /^(solution|workaround) applied/i.test(message.title);
}

function messageIsProblem(message: TodoPlanMessage) {
  const type = messageDisplayType(message);
  return !messageIsRecovery(message) && (type === "challenge" || type === "blocker");
}

function messageLabelAndText(message: TodoPlanMessage) {
  const patterns: Array<[RegExp, string]> = [
    [/^solution applied\s*·\s*/i, "Solution"],
    [/^workaround applied\s*·\s*/i, "Workaround"],
    [/^challenge reported\s*·\s*/i, "Challenge"],
    [/^blocker\s*·\s*/i, "Blocker"]
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(message.title)) return { label, text: message.title.replace(pattern, "") };
  }
  return { label: messageDisplayType(message) === "blocker" ? "Blocker" : "Challenge", text: message.title };
}

function pathToItem(items: TodoPlanItem[], targetId: string): string[] {
  for (const item of items) {
    if (item.id === targetId) return [item.id];
    const childPath = pathToItem(item.children ?? [], targetId);
    if (childPath.length > 0) return [item.id, ...childPath];
  }
  return [];
}

function flattenItems(items: TodoPlanItem[]): TodoPlanItem[] {
  return items.flatMap((item) => [item, ...flattenItems(item.children ?? [])]);
}

export function TodoPlanPanel({
  className,
  showItemContext = true,
  sections,
  itemCount,
  paused,
  pauseReason,
  problem,
  objective,
  collapseKey,
  agentEvents = [],
  agentEmptyLabel = "No agent activity yet.",
  onTogglePause,
  onSelectItem,
  onEditItem,
  onCreateItem,
  onUpdateStatus,
  onComment,
  onResolveChallenge,
  onOpenSession
}: TodoPlanPanelProps) {
  const [view, setView] = useState<"todo" | "agent">("todo");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => new Set());
  const [editingItem, setEditingItem] = useState<(EditPatch & { id: string }) | null>(null);
  const [selectionComment, setSelectionComment] = useState<{ itemId: string; selectedText: string; body: string; top: number; left: number } | null>(null);
  const allItems = useMemo(() => flattenItems(sections.flatMap((section) => section.items)), [sections]);
  const activeItem = allItems.find((item) => item.status === "active") ?? allItems.find((item) => item.status === "blocked") ?? null;
  const activePath = useMemo(() => activeItem ? pathToItem(sections.flatMap((section) => section.items), activeItem.id) : [], [activeItem, sections]);
  const hasPlanSummary = Boolean(problem || objective);

  useEffect(() => {
    setExpandedItemIds(new Set());
  }, [collapseKey]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeFromDocument = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".todo-item-menu")?.getAttribute("data-menu-id") === openMenuId) return;
      setOpenMenuId(null);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("pointerdown", closeFromDocument);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromDocument);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!selectionComment) return;
    const closeFromDocument = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".todo-selection-comment-popover")) setSelectionComment(null);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectionComment(null);
    };
    document.addEventListener("pointerdown", closeFromDocument);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromDocument);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [selectionComment]);

  const toggleExpanded = (itemId: string) => {
    setExpandedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const captureSelectionComment = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selection || !selectedText || selection.rangeCount === 0 || !onComment) return;
      const anchor = selection.anchorNode;
      const element = anchor instanceof Element ? anchor : anchor?.parentElement;
      if (!element || element.closest(".todo-item-menu, .todo-edit-popover, .todo-selection-comment-popover")) return;
      const itemElement = element.closest(".todo-item") as HTMLElement | null;
      const itemId = itemElement?.dataset.itemId;
      if (!itemId) return;
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      setOpenMenuId(null);
      setSelectionComment({
        itemId,
        selectedText: selectedText.slice(0, 240),
        body: "",
        top: Math.min(window.innerHeight - 120, rect.bottom + 8),
        left: Math.min(window.innerWidth - 292, Math.max(8, rect.left))
      });
    }, 0);
  };

  const submitSelectionComment = (event: FormEvent) => {
    event.preventDefault();
    if (!selectionComment || !onComment) return;
    const body = selectionComment.body.trim();
    const quoted = `Selected: "${selectionComment.selectedText}"`;
    void onComment(selectionComment.itemId, "note", body ? `${quoted}\n${body}` : quoted);
    window.getSelection()?.removeAllRanges();
    setSelectionComment(null);
  };

  const renderMessage = (message: TodoPlanMessage, compact = false, collapsedCount = 0) => {
    const type = messageDisplayType(message);
    const labelled = type === "challenge" || type === "blocker";
    const labelLine = labelled ? messageLabelAndText(message) : null;
    const unresolvedChallenge = message.type === "challenge" && !message.resolved;
    return (
      <div className="todo-message" data-type={type} data-resolved={message.resolved} key={message.id}>
        {collapsedCount > 0 && <span className="todo-message-count">({collapsedCount})</span>}
        {labelLine ? (
          <span className="todo-message-line"><span className="todo-message-label">{labelLine.label}</span><span>{labelLine.text}</span></span>
        ) : <strong>{message.title}</strong>}
        {!compact && message.body && <span className="todo-message-body">{message.body}</span>}
        {!compact && unresolvedChallenge && message.challengeId !== null && message.challengeId !== undefined && onResolveChallenge && (
          <button type="button" onClick={() => void onResolveChallenge(message.challengeId!)}>Resolve</button>
        )}
      </div>
    );
  };

  const renderSummaryMessages = (messages: TodoPlanMessage[], collapsedCount: number) => {
    if (messages.length !== 2) return messages.map((message, index) => renderMessage(message, true, index === 0 ? collapsedCount : 0));
    const type = messages.some((message) => messageDisplayType(message) === "blocker") ? "blocker" : "challenge";
    return (
      <div className="todo-message" data-type={type} data-resolved={messages.every((message) => message.resolved !== false)}>
        <span className="todo-message-count">({collapsedCount})</span>
        <span className="todo-message-lines">{messages.map((message) => {
          const line = messageLabelAndText(message);
          return <span className="todo-message-line" key={message.id}><span className="todo-message-label">{line.label}</span><span>{line.text}</span></span>;
        })}</span>
      </div>
    );
  };

  const renderSession = (session: TodoPlanSession, compact = false) => (
    <button
      className="todo-session-trigger"
      type="button"
      data-status={session.status ?? "idle"}
      onClick={(event) => {
        event.stopPropagation();
        onOpenSession?.(session.id);
      }}
      title={`Open subtask ${session.id}`}
    >
      <span className="session-status-indicator" data-status={session.status ?? "idle"} aria-hidden="true">
        {session.status === "running" ? <Loader2 className="spin" /> : <Circle />}
      </span>
      <span>{compact ? "Subtask" : session.title || session.id}</span>
      <small>{session.status ?? "idle"}</small>
    </button>
  );

  const renderItem = (item: TodoPlanItem, depth: number, isOnlyRoot: boolean): ReactNode => {
    const children = item.children ?? [];
    const hasChildren = children.length > 0;
    const isCollapsible = hasChildren && !isOnlyRoot;
    const isExpanded = isOnlyRoot || expandedItemIds.has(item.id);
    const activePathIndex = activePath.indexOf(item.id);
    const activeChildId = activePathIndex >= 0 ? activePath[activePathIndex + 1] : undefined;
    const activeChild = activeChildId ? children.find((child) => child.id === activeChildId) : undefined;
    const visibleChildren = hasChildren ? isExpanded ? children : activeChild ? [activeChild] : [] : [];
    const collapsedChildCount = isCollapsible && !isExpanded ? Math.max(0, children.length - (activeChild ? 1 : 0)) : 0;
    const messages = item.messages ?? [];
    const highlightedMessage = [...messages].reverse().find(messageIsProblem);
    const recoveryMessage = [...messages].reverse().find(messageIsRecovery);
    const fallbackMessage = item.activeStatus || item.lockReason ? {
      id: `status:${item.id}`,
      type: item.status === "blocked" ? "blocker" as const : "update" as const,
      resolved: item.status !== "blocked",
      title: item.lockReason ?? item.activeStatus ?? ""
    } : null;
    const latestMessage = messages.at(-1) ?? fallbackMessage;
    const summaryMessages = messages.at(-1) && messageIsRecovery(messages.at(-1)!) && highlightedMessage && recoveryMessage && recoveryMessage.id !== highlightedMessage.id
      ? [highlightedMessage, recoveryMessage]
      : latestMessage ? [latestMessage] : [];
    const messageHistory = messages.length > 0 ? messages : latestMessage ? [latestMessage] : [];
    const sessions = item.sessions ?? [];
    const primarySession = sessions.at(-1);
    const terminal = item.status === "done" || item.status === "skipped";

    return (
      <li
        className="todo-item"
        data-item-id={item.id}
        data-status={item.status}
        data-selected={item.selected}
        key={item.id}
        onClick={() => onSelectItem?.(item.id)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (onEditItem) setEditingItem({ id: item.id, title: item.title, details: item.details ?? "", context: item.context ?? "" });
        }}
      >
        <div className="todo-item-main">
          {isCollapsible ? (
            <button
              className="todo-expand-toggle"
              type="button"
              data-expanded={isExpanded}
              data-active-path={!isExpanded && Boolean(activeChild)}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(item.id);
              }}
            >
              {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              {collapsedChildCount > 0 && <span className="todo-child-count">{collapsedChildCount}</span>}
            </button>
          ) : <span className="todo-expand-spacer" aria-hidden="true" />}
          <span className="todo-status-dot" data-task-status={item.taskStatus ?? item.status} aria-hidden="true">{statusIcon(item.status)}</span>
          <details className="todo-item-menu" data-menu-id={item.id} open={openMenuId === item.id} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <summary
              title="Todo item actions"
              aria-label="Open todo item actions"
              aria-expanded={openMenuId === item.id}
              onClick={(event) => {
                event.preventDefault();
                setOpenMenuId((current) => current === item.id ? null : item.id);
              }}
            ><EllipsisVertical aria-hidden="true" /></summary>
            <div className="todo-item-menu-popover">
              {onEditItem && <button type="button" onClick={() => { setOpenMenuId(null); setEditingItem({ id: item.id, title: item.title, details: item.details ?? "", context: item.context ?? "" }); }}><Pencil aria-hidden="true" />Edit</button>}
              {onCreateItem && <button type="button" onClick={() => { setOpenMenuId(null); void onCreateItem(item.id); }}><Plus aria-hidden="true" />Add child</button>}
              {onComment && <button type="button" onClick={() => { setOpenMenuId(null); void onComment(item.id, "note"); }}><MessageSquare aria-hidden="true" />Comment</button>}
              {onComment && <button type="button" onClick={() => { setOpenMenuId(null); void onComment(item.id, "blocker"); }}><ShieldCheck aria-hidden="true" />Blocker</button>}
              {!terminal && onUpdateStatus && <button type="button" onClick={() => { setOpenMenuId(null); void onUpdateStatus(item.id, "hold"); }}><Clock3 aria-hidden="true" />Hold</button>}
              {!terminal && onUpdateStatus && <button type="button" onClick={() => { setOpenMenuId(null); void onUpdateStatus(item.id, "skipped"); }}><ArrowDown aria-hidden="true" />Skip</button>}
              {item.status !== "done" && onUpdateStatus && <button type="button" onClick={() => { setOpenMenuId(null); void onUpdateStatus(item.id, "done"); }}><CheckCircle2 aria-hidden="true" />Done</button>}
            </div>
          </details>
          <div className="todo-item-copy">
            {primarySession && onOpenSession ? (
              <button className="todo-item-title-button" type="button" onClick={(event) => { event.stopPropagation(); onOpenSession(primarySession.id); }} onDoubleClick={(event) => event.stopPropagation()} title={`Open subtask ${primarySession.id}`}>{item.title}</button>
            ) : <strong>{item.title}</strong>}
            {item.details && <small>{item.details}</small>}
            {item.activeStatus && <span className="todo-active-status">{item.activeStatus}</span>}
            {item.lockReason && <span className="todo-lock-reason">{item.lockReason}</span>}
          </div>
          <span className="todo-status-label">{item.status}</span>
          {(item.changedFileCount ?? 0) > 0 && <span className="todo-file-count">{item.changedFileCount} {item.changedFileCount === 1 ? "file" : "files"}</span>}
        </div>
        {showItemContext && item.context && <details className="todo-context"><summary>Context</summary><pre>{item.context}</pre></details>}
        {primarySession && <div className="todo-session-inline">{renderSession(primarySession, true)}</div>}
        {sessions.length > 1 && <details className="todo-session-history"><summary>{sessions.length} subtasks</summary><div className="todo-session-list">{sessions.map((session) => <span key={session.id}>{renderSession(session)}</span>)}</div></details>}
        {summaryMessages.length > 0 && (
          messageHistory.length > 1 ? <details className="todo-message-history"><summary>{renderSummaryMessages(summaryMessages, messageHistory.length)}</summary><div className="todo-message-list">{messageHistory.map((message) => renderMessage(message))}</div></details>
            : <div className="todo-item-message">{renderSummaryMessages(summaryMessages, 0)}</div>
        )}
        {(item.comments?.length ?? 0) > 0 && <div className="todo-comments">{item.comments!.map((comment) => <div className="todo-comment" data-type={comment.type} key={comment.id}>{comment.type}: {comment.body}</div>)}</div>}
        {visibleChildren.length > 0 && <ul className="todo-item-list" data-depth={depth + 1}>{visibleChildren.map((child) => renderItem(child, depth + 1, false))}</ul>}
      </li>
    );
  };

  return (
    <section className={["todo-panel-shell", className].filter(Boolean).join(" ")} data-view={view} aria-label="Todo plan and agent">
      <div className="todo-view-tabs" role="tablist" aria-label="Todo plan and agent views">
        <button type="button" role="tab" aria-selected={view === "todo"} data-active={view === "todo"} onClick={() => setView("todo")}>Todo plan</button>
        <button type="button" role="tab" aria-selected={view === "agent"} data-active={view === "agent"} onClick={() => setView("agent")}>Agent</button>
      </div>
      <div className="todo-panel-content">
        {view === "todo" ? (
          <section className="todo-panel" aria-label="Todo plan" onMouseUp={captureSelectionComment} onKeyUp={captureSelectionComment}>
            <div className="todo-panel-header">
              <div><span className="todo-panel-title">Todo plan</span><small>{itemCount} item{itemCount === 1 ? "" : "s"}</small></div>
              {onTogglePause && <div className="todo-panel-actions"><button type="button" onClick={onTogglePause}>{paused ? <Play aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{paused ? "Resume" : "Pause"}</button></div>}
            </div>
            {paused && <div className="todo-control-note">Paused: {pauseReason || "No reason provided"}</div>}
            {hasPlanSummary && <div className="todo-plan-background"><section><span>Problem</span><p>{problem || "Not recorded."}</p></section><section><span>Objective</span><p>{objective || "Not recorded."}</p></section></div>}
            {sections.every((section) => section.items.length === 0) ? <div className="todo-empty">No todo plan yet.</div> : sections.map((section) => (
              <section className="todo-plan-section" key={section.id}>
                {section.label && <h3>{section.label}</h3>}
                <ul className="todo-item-list" data-depth="0">{section.items.map((item) => renderItem(item, 0, section.items.length === 1))}</ul>
              </section>
            ))}
          </section>
        ) : (
          <section className="todo-panel" aria-label="Agent activity">
            <div className="todo-panel-header"><div><span className="todo-panel-title">Agent</span><small>Task hand-offs and updates</small></div><Bot aria-hidden="true" /></div>
            <div className="harness-todo-agent-view">{agentEvents.length > 0 ? agentEvents.slice(-16).reverse().map((event) => renderMessage(event)) : <div className="todo-empty">{agentEmptyLabel}</div>}</div>
          </section>
        )}
      </div>
      {editingItem && (
        <div className="todo-edit-backdrop" role="presentation" onMouseDown={() => setEditingItem(null)}>
          <form className="todo-edit-popover" onSubmit={(event) => {
            event.preventDefault();
            if (!editingItem.title.trim() || !onEditItem) return;
            void onEditItem(editingItem.id, { title: editingItem.title.trim(), details: editingItem.details, context: editingItem.context });
            setEditingItem(null);
          }} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setEditingItem(null); }}>
            <div className="todo-edit-popover-header"><strong>Edit todo item</strong><button type="button" onClick={() => setEditingItem(null)} title="Close edit popup" aria-label="Close edit popup"><X aria-hidden="true" /></button></div>
            <label><span>Title</span><input value={editingItem.title} onChange={(event) => setEditingItem((current) => current ? { ...current, title: event.target.value } : current)} placeholder="Todo title" autoFocus /></label>
            <label><span>Details</span><textarea value={editingItem.details} onChange={(event) => setEditingItem((current) => current ? { ...current, details: event.target.value } : current)} placeholder="Details" rows={3} /></label>
            {showItemContext && <label><span>Context</span><textarea value={editingItem.context} onChange={(event) => setEditingItem((current) => current ? { ...current, context: event.target.value } : current)} placeholder="Context" rows={3} /></label>}
            <div className="todo-edit-popover-actions"><button type="button" onClick={() => setEditingItem(null)}>Cancel</button><button type="submit">Save</button></div>
          </form>
        </div>
      )}
      {selectionComment && (
        <form className="todo-selection-comment-popover" style={{ left: selectionComment.left, top: selectionComment.top }} onSubmit={submitSelectionComment} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSelectionComment(null); }}>
          <span>Comment on selection</span>
          <blockquote>{selectionComment.selectedText}</blockquote>
          <textarea value={selectionComment.body} onChange={(event) => setSelectionComment((current) => current ? { ...current, body: event.target.value } : current)} placeholder="Add comment" rows={2} autoFocus />
          <div><button type="button" onClick={() => setSelectionComment(null)}>Cancel</button><button type="submit">Save</button></div>
        </form>
      )}
    </section>
  );
}
