// Keep the browser subscription and server projection in sync. Transcript
// items and raw Codex notifications are delivered by the runner SSE stream.
export const CLIENT_EVENT_TYPES = [
  "runner.session",
  "runner.runner.started",
  "runner.developer_instructions",
  "runner.result",
  "runner.pending",
  "runner.error",
  "runner.done",
  "runner.runner.callback_error",
  "runner.approval.requested",
  "runner.approval.resolved",
  // Compact liveness only (no text); the full payload streams over runner SSE.
  "runner.subagent_activity",
  "session.imported",
  "session.archived",
  "session.task.created",
  "session.title.updated",
  "todo.changed",
  "workspace.created",
  "workspace.switched"
] as const;

export const EVENT_STATE_FIELDS = ["statusMonitor", "processMonitors", "grillSummaries", "waitEvents", "waitSubscriptions"] as const;
export type EventStateVersions = Record<typeof EVENT_STATE_FIELDS[number], string>;

export function encodeEventStateVersions(versions: EventStateVersions): string {
  return EVENT_STATE_FIELDS.map((field) => versions[field]).join(".");
}

/**
 * Runner event `subagent_activity`: progress of one sub-agent, keyed by the
 * parent's Agent tool_use id (`agentId`, the same id as its `subagent` live
 * item). `seq` increases per agentId within one runner; (agentId, seq) is the
 * dedupe key for persistence, SSE replay and snapshots.
 *
 * - started / finished: lifecycle; `finished` carries `status` and closes the
 *   sub-agent's live item.
 * - progress / message / tool / waiting: activity (`text` is clipped).
 * - heartbeat: liveness (`elapsedMs`, `lastActivityAt`, `processAlive`); only the
 *   latest heartbeat per agent is retained.
 * - send_message: the sub-agent's own SendMessage call, once per tool_use id
 *   when its result arrives (or when the sub-agent ends without one); carries `sendMessage`.
 */
export const SUBAGENT_ACTIVITY_KINDS = ["started", "progress", "message", "tool", "heartbeat", "waiting", "finished", "send_message"] as const;
export type SubagentActivityKind = typeof SUBAGENT_ACTIVITY_KINDS[number];
export type SubagentActivityStatus = "completed" | "failed" | "stopped";

export type SubagentActivityPayload = {
  agentId: string;
  source: "claude";
  kind: SubagentActivityKind;
  at: string;
  seq: number;
  taskId?: string;
  text?: string;
  toolName?: string;
  description?: string;
  status?: SubagentActivityStatus;
  toolUses?: number;
  totalTokens?: number;
  elapsedMs?: number;
  lastActivityAt?: string;
  processAlive?: boolean;
  waiting?: "approval" | "input";
  /** kind "send_message" only. */
  sendMessage?: SendMessageRecord;
};

/**
 * One Claude Code SendMessage call (a message to a sub-agent, teammate or other
 * agent); the full contract is docs/claude-send-message-events.md. `toolUseId`
 * identifies the message: every emission for one id describes the same message.
 */
export type SendMessageStatus = "pending" | "sent" | "failed";
export type SendMessageRecord = {
  toolUseId: string;
  /** Main session, or the sub-agent keyed by its Agent/Task tool_use id. */
  sender: { kind: "main" } | { kind: "subagent"; agentId: string };
  /** Recipient exactly as the model named it (agent id, name or "*"). */
  to: string;
  /** The recipient's Agent/Task tool_use id (its `subagent` card id) when known in this runner. */
  recipientAgentId?: string;
  summary?: string;
  message: string;
  /** Set when `message` was clipped to SEND_MESSAGE_TEXT_MAX_CHARS; the clip ends with "…". */
  messageTruncated?: true;
  omittedMessageChars?: number;
  status: SendMessageStatus;
  /** Tool result text, clipped to SEND_MESSAGE_RESULT_MAX_CHARS. */
  resultSummary?: string;
  /** When the tool_use was seen. */
  at: string;
  /** When the result was seen. */
  completedAt?: string;
};

export const SEND_MESSAGE_TEXT_MAX_CHARS = 8000;
export const SEND_MESSAGE_RESULT_MAX_CHARS = 1000;

export const SUBAGENT_ACTIVITY_TEXT_MAX_CHARS = 2000;
/** Non-lifecycle activity events kept per agent; started/finished and the latest heartbeat are always kept. */
export const SUBAGENT_ACTIVITY_RETAINED_PER_AGENT = 50;

const subagentActivityKinds = new Set<string>(SUBAGENT_ACTIVITY_KINDS);

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Clips SendMessage text: `{ text, omitted }`, where the clipped text ends with "…". */
export function clipSendMessageText(value: string, max: number): { text: string; omitted: number } {
  return value.length > max ? { text: `${value.slice(0, max - 1)}…`, omitted: value.length - (max - 1) } : { text: value, omitted: 0 };
}

/** Validates and bounds a SendMessageRecord; null when it has no tool_use id, recipient or sender. */
export function normalizeSendMessage(value: unknown): SendMessageRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const toolUseId = boundedString(data.toolUseId, 200);
  const to = boundedString(data.to, 200);
  const at = isoTimestamp(data.at);
  const rawSender = data.sender && typeof data.sender === "object" ? data.sender as Record<string, unknown> : null;
  const senderAgentId = rawSender?.kind === "subagent" ? boundedString(rawSender.agentId, 200) : undefined;
  const sender: SendMessageRecord["sender"] | null = rawSender?.kind === "main" ? { kind: "main" }
    : senderAgentId ? { kind: "subagent", agentId: senderAgentId } : null;
  if (!toolUseId || !to || !at || !sender) return null;
  const status: SendMessageStatus = data.status === "sent" || data.status === "failed" ? data.status : "pending";
  const rawMessage = typeof data.message === "string" ? data.message : "";
  const clipped = clipSendMessageText(rawMessage, SEND_MESSAGE_TEXT_MAX_CHARS);
  const omitted = clipped.omitted + (count(data.omittedMessageChars) ?? 0);
  const optional: Partial<SendMessageRecord> = {
    recipientAgentId: boundedString(data.recipientAgentId, 200),
    summary: boundedString(data.summary, 500),
    messageTruncated: data.messageTruncated === true || omitted > 0 ? true : undefined,
    omittedMessageChars: omitted > 0 ? omitted : undefined,
    resultSummary: boundedString(data.resultSummary, SEND_MESSAGE_RESULT_MAX_CHARS),
    completedAt: isoTimestamp(data.completedAt)
  };
  return {
    toolUseId, sender, to, message: clipped.text, status, at,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined))
  } as SendMessageRecord;
}

/** Validates and bounds a runner `subagent_activity` payload; null when it cannot be keyed. */
export function normalizeSubagentActivity(value: unknown, fallbackAt?: string): SubagentActivityPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const agentId = boundedString(data.agentId, 200);
  const kind = typeof data.kind === "string" && subagentActivityKinds.has(data.kind) ? data.kind as SubagentActivityKind : null;
  const seq = typeof data.seq === "number" && Number.isSafeInteger(data.seq) && data.seq >= 0 ? data.seq : null;
  const at = isoTimestamp(data.at) ?? isoTimestamp(fallbackAt);
  if (!agentId || !kind || seq === null || !at || (data.source !== undefined && data.source !== "claude")) return null;
  const status = data.status === "completed" || data.status === "failed" || data.status === "stopped" ? data.status : undefined;
  const waiting = data.waiting === "approval" || data.waiting === "input" ? data.waiting : undefined;
  const optional: Partial<SubagentActivityPayload> = {
    taskId: boundedString(data.taskId, 200),
    text: boundedString(data.text, SUBAGENT_ACTIVITY_TEXT_MAX_CHARS),
    toolName: boundedString(data.toolName, 200),
    description: boundedString(data.description, 500),
    status: kind === "finished" ? status ?? "completed" : status,
    toolUses: count(data.toolUses),
    totalTokens: count(data.totalTokens),
    elapsedMs: count(data.elapsedMs),
    lastActivityAt: isoTimestamp(data.lastActivityAt),
    processAlive: typeof data.processAlive === "boolean" ? data.processAlive : undefined,
    waiting,
    sendMessage: kind === "send_message" ? normalizeSendMessage(data.sendMessage) ?? undefined : undefined
  };
  if (kind === "send_message" && !optional.sendMessage) return null;
  return {
    agentId, source: "claude", kind, at, seq,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined))
  };
}
