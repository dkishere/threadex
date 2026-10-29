import { normalizeSendMessage, type SendMessageRecord, type SubagentActivityPayload } from "../eventProtocol";

/** A SendMessage call as shown in a card: the normalized record plus the transcript item's "declined" verdict. */
export type SendMessageView = { record: SendMessageRecord; declined: boolean };

const STATUS_RANK: Record<SendMessageRecord["status"], number> = { pending: 0, sent: 1, failed: 1 };

export function isSendMessageItem(item: unknown): item is { tool: string; sendMessage?: unknown; status?: string } {
  return Boolean(item) && typeof item === "object" && (item as { tool?: unknown }).tool === "send_message";
}

/** The newer of two descriptions of one toolUseId: a settled result beats a pending one, later completion beats earlier. */
function preferred(left: SendMessageView, right: SendMessageView): SendMessageView {
  const rank = STATUS_RANK[right.record.status] - STATUS_RANK[left.record.status];
  if (rank !== 0) return rank > 0 ? right : left;
  return (right.record.completedAt ?? right.record.at) >= (left.record.completedAt ?? left.record.at) ? right : left;
}

/**
 * Collects SendMessage calls from a card's transcript items (`subagent` items with
 * `tool: "send_message"`) and from sub-agent `send_message` activity events. Live
 * frames, reload snapshots and activity events may describe the same call, so
 * records dedupe by `toolUseId`; older sessions carry no record and yield nothing.
 */
export function collectSendMessages(items: readonly unknown[], events: readonly SubagentActivityPayload[] = []): SendMessageView[] {
  const byId = new Map<string, SendMessageView>();
  const add = (view: SendMessageView) => {
    const previous = byId.get(view.record.toolUseId);
    byId.set(view.record.toolUseId, previous ? { ...preferred(previous, view), declined: previous.declined || view.declined } : view);
  };
  for (const item of items) {
    if (!isSendMessageItem(item)) continue;
    const record = normalizeSendMessage(item.sendMessage);
    if (record) add({ record, declined: item.status === "declined" });
  }
  for (const event of events) {
    if (event.kind !== "send_message" || !event.sendMessage) continue;
    const record = normalizeSendMessage(event.sendMessage);
    if (record) add({ record, declined: false });
  }
  return [...byId.values()].sort((left, right) => left.record.at.localeCompare(right.record.at));
}

export function sendMessageStatusLabel(view: SendMessageView) {
  if (view.declined) return "Declined";
  return view.record.status === "pending" ? "Sending" : view.record.status === "failed" ? "Failed" : "Sent";
}

export function sendMessageTone(view: SendMessageView): "running" | "done" | "error" {
  return view.declined || view.record.status === "failed" ? "error" : view.record.status === "pending" ? "running" : "done";
}

/** Long messages start collapsed. */
export const SEND_MESSAGE_COLLAPSE_CHARS = 280;
export const SEND_MESSAGE_COLLAPSE_LINES = 6;

export function isLongSendMessage(message: string) {
  return message.length > SEND_MESSAGE_COLLAPSE_CHARS || message.split("\n").length > SEND_MESSAGE_COLLAPSE_LINES;
}

/** Sender name: the main session, or the card name when the sender is the card's own agent. */
export function sendMessageSenderLabel(record: SendMessageRecord, ownAgentIds: readonly string[], ownName?: string) {
  if (record.sender.kind === "main") return "Main session";
  const agentId = record.sender.agentId;
  if (ownName && ownAgentIds.includes(agentId)) return ownName;
  return `Subagent ${agentId.slice(-8)}`;
}
