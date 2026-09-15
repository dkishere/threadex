import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  EllipsisVertical,
  FileCode2,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  Play,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Square,
  TerminalSquare,
  X
} from "lucide-react";
import { TodoPlanPanel } from "./TodoPlanPanel";
import type { TodoPlanItem, TodoPlanMessage } from "./TodoPlanPanel";

import {
  MOCK_PLAN,
  PLAYBACK_PHASES,
  ROOT_ID,
  type HarnessEvent,
  type MockFile,
  type MockTask,
  type TaskState,
  type TaskStatus,
} from "./mcpPlanHarnessModel";

function flattenTasks(task: MockTask): MockTask[] {
  return [task, ...(task.children ?? []).flatMap(flattenTasks)];
}

function initialTaskStates(tasks: MockTask[]) {
  return Object.fromEntries(tasks.map((task) => [task.id, {
    status: "queued" as TaskStatus,
    detail: "waiting for parent task",
    progress: 0,
    updatedAt: Date.now()
  }]));
}

function statusLabel(status: TaskStatus) {
  return status === "writing" ? "Writing" : status.charAt(0).toUpperCase() + status.slice(1);
}

function taskStatusIcon(status: TaskStatus) {
  if (status === "completed") return <Check aria-hidden="true" />;
  if (status === "running" || status === "writing") return <Loader2 className="spin" aria-hidden="true" />;
  if (status === "blocked") return <ShieldAlert aria-hidden="true" />;
  if (status === "waiting") return <Clock3 aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function TaskTree({
  task,
  depth,
  taskStates,
  activeTaskId,
  expanded,
  onToggle,
  onSelect,
  onSpawn
}: {
  task: MockTask;
  depth: number;
  taskStates: Record<string, TaskState>;
  activeTaskId: string | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onSpawn: (id: string) => void;
}) {
  const state = taskStates[task.id];
  const hasChildren = (task.children?.length ?? 0) > 0;
  const isExpanded = expanded.has(task.id);
  return (
    <div className="harness-tree-node">
      <div
        className="harness-task-row"
        data-active={activeTaskId === task.id}
        data-status={state?.status ?? "queued"}
        style={{ paddingLeft: `${12 + depth * 17}px` }}
        onClick={() => onSelect(task.id)}
      >
        {hasChildren ? (
          <button className="harness-tree-toggle" type="button" onClick={(event) => { event.stopPropagation(); onToggle(task.id); }} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${task.title}`}>
            {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        ) : <span className="harness-tree-spacer" />}
        <span className="harness-task-status" data-status={state?.status ?? "queued"}>{taskStatusIcon(state?.status ?? "queued")}</span>
        <span className="harness-task-copy">
          <strong>{task.title}</strong>
          <small>{task.kind === "sub-agent" ? "spawned sub-agent" : task.tool}</small>
        </span>
        <span className="harness-task-percent">{state?.progress ?? 0}%</span>
        <button className="harness-row-spawn" type="button" onClick={(event) => { event.stopPropagation(); onSpawn(task.id); }} title="Spawn sub-agent" aria-label={`Spawn sub-agent under ${task.title}`}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      {hasChildren && isExpanded && task.children?.map((child) => (
        <TaskTree key={child.id} task={child} depth={depth + 1} taskStates={taskStates} activeTaskId={activeTaskId} expanded={expanded} onToggle={onToggle} onSelect={onSelect} onSpawn={onSpawn} />
      ))}
    </div>
  );
}

type HarnessTodoPanelProps = {
  root: MockTask;
  taskMap: Map<string, MockTask>;
  taskStates: Record<string, TaskState>;
  events: HarnessEvent[];
  selectedTaskId: string;
  activeTaskId: string | null;
  collapseVersion: number;
  paused: boolean;
  context: string;
  onSelect: (id: string) => void;
  onSpawn: (id: string) => void;
  onTogglePause: () => void;
  onContext: () => void;
  onComment: (id: string, type: "note" | "blocker", body?: string) => void;
  onUpdate: (id: string, status: "hold" | "skipped" | "done") => void;
  onResolveChallenge: (id: string) => void;
};

function todoStatusFor(state: TaskState | undefined): "todo" | "active" | "hold" | "blocked" | "done" {
  if (!state) return "todo";
  if (state.status === "completed") return "done";
  if (state.status === "blocked") return "blocked";
  if (state.status === "waiting") return "hold";
  if (state.status === "running" || state.status === "writing") return "active";
  return "todo";
}

function todoStatusIconFor(state: TaskState | undefined) {
  if (!state) return <Clock3 aria-hidden="true" />;
  if (state.status === "completed") return <CheckCircle2 aria-hidden="true" />;
  if (state.status === "blocked") return <ShieldAlert aria-hidden="true" />;
  if (state.status === "waiting") return <Clock3 aria-hidden="true" />;
  if (state.status === "running" || state.status === "writing") return <Loader2 className="spin" aria-hidden="true" />;
  return <Clock3 aria-hidden="true" />;
}

function taskPathTo(root: MockTask, targetId: string): string[] {
  if (root.id === targetId) return [root.id];
  for (const child of root.children ?? []) {
    const childPath = taskPathTo(child, targetId);
    if (childPath.length > 0) return [root.id, ...childPath];
  }
  return [];
}

function LegacyHarnessTodoPanel({
  root,
  taskMap,
  taskStates,
  events,
  selectedTaskId,
  activeTaskId,
  collapseVersion,
  paused,
  context,
  onSelect,
  onSpawn,
  onTogglePause,
  onContext,
  onComment,
  onUpdate,
  onResolveChallenge
}: HarnessTodoPanelProps) {
  const [view, setView] = useState<"todo" | "agent">("todo");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
  const [editingTask, setEditingTask] = useState<{ id: string; title: string; details: string; context: string } | null>(null);
  const [selectionComment, setSelectionComment] = useState<{ itemId: string; selectedText: string; body: string; top: number; left: number } | null>(null);
  const [taskEdits, setTaskEdits] = useState<Record<string, { title: string; details: string; context: string }>>({});
  const activePath = useMemo(() => activeTaskId ? taskPathTo(root, activeTaskId) : [], [activeTaskId, root]);

  useEffect(() => {
    setExpandedTaskIds(new Set());
  }, [collapseVersion]);

  useEffect(() => {
    if (!openMenuId) return;
    const closeFromDocument = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const menu = target?.closest(".todo-item-menu") as HTMLElement | null;
      if (menu?.dataset.menuId === openMenuId) return;
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
      if (target?.closest(".todo-selection-comment-popover")) return;
      setSelectionComment(null);
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

  const taskEvents = (taskId: string) => events.filter((event) => event.taskId === taskId);
  const runMenuAction = (action: () => void) => {
    setOpenMenuId(null);
    action();
  };
  const startInlineEdit = (task: MockTask) => {
    const edit = taskEdits[task.id];
    setOpenMenuId(null);
    setEditingTask({
      id: task.id,
      title: edit?.title ?? task.title,
      details: edit?.details ?? task.description,
      context: edit?.context ?? `tool: ${task.tool}\nvirtual file: ${task.filePath}`
    });
  };
  const updateInlineEdit = (patch: Partial<NonNullable<typeof editingTask>>) => {
    setEditingTask((current) => current ? { ...current, ...patch } : current);
  };
  const saveInlineEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editingTask?.title.trim()) return;
    setTaskEdits((current) => ({
      ...current,
      [editingTask.id]: {
        title: editingTask.title.trim(),
        details: editingTask.details,
        context: editingTask.context
      }
    }));
    const task = taskMap.get(editingTask.id);
    if (task) onComment(task.id, "note");
    setEditingTask(null);
  };
  const captureSelectionComment = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      if (!selection || !selectedText || selection.rangeCount === 0) return;
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
    if (!selectionComment) return;
    const body = selectionComment.body.trim();
    const selectedText = selectionComment.selectedText;
    onComment(selectionComment.itemId, "note", body ? `Selected: "${selectedText}"\n${body}` : `Selected: "${selectedText}"`);
    window.getSelection()?.removeAllRanges();
    setSelectionComment(null);
  };
  const toggleExpanded = (taskId: string) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  const eventDisplayType = (event: HarnessEvent) => {
    if (event.actor === "blocker" || event.message.startsWith("Workaround applied")) return "blocker";
    if (event.tone === "warning" || event.actor === "solution") return "challenge";
    return "update";
  };
  const eventIsRecovery = (event: HarnessEvent) => event.actor === "solution" || /^(Solution|Workaround) applied/i.test(event.message);
  const eventIsProblem = (event: HarnessEvent) => {
    const displayType = eventDisplayType(event);
    return !eventIsRecovery(event) && (displayType === "challenge" || displayType === "blocker");
  };
  const eventLabelAndText = (event: HarnessEvent) => {
    if (/^Solution applied\s*·\s*/i.test(event.message)) {
      return { label: "Solution", text: event.message.replace(/^Solution applied\s*·\s*/i, "") };
    }
    if (/^Workaround applied\s*·\s*/i.test(event.message)) {
      return { label: "Workaround", text: event.message.replace(/^Workaround applied\s*·\s*/i, "") };
    }
    if (/^Challenge reported\s*·\s*/i.test(event.message)) {
      return { label: "Challenge", text: event.message.replace(/^Challenge reported\s*·\s*/i, "") };
    }
    if (/^Blocker\s*·\s*/i.test(event.message)) {
      return { label: "Blocker", text: event.message.replace(/^Blocker\s*·\s*/i, "") };
    }
    const displayType = eventDisplayType(event);
    return { label: displayType === "blocker" ? "Blocker" : "Challenge", text: event.message };
  };
  const renderMessage = (task: MockTask, event: HarnessEvent, compact = false, collapsedCount = 0) => {
    const messages = taskEvents(task.id);
    const messageType = eventDisplayType(event);
    const isChallenge = messageType === "challenge" || messageType === "blocker";
    const resolved = isChallenge && (event.actor === "solution" || messages.some((message) => message.actor === "solution"));
    const labelLine = isChallenge ? eventLabelAndText(event) : null;
    return (
      <div className="todo-message" data-type={messageType} data-resolved={resolved} key={event.id}>
        {collapsedCount > 0 && <span className="todo-message-count">({collapsedCount})</span>}
        {labelLine ? (
          <span className="todo-message-line">
            <span className="todo-message-label">{labelLine.label}</span>
            <span>{labelLine.text}</span>
          </span>
        ) : <strong>{event.message}</strong>}
        {!compact && isChallenge && !resolved && <button type="button" onClick={(clickEvent) => { clickEvent.stopPropagation(); onResolveChallenge(task.id); }}>Resolve</button>}
      </div>
    );
  };
  const renderSummaryMessages = (messages: HarnessEvent[], collapsedCount: number) => {
    if (messages.length !== 2) {
      return messages.map((message, index) => renderMessage(taskMap.get(message.taskId) ?? root, message, true, index === 0 ? collapsedCount : 0));
    }
    const messageType = messages.some((message) => eventDisplayType(message) === "blocker") ? "blocker" : "challenge";
    return (
      <div className="todo-message" data-type={messageType} data-resolved={messages.some((message) => message.actor === "solution")}>
        <span className="todo-message-count">({collapsedCount})</span>
        <span className="todo-message-lines">
          {messages.map((message) => {
            const line = eventLabelAndText(message);
            return (
              <span className="todo-message-line" key={message.id}>
                <span className="todo-message-label">{line.label}</span>
                <span>{line.text}</span>
              </span>
            );
          })}
        </span>
      </div>
    );
  };
  const renderItem = (task: MockTask, depth = 0): ReactNode => {
    const state = taskStates[task.id];
    const status = todoStatusFor(state);
    const messages = taskEvents(task.id);
    const highlightedMessage = [...messages].reverse().find((message) => eventIsProblem(message));
    const recoveryMessage = [...messages].reverse().find((message) => eventIsRecovery(message));
    const fallbackMessage: HarnessEvent | undefined = state?.detail ? {
      id: `status:${task.id}`,
      taskId: task.id,
      taskTitle: task.title,
      actor: "status",
      message: state.detail,
      tone: status === "blocked" ? "warning" : "neutral",
      time: state.updatedAt
    } : undefined;
    const latestStoredMessage = messages.at(-1);
    const latestMessage = latestStoredMessage ?? fallbackMessage;
    const summaryMessages = latestStoredMessage && eventIsRecovery(latestStoredMessage) && highlightedMessage && recoveryMessage && recoveryMessage.id !== highlightedMessage.id
      ? [highlightedMessage, recoveryMessage]
      : latestMessage
        ? [latestMessage]
        : [];
    const messageHistory = messages.length > 0 ? messages : latestMessage ? [latestMessage] : [];
    const collapsedMessageCount = messageHistory.length;
    const edit = taskEdits[task.id];
    const displayTitle = edit?.title ?? task.title;
    const displayDetails = edit?.details ?? task.description;
    const displayContext = edit?.context ?? `tool: ${task.tool}\nvirtual file: ${task.filePath}`;
    const activeEdit = editingTask?.id === task.id ? editingTask : null;
    const changedFileCount = state?.progress === 76 || state?.status === "waiting" || state?.status === "completed" ? 1 : 0;
    const children = task.children ?? [];
    const hasChildren = children.length > 0;
    const isRootWrapper = depth === 0;
    const isCollapsible = hasChildren && !isRootWrapper;
    const isExpanded = isRootWrapper || expandedTaskIds.has(task.id);
    const activePathIndex = activePath.indexOf(task.id);
    const activeChildId = activePathIndex >= 0 ? activePath[activePathIndex + 1] : undefined;
    const activeChild = activeChildId ? children.find((child) => child.id === activeChildId) : undefined;
    const visibleChildren = hasChildren ? isExpanded ? children : activeChild ? [activeChild] : [] : [];
    const collapsedChildCount = isCollapsible && !isExpanded ? Math.max(0, children.length - (activeChild ? 1 : 0)) : 0;
    const isTerminal = status === "done" || status === "blocked" || taskStates[task.id]?.status === "completed";
    const canHold = !isTerminal && status !== "hold";
    const canSkip = !isTerminal;
    const canDone = status !== "done";
    return (
      <li className="todo-item" data-item-id={task.id} data-status={status} data-selected={selectedTaskId === task.id || activeTaskId === task.id} key={task.id} onClick={() => onSelect(task.id)} onDoubleClick={(event) => { event.stopPropagation(); startInlineEdit(task); }}>
        <div className="todo-item-main">
          {isCollapsible ? (
            <button
              className="todo-expand-toggle"
              type="button"
              data-expanded={isExpanded}
              data-active-path={!isExpanded && Boolean(activeChild)}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${displayTitle}`}
              onClick={(event) => {
                event.stopPropagation();
                toggleExpanded(task.id);
              }}
            >
              {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
              {collapsedChildCount > 0 && <span className="todo-child-count">{collapsedChildCount}</span>}
            </button>
          ) : <span className="todo-expand-spacer" />}
          <span className="todo-status-dot" data-task-status={state?.status ?? "queued"} aria-hidden="true">{todoStatusIconFor(state)}</span>
          <details className="todo-item-menu" data-menu-id={task.id} open={openMenuId === task.id} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
            <summary
              title="Todo item actions"
              aria-label="Open todo item actions"
              aria-expanded={openMenuId === task.id}
              onClick={(event) => {
                event.preventDefault();
                setOpenMenuId((current) => current === task.id ? null : task.id);
              }}
            >
              <EllipsisVertical aria-hidden="true" />
            </summary>
            <div className="todo-item-menu-popover">
              <button type="button" onClick={() => runMenuAction(() => startInlineEdit(task))}><Pencil aria-hidden="true" />Edit</button>
              <button type="button" onClick={() => runMenuAction(() => onSpawn(task.id))}><Plus aria-hidden="true" />Add child</button>
              {canHold && <button type="button" onClick={() => runMenuAction(() => onUpdate(task.id, "hold"))}><Clock3 aria-hidden="true" />Hold</button>}
              {canSkip && <button type="button" onClick={() => runMenuAction(() => onUpdate(task.id, "skipped"))}><ChevronDown aria-hidden="true" />Skip</button>}
              {canDone && <button type="button" onClick={() => runMenuAction(() => onUpdate(task.id, "done"))}><CheckCircle2 aria-hidden="true" />Done</button>}
            </div>
          </details>
          <div className="todo-item-copy">
            <strong>{displayTitle}</strong>
          </div>
          {changedFileCount > 0 && <span className="todo-file-count">{changedFileCount} file</span>}
        </div>
        {summaryMessages.length > 0 && (
          messageHistory.length > 1 ? (
            <details className="todo-message-history" onClick={(event) => event.stopPropagation()}>
              <summary>{renderSummaryMessages(summaryMessages, collapsedMessageCount)}</summary>
              <div className="todo-message-list">{messageHistory.map((message) => <div key={message.id}>{renderMessage(task, message)}</div>)}</div>
            </details>
          ) : renderSummaryMessages(summaryMessages, 0)
        )}
        {visibleChildren.length > 0 && <ul className="todo-item-list" data-depth={depth + 1}>{visibleChildren.map((child) => renderItem(child, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <section className="todo-panel-shell harness-todo-panel-shell" data-view={view} aria-label="Todo plan and agent">
      <div className="todo-view-tabs" role="tablist" aria-label="Todo plan and agent views">
        <button type="button" role="tab" aria-selected={view === "todo"} data-active={view === "todo"} onClick={() => setView("todo")}>Todo plan</button>
        <button type="button" role="tab" aria-selected={view === "agent"} data-active={view === "agent"} onClick={() => setView("agent")}>Agent</button>
      </div>
      <div className="todo-panel-content">
        {view === "todo" ? (
          <section className="todo-panel" aria-label="Todo plan" onMouseUp={captureSelectionComment} onKeyUp={captureSelectionComment}>
            <div className="todo-panel-header">
              <div><span className="todo-panel-title">Todo plan</span><small>{taskMap.size} items · verify page</small></div>
              <div className="todo-panel-actions">
                <button type="button" onClick={onTogglePause}>{paused ? <Play aria-hidden="true" /> : <Clock3 aria-hidden="true" />}{paused ? "Resume" : "Pause"}</button>
              </div>
            </div>
            {paused && <div className="todo-control-note">Paused: control or challenge recovery</div>}
            <ul className="todo-item-list">{renderItem(root)}</ul>
          </section>
        ) : (
          <section className="todo-panel" aria-label="Agent activity">
            <div className="todo-panel-header"><div><span className="todo-panel-title">Agent</span><small>mock hand-offs</small></div><Bot aria-hidden="true" /></div>
            <div className="harness-todo-agent-view">{events.slice(-12).reverse().map((event) => <div className="todo-message" key={event.id}><strong>{event.message}</strong></div>)}</div>
          </section>
        )}
      </div>
      {editingTask && (
        <div className="todo-edit-backdrop" role="presentation" onMouseDown={() => setEditingTask(null)}>
          <form className="todo-edit-popover" onSubmit={saveInlineEdit} onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setEditingTask(null); }}>
            <div className="todo-edit-popover-header"><strong>Edit todo item</strong><button type="button" onClick={() => setEditingTask(null)} title="Close edit popup" aria-label="Close edit popup"><X aria-hidden="true" /></button></div>
            <label><span>Title</span><input value={editingTask.title} onChange={(event) => updateInlineEdit({ title: event.target.value })} placeholder="Todo title" autoFocus /></label>
            <label><span>Details</span><textarea value={editingTask.details} onChange={(event) => updateInlineEdit({ details: event.target.value })} placeholder="Details" rows={3} /></label>
            <label><span>Context</span><textarea value={editingTask.context} onChange={(event) => updateInlineEdit({ context: event.target.value })} placeholder="Context" rows={3} /></label>
            <div className="todo-edit-popover-actions"><button type="button" onClick={() => setEditingTask(null)}>Cancel</button><button type="submit">Save</button></div>
          </form>
        </div>
      )}
      {selectionComment && (
        <form
          className="todo-selection-comment-popover"
          style={{ left: selectionComment.left, top: selectionComment.top }}
          onSubmit={submitSelectionComment}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === "Escape") setSelectionComment(null); }}
        >
          <span>Comment on selection</span>
          <blockquote>{selectionComment.selectedText}</blockquote>
          <textarea
            value={selectionComment.body}
            onChange={(event) => setSelectionComment((current) => current ? { ...current, body: event.target.value } : current)}
            placeholder="Add comment"
            rows={2}
            autoFocus
          />
          <div>
            <button type="button" onClick={() => setSelectionComment(null)}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </form>
      )}
    </section>
  );
}

function HarnessTodoPanel({
  root,
  taskStates,
  events,
  selectedTaskId,
  activeTaskId,
  collapseVersion,
  paused,
  onSelect,
  onSpawn,
  onTogglePause,
  onComment,
  onUpdate,
  onResolveChallenge
}: HarnessTodoPanelProps) {
  const [taskEdits, setTaskEdits] = useState<Record<string, { title: string; details: string; context: string }>>({});

  const toMessage = useCallback((event: HarnessEvent): TodoPlanMessage => {
    const type = event.actor === "blocker" || /^workaround applied/i.test(event.message)
      ? "blocker"
      : event.tone === "warning" || event.actor === "solution"
        ? "challenge"
        : "update";
    const isRecovery = event.actor === "solution" || /^(solution|workaround) applied/i.test(event.message);
    return {
      id: event.id,
      type,
      title: event.message,
      resolved: isRecovery || events.some((candidate) => candidate.taskId === event.taskId && candidate.actor === "solution"),
      challengeId: event.taskId
    };
  }, [events]);

  const planRoot = useMemo((): TodoPlanItem => {
    const toItem = (task: MockTask): TodoPlanItem => {
      const state = taskStates[task.id];
      const edit = taskEdits[task.id];
      const changedFileCount = state?.progress === 76 || state?.status === "waiting" || state?.status === "completed" ? 1 : 0;
      return {
        id: task.id,
        title: edit?.title ?? task.title,
        details: "",
        context: "",
        status: todoStatusFor(state),
        taskStatus: state?.status ?? "queued",
        activeStatus: state?.detail ?? null,
        changedFileCount,
        selected: selectedTaskId === task.id || activeTaskId === task.id,
        messages: events.filter((event) => event.taskId === task.id).map(toMessage),
        children: (task.children ?? []).map(toItem)
      };
    };
    return toItem(root);
  }, [activeTaskId, events, root, selectedTaskId, taskEdits, taskStates, toMessage]);

  const agentEvents = useMemo(() => events.map(toMessage), [events, toMessage]);

  return (
    <TodoPlanPanel
      showItemContext={false}
      sections={[{ id: "mock-plan", items: [planRoot] }]}
      itemCount={Object.keys(taskStates).length}
      paused={paused}
      pauseReason={paused ? "control or challenge recovery" : null}
      collapseKey={collapseVersion}
      agentEvents={agentEvents}
      agentEmptyLabel="Press play to start the mock plan."
      onTogglePause={onTogglePause}
      onSelectItem={onSelect}
      onEditItem={(taskId, patch) => setTaskEdits((current) => ({ ...current, [taskId]: patch }))}
      onCreateItem={onSpawn}
      onUpdateStatus={onUpdate}
      onComment={onComment}
      onResolveChallenge={(taskId) => onResolveChallenge(String(taskId))}
    />
  );
}

export function McpPlanHarness({ onExit }: { onExit: () => void }) {
  const staticTasks = useMemo(() => flattenTasks(MOCK_PLAN), []);
  const [dynamicChildren, setDynamicChildren] = useState<Record<string, MockTask[]>>({});
  const [taskStates, setTaskStates] = useState<Record<string, TaskState>>(() => initialTaskStates(staticTasks));
  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [files, setFiles] = useState<Record<string, MockFile>>({});
  const [selectedTaskId, setSelectedTaskId] = useState(ROOT_ID);
  const [selectedFilePath, setSelectedFilePath] = useState(MOCK_PLAN.filePath);
  const [todoContext, setTodoContext] = useState("Mock MCP execution only.\nNo network, server, or filesystem side effects.");
  const [todoCollapseVersion, setTodoCollapseVersion] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_ID, "design", "implement", "controls"]));
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [pendingChallenge, setPendingChallenge] = useState<{ taskId: string; challenge: NonNullable<MockTask["challenge"]> } | null>(null);
  const runRef = useRef({ running: false, queue: staticTasks.map((task) => task.id), cursor: 0, activeId: null as string | null, phase: -1 });
  const timerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const spawnCounterRef = useRef(1);

  const allTasks = useMemo(() => {
    const attach = (task: MockTask): MockTask => ({ ...task, children: [...(task.children ?? []), ...(dynamicChildren[task.id] ?? [])].map(attach) });
    return [attach(MOCK_PLAN)];
  }, [dynamicChildren]);
  const taskMap = useMemo(() => new Map(flattenTasks(allTasks[0]).map((task) => [task.id, task])), [allTasks]);
  const fileList = useMemo(() => Object.values(files).sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const selectedTask = taskMap.get(selectedTaskId) ?? MOCK_PLAN;
  const selectedFile = files[selectedFilePath] ?? fileList[0];
  const completedCount = Object.values(taskStates).filter((state) => state.status === "completed").length;
  const totalCount = taskMap.size;
  const runningCount = Object.values(taskStates).filter((state) => state.status === "running" || state.status === "writing").length;

  const addEvent = useCallback((task: MockTask, actor: string, message: string, tone: HarnessEvent["tone"] = "neutral") => {
    setEvents((current) => [...current, {
      id: `${Date.now()}-${Math.random()}`,
      taskId: task.id,
      taskTitle: task.title,
      actor,
      message,
      tone,
      time: Date.now()
    }]);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
  }, []);

  const scheduleTick = useCallback((delay = 650) => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const run = runRef.current;
      if (!run.running) return;
      const nextTask = run.activeId ? taskMap.get(run.activeId) : undefined;
      if (!nextTask) {
        const task = taskMap.get(run.queue[run.cursor]);
        if (!task) {
          run.running = false;
          setIsPlaying(false);
          setActiveTaskId(null);
          addEvent(MOCK_PLAN, "harness", "Plan complete · all MCP calls remained mocked", "success");
          return;
        }
        run.activeId = task.id;
        run.phase = -1;
        setActiveTaskId(task.id);
        setSelectedTaskId(task.id);
        setTaskStates((current) => ({ ...current, [task.id]: { ...current[task.id], status: "queued", detail: "accepted by mock queue", progress: 8, updatedAt: Date.now() } }));
        addEvent(task, task.owner, "queued under parent context", "neutral");
        scheduleTick();
        return;
      }

      run.phase += 1;
      const phase = PLAYBACK_PHASES[run.phase];
      if (!phase) return;
      const workaroundDetail = nextTask.challenge?.outcome === "blocker" && nextTask.challenge.workaround && run.phase >= 3 && phase.status !== "completed"
        ? `workaround: ${nextTask.challenge.workaround}`
        : null;
      const phaseDetail = workaroundDetail ?? phase.detail;
      setTaskStates((current) => ({ ...current, [nextTask.id]: { ...current[nextTask.id], status: phase.status, detail: phaseDetail, progress: phase.progress, updatedAt: Date.now() } }));
      addEvent(nextTask, nextTask.owner, `${phase.label} · ${phaseDetail}`, phase.status === "completed" ? "success" : phase.status === "writing" ? "active" : "neutral");

      if (run.phase === 2 && nextTask.challenge) {
        addEvent(nextTask, "challenge", `Challenge reported · ${nextTask.challenge.title}: ${nextTask.challenge.symptom}`, "warning");
        if (nextTask.challenge.outcome === "self-resolve") {
          addEvent(nextTask, "solution", `Solution applied · ${nextTask.challenge.solution}`, "success");
          setTaskStates((current) => ({ ...current, [nextTask.id]: { ...current[nextTask.id], status: "running", detail: "solution applied · continuing", progress: Math.max(phase.progress, 60), updatedAt: Date.now() } }));
        } else {
          run.running = false;
          setIsPlaying(false);
          setPendingChallenge({ taskId: nextTask.id, challenge: nextTask.challenge });
          setTaskStates((current) => ({ ...current, [nextTask.id]: { ...current[nextTask.id], status: "blocked", detail: "blocker: workaround decision needed", progress: Math.max(phase.progress, 58), updatedAt: Date.now() } }));
          addEvent(nextTask, "blocker", `Blocker · ${nextTask.challenge.solution}`, "warning");
          if (nextTask.challenge.workaround) {
            clearRecoveryTimer();
            recoveryTimerRef.current = window.setTimeout(() => {
              const workaround = nextTask.challenge?.workaround;
              if (!workaround) return;
              addEvent(nextTask, "solution", `Workaround applied · ${workaround}`, "success");
              setTaskStates((current) => ({ ...current, [nextTask.id]: { ...current[nextTask.id], status: "waiting", detail: `workaround: ${workaround}`, progress: 90, updatedAt: Date.now() } }));
              setPendingChallenge(null);
              runRef.current.running = true;
              setIsPlaying(true);
              scheduleTick(180);
            }, 1400);
          }
          return;
        }
      }

      if (phase.status === "writing") {
        setFiles((current) => {
          const previous = current[nextTask.filePath];
          const nextFile = { path: nextTask.filePath, content: nextTask.fileContent, updatedAt: Date.now(), taskId: nextTask.id, version: (previous?.version ?? 0) + 1 };
          setSelectedFilePath(nextFile.path);
          return { ...current, [nextFile.path]: nextFile };
        });
        addEvent(nextTask, "filesystem.mock", `updated ${nextTask.filePath} · virtual v${(files[nextTask.filePath]?.version ?? 0) + 1}`, "active");
      }

      if (phase.status === "completed") {
        run.cursor += 1;
        run.activeId = null;
        run.phase = -1;
        setActiveTaskId(null);
      }
      scheduleTick();
    }, delay);
  }, [addEvent, clearRecoveryTimer, clearTimer, files, taskMap]);

  const reset = useCallback((options?: { collapse?: boolean }) => {
    clearTimer();
    clearRecoveryTimer();
    runRef.current = { running: false, queue: staticTasks.map((task) => task.id), cursor: 0, activeId: null, phase: -1 };
    setIsPlaying(false);
    setHasStarted(false);
    setActiveTaskId(null);
    setPendingChallenge(null);
    setDynamicChildren({});
    setTaskStates(initialTaskStates(staticTasks));
    setEvents([{ id: "boot", taskId: ROOT_ID, taskTitle: MOCK_PLAN.title, actor: "harness", message: "ready · mock MCP mode · no real execution", tone: "active", time: Date.now() }]);
    setFiles({});
    setSelectedTaskId(ROOT_ID);
    setSelectedFilePath(MOCK_PLAN.filePath);
    setTodoContext("Mock MCP execution only.\nNo network, server, or filesystem side effects.");
    if (options?.collapse !== false) {
      setTodoCollapseVersion((current) => current + 1);
      setExpanded(new Set([ROOT_ID, "design", "implement", "controls"]));
    }
  }, [clearRecoveryTimer, clearTimer, staticTasks]);

  const playFromStart = useCallback(() => {
    reset({ collapse: false });
    window.setTimeout(() => {
      runRef.current.running = true;
      setHasStarted(true);
      setIsPlaying(true);
      addEvent(MOCK_PLAN, "harness", "playback started from root", "active");
      scheduleTick(100);
    }, 0);
  }, [addEvent, reset, scheduleTick]);

  const pause = useCallback(() => {
    runRef.current.running = false;
    clearTimer();
    setIsPlaying(false);
    if (activeTaskId) {
      const task = taskMap.get(activeTaskId);
      if (task) addEvent(task, "harness", "paused", "warning");
    }
  }, [activeTaskId, addEvent, clearTimer, taskMap]);

  const resume = useCallback(() => {
    if (pendingChallenge) return;
    runRef.current.running = true;
    setIsPlaying(true);
    addEvent(MOCK_PLAN, "harness", "playback resumed", "active");
    scheduleTick(100);
  }, [addEvent, pendingChallenge, scheduleTick]);

  const resolveChallenge = useCallback(() => {
    if (!pendingChallenge) return;
    const task = taskMap.get(pendingChallenge.taskId);
    if (!task) return;
    clearRecoveryTimer();
    const workaround = pendingChallenge.challenge.workaround ?? pendingChallenge.challenge.solution;
    addEvent(task, "solution", `Workaround applied · ${workaround}`, "success");
    setTaskStates((current) => ({ ...current, [task.id]: { ...current[task.id], status: "waiting", detail: `workaround: ${workaround}`, progress: 90, updatedAt: Date.now() } }));
    setPendingChallenge(null);
    runRef.current.running = true;
    setIsPlaying(true);
    scheduleTick(180);
  }, [addEvent, clearRecoveryTimer, pendingChallenge, scheduleTick, taskMap]);

  const spawnSubAgent = useCallback((parentId: string) => {
    const parent = taskMap.get(parentId) ?? MOCK_PLAN;
    const number = spawnCounterRef.current++;
    const id = `spawned-agent-${number}`;
    const agent: MockTask = {
      id,
      title: `Sub-agent ${number} · inspect hand-off`,
      kind: "sub-agent",
      owner: `agent-${number}`,
      tool: "mcp.agent.spawn",
      description: `A reactive child spawned under ${parent.title}.`,
      filePath: `mock/agents/agent-${number}.md`,
      fileContent: `# Spawned sub-agent ${number}\n\nParent: ${parent.id}\nStatus: attached to mock plan\nExecution: intercepted`
    };
    setDynamicChildren((current) => ({ ...current, [parent.id]: [...(current[parent.id] ?? []), agent] }));
    runRef.current.queue.push(agent.id);
    setTaskStates((current) => ({ ...current, [agent.id]: { status: "queued", detail: "spawned · waiting for queue", progress: 0, updatedAt: Date.now() } }));
    setExpanded((current) => new Set(current).add(parent.id));
    addEvent(parent, "agent.spawn", `spawned ${agent.title}`, "active");
    setSelectedTaskId(agent.id);
  }, [addEvent, taskMap]);

  const toggleTodoPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else if (hasStarted && !pendingChallenge) {
      resume();
    }
  }, [hasStarted, isPlaying, pause, pendingChallenge, resume]);

  const toggleTodoContext = useCallback(() => {
    setTodoContext((current) => {
      const next = current ? "" : "Mock MCP execution only.\nNo network, server, or filesystem side effects.";
      addEvent(MOCK_PLAN, "operator", next ? "todo context updated" : "todo context cleared", "active");
      return next;
    });
  }, [addEvent]);

  const addTodoComment = useCallback((taskId: string, type: "note" | "blocker", body?: string) => {
    const task = taskMap.get(taskId) ?? MOCK_PLAN;
    addEvent(task, "operator", `${type}: ${body?.trim() || "note added from todo UI"}`, "neutral");
  }, [addEvent, taskMap]);

  const updateTodoFromMenu = useCallback((taskId: string, status: "hold" | "skipped" | "done") => {
    const task = taskMap.get(taskId) ?? MOCK_PLAN;
    const nextState: TaskState = status === "done"
      ? { status: "completed", detail: "marked done", progress: 100, updatedAt: Date.now() }
      : { status: "waiting", detail: status === "hold" ? "held" : "skipped", progress: status === "hold" ? 90 : 100, updatedAt: Date.now() };
    setTaskStates((current) => ({ ...current, [taskId]: nextState }));
    addEvent(task, "operator", `${status} from todo item actions`, status === "hold" ? "warning" : "active");
  }, [addEvent, taskMap]);

  useEffect(() => () => {
    clearTimer();
    clearRecoveryTimer();
  }, [clearRecoveryTimer, clearTimer]);

  const visibleEvents = events.slice(-80).reverse();

  return (
    <main className="harness-page">
      <header className="harness-header">
        <div className="harness-brand">
          <div className="harness-brand-mark"><GitBranch aria-hidden="true" /></div>
          <div>
            <div className="harness-eyebrow">TODO UI VERIFY PAGE · MOCK ONLY</div>
            <h1>Nested plan verification</h1>
          </div>
        </div>
        <div className="harness-header-actions">
          <span className="harness-safety-pill"><ShieldAlert aria-hidden="true" /> no real MCP calls</span>
          <button className="harness-button ghost" type="button" onClick={onExit}><X aria-hidden="true" /> Exit harness</button>
        </div>
      </header>

      <section className="harness-toolbar" aria-label="Harness controls">
        <div className="harness-toolbar-copy">
          <span className="harness-live-dot" data-live={isPlaying} />
          <strong>{isPlaying ? "Simulating execution" : pendingChallenge ? "Paused at challenge" : hasStarted ? "Simulation paused" : "Ready to play"}</strong>
          <span>Every status and file write is generated in memory.</span>
        </div>
        <div className="harness-controls">
          {isPlaying ? (
            <button className="harness-button primary" type="button" onClick={pause}><Square aria-hidden="true" /> Pause</button>
          ) : (
            <button className="harness-button primary" type="button" onClick={hasStarted ? resume : playFromStart}><Play aria-hidden="true" /> {hasStarted ? "Resume" : "Play from start"}</button>
          )}
          <button className="harness-button" type="button" onClick={() => reset()}><RotateCcw aria-hidden="true" /> Reset</button>
          <button className="harness-button" type="button" onClick={() => spawnSubAgent(activeTaskId ?? ROOT_ID)}><Bot aria-hidden="true" /> Spawn sub-agent</button>
        </div>
      </section>

      <section className="harness-summary-strip" aria-label="Simulation summary">
        <div><span>Plan</span><strong>release-orchestrator</strong></div>
        <div><span>Tasks</span><strong>{completedCount} / {totalCount} completed</strong></div>
        <div><span>Active</span><strong>{runningCount > 0 ? `${runningCount} running` : pendingChallenge ? "1 blocked" : "idle"}</strong></div>
        <div><span>Virtual files</span><strong>{fileList.length} updated</strong></div>
        <div><span>Tick</span><strong>650ms / step</strong></div>
      </section>

      <div className="harness-workspace">
        <aside className="harness-panel harness-plan-panel harness-todo-host">
          <HarnessTodoPanel
            root={allTasks[0]}
            taskMap={taskMap}
            taskStates={taskStates}
            events={events}
            selectedTaskId={selectedTaskId}
            activeTaskId={activeTaskId}
            collapseVersion={todoCollapseVersion}
            paused={!isPlaying && hasStarted}
            context={todoContext}
            onSelect={setSelectedTaskId}
            onSpawn={spawnSubAgent}
            onTogglePause={toggleTodoPause}
            onContext={toggleTodoContext}
            onComment={addTodoComment}
            onUpdate={updateTodoFromMenu}
            onResolveChallenge={resolveChallenge}
          />
        </aside>

        <section className="harness-panel harness-events-panel">
          <div className="harness-panel-heading">
            <div><span className="harness-panel-kicker">02 · EVENT STREAM</span><h2>Runtime activity</h2></div>
            <TerminalSquare aria-hidden="true" />
          </div>
          <div className="harness-event-list" aria-live="polite">
            {visibleEvents.length === 0 ? <div className="harness-empty"><Sparkles aria-hidden="true" /><strong>Press play to start the mock plan</strong><span>The stream will show queued, tool, file, hand-off, and completion statuses.</span></div> : visibleEvents.map((event) => (
              <article className="harness-event" data-tone={event.tone} key={event.id}>
                <span className="harness-event-marker" />
                <div className="harness-event-main"><div><strong>{event.taskTitle}</strong></div><p>{event.message}</p></div>
              </article>
            ))}
          </div>
        </section>

        <aside className="harness-right-stack">
          <section className="harness-panel harness-file-panel">
            <div className="harness-panel-heading">
              <div><span className="harness-panel-kicker">03 · VIRTUAL FILES</span><h2>Workspace updates</h2></div>
              <FileCode2 aria-hidden="true" />
            </div>
            <p className="harness-panel-intro">Writes are previews only — nothing reaches disk.</p>
            <div className="harness-file-list">
              {fileList.length === 0 ? <div className="harness-file-empty"><FileText aria-hidden="true" /><span>Files appear when a task reaches “Updating file”.</span></div> : fileList.map((file) => (
                <button className="harness-file-row" data-selected={file.path === selectedFilePath} type="button" key={file.path} onClick={() => { setSelectedFilePath(file.path); setSelectedTaskId(file.taskId); }}>
                  <FileText aria-hidden="true" /><span>{file.path}</span><small>v{file.version}</small>
                </button>
              ))}
            </div>
            {selectedFile && <div className="harness-file-preview"><div><strong>{selectedFile.path}</strong><span>virtual v{selectedFile.version}</span></div><pre>{selectedFile.content}</pre></div>}
          </section>

          <section className="harness-panel harness-challenge-panel">
            <div className="harness-panel-heading">
              <div><span className="harness-panel-kicker">04 · RECOVERY</span><h2>Challenge desk</h2></div>
              <ShieldAlert aria-hidden="true" />
            </div>
            {pendingChallenge ? (
              <div className="harness-challenge-card"><span className="harness-challenge-label">blocker · recovery needed</span><h3>{pendingChallenge.challenge.title}</h3><p><strong>Symptom</strong>{pendingChallenge.challenge.symptom}</p><p><strong>Decision</strong>{pendingChallenge.challenge.solution}</p><p><strong>Workaround</strong>{pendingChallenge.challenge.workaround ?? pendingChallenge.challenge.solution}</p><button className="harness-button solution" type="button" onClick={resolveChallenge}><Check aria-hidden="true" /> Apply workaround &amp; resume</button></div>
            ) : <div className="harness-challenge-idle"><Check aria-hidden="true" /><strong>No active blocker</strong><span>Seeded challenges will either self-resolve or escalate here for workaround handling.</span></div>}
          </section>
        </aside>
      </div>
    </main>
  );
}
