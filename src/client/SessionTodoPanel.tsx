import { LightweightTodoPanel } from "./LightweightTodoPanel";
import type { LightweightTodo } from "../lightweightTodo";
import { useMemo } from "react";
import { TodoPlanPanel } from "./TodoPlanPanel";
import type { TodoPlanItem, TodoPlanMessage, TodoPlanSection, TodoPlanSession } from "./TodoPlanPanel";

type TodoStatus = "todo" | "active" | "paused" | "hold" | "skipped" | "done" | "blocked";

type SessionTodoItem = {
  id: string;
  parentId: string | null;
  title: string;
  details: string;
  context: string;
  section: "solution" | "verification" | null;
  status: TodoStatus;
  position: number;
  created: string;
  activeStatus: string | null;
  lockReason: string | null;
  changedFileCount: number;
};

type SessionTodo = {
  lightweight?: LightweightTodo | null;
  control: { paused: boolean; pauseReason: string | null; problem: string; objective: string };
  items: SessionTodoItem[];
  comments: Array<{ id: string; itemId: string | null; type: "status" | "blocker" | "note"; body: string }>;
  messages?: Array<{
    id: number;
    itemId: string;
    type: "update" | "challenge";
    title: string;
    body: string;
    challengeId: number | null;
    resolved: boolean;
  }>;
  itemSessions?: Array<{ id: string; itemId: string; childSessionId: string; title: string }>;
};

type SessionTodoPanelProps = {
  todo: SessionTodo;
  sessionExecutionStatuses?: Record<string, string>;
  pendingApprovalSessionIds?: Set<string>;
  onOpenSession?: (sessionId: string) => void;
  onPause: (paused: boolean) => void | Promise<void>;
  onCreateItem: (parentId: string) => void | Promise<void>;
  onUpdateItem: (itemId: string, patch: Partial<Pick<SessionTodoItem, "title" | "details" | "context" | "status">>) => void | Promise<void>;
  onComment: (itemId: string, type: "note" | "blocker", body?: string) => void | Promise<void>;
  onResolveChallenge: (challengeId: number) => void | Promise<void>;
};

function sessionStatus(
  sessionId: string,
  executionStatuses: Record<string, string>,
  pendingApprovalSessionIds: Set<string>
): TodoPlanSession["status"] {
  if (pendingApprovalSessionIds.has(sessionId)) return "blocked";
  return executionStatuses[sessionId] === "running" ? "running" : "done";
}

export function SessionTodoPanel(props: SessionTodoPanelProps) {
  if (props.todo.lightweight) return <LightweightTodoPanel plan={props.todo.lightweight} />;
  return <LegacySessionTodoPanel {...props} />;
}

function LegacySessionTodoPanel({
  todo,
  sessionExecutionStatuses = {},
  pendingApprovalSessionIds = new Set(),
  onOpenSession,
  onPause,
  onCreateItem,
  onUpdateItem,
  onComment,
  onResolveChallenge
}: SessionTodoPanelProps) {
  const sections = useMemo(() => {
    const childrenByParent = new Map<string | null, SessionTodoItem[]>();
    const messagesByItem = new Map<string, TodoPlanMessage[]>();
    const commentsByItem = new Map<string, TodoPlanItem["comments"]>();
    const sessionsByItem = new Map<string, TodoPlanSession[]>();

    for (const item of todo.items) {
      const children = childrenByParent.get(item.parentId) ?? [];
      children.push(item);
      childrenByParent.set(item.parentId, children);
    }
    for (const children of childrenByParent.values()) {
      children.sort((left, right) => left.position - right.position || left.created.localeCompare(right.created));
    }
    for (const message of todo.messages ?? []) {
      const messages = messagesByItem.get(message.itemId) ?? [];
      messages.push({
        id: String(message.id),
        type: message.type,
        title: message.title,
        body: message.body,
        challengeId: message.challengeId,
        resolved: message.resolved
      });
      messagesByItem.set(message.itemId, messages);
    }
    for (const comment of todo.comments) {
      if (!comment.itemId) continue;
      const comments = commentsByItem.get(comment.itemId) ?? [];
      comments.push({ id: comment.id, type: comment.type, body: comment.body });
      commentsByItem.set(comment.itemId, comments);
    }
    for (const session of todo.itemSessions ?? []) {
      const sessions = sessionsByItem.get(session.itemId) ?? [];
      sessions.push({
        id: session.childSessionId,
        title: session.title || session.childSessionId,
        status: sessionStatus(session.childSessionId, sessionExecutionStatuses, pendingApprovalSessionIds)
      });
      sessionsByItem.set(session.itemId, sessions);
    }

    const toPlanItem = (item: SessionTodoItem): TodoPlanItem => ({
      id: item.id,
      title: item.title,
      details: item.details,
      context: item.context,
      status: item.status,
      activeStatus: item.activeStatus,
      lockReason: item.lockReason,
      changedFileCount: item.changedFileCount,
      messages: messagesByItem.get(item.id),
      comments: commentsByItem.get(item.id),
      sessions: sessionsByItem.get(item.id),
      children: (childrenByParent.get(item.id) ?? []).map(toPlanItem)
    });

    const roots = childrenByParent.get(null) ?? [];
    const groups: TodoPlanSection[] = [
      { id: "solution", label: "Solution", items: roots.filter((item) => item.section === "solution").map(toPlanItem) },
      { id: "verification", label: "Verification", items: roots.filter((item) => item.section === "verification").map(toPlanItem) },
      { id: "other", label: "Other", items: roots.filter((item) => item.section !== "solution" && item.section !== "verification").map(toPlanItem) }
    ];
    return groups.filter((group) => group.items.length > 0);
  }, [pendingApprovalSessionIds, sessionExecutionStatuses, todo]);

  const agentEvents = useMemo(() => (todo.messages ?? []).map((message) => ({
    id: String(message.id),
    type: message.type,
    title: message.title,
    body: message.body,
    challengeId: message.challengeId,
    resolved: message.resolved
  })), [todo.messages]);

  return (
    <TodoPlanPanel
      sections={sections}
      itemCount={todo.items.length}
      paused={todo.control.paused}
      pauseReason={todo.control.pauseReason}
      problem={todo.control.problem}
      objective={todo.control.objective}
      agentEvents={agentEvents}
      onTogglePause={() => void onPause(!todo.control.paused)}
      onOpenSession={onOpenSession}
      onEditItem={(itemId, patch) => onUpdateItem(itemId, patch)}
      onCreateItem={onCreateItem}
      onUpdateStatus={(itemId, status) => onUpdateItem(itemId, { status })}
      onComment={onComment}
      onResolveChallenge={(challengeId) => void onResolveChallenge(Number(challengeId))}
    />
  );
}
