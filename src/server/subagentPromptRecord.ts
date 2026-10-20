import { createHash } from "node:crypto";
import type { StreamItem } from "./codexEvents";

export function resolveSubagentPromptTarget(value: unknown, items: unknown[]): string {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input !== "object") throw new Error("A child threadId or taskName is required.");
  if (typeof input.threadId === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(input.threadId)) return input.threadId;
  if (typeof input.taskName !== "string" || !/^\/root(?:\/[A-Za-z0-9_-]+)+$/.test(input.taskName)) {
    throw new Error("Use the child threadId or the full taskName returned by spawn_agent (for example /root/check).");
  }
  const ids = new Set<string>();
  for (const candidate of items) {
    const item = candidate as Extract<StreamItem, { itemType: "subagent" }>;
    if (!item || item.itemType !== "subagent" || item.label !== input.taskName) continue;
    for (const id of item.receiverThreadIds ?? []) ids.add(id);
  }
  if (ids.size !== 1) throw new Error(ids.size ? "Task name is ambiguous; use the child threadId." : "Task not found yet; retry after the native child start event arrives.");
  return [...ids][0];
}

/** A native V2 spawn returns a task name, while its event supplies the UUID. */
export class SubagentPromptReminder {
  private delivered = new Set<string>();
  async observe(item: StreamItem, rootThreadId: string,
    inject: (text: string) => Promise<void>) {
    if (item.itemType !== "subagent" || item.originThreadId !== rootThreadId || item.prompt
        || !(item.tool === "activity" && item.status === "started")) return;
    const child = item.receiverThreadIds[0];
    if (!child || child === rootThreadId || this.delivered.has(child)) return;
    this.delivered.add(child);
    try {
      await inject([
        "Threadex has received the native child start event. Save the exact plaintext task you just sent using session-inspector record_subagent_prompt now.",
        `Child identity (data): ${JSON.stringify({ threadId: child, taskName: item.label })}`,
        "Use kind=spawn and the original prompt, preserving its language and formatting. Native spawn may return only task_name; this event supplies the UUID. Recording does not dispatch or repeat the task. Never substitute a summary or invent unavailable text."
      ].join("\n"));
    } catch (error) { this.delivered.delete(child); throw error; }
  }
}

export function subagentPromptRecord(value: unknown): Extract<StreamItem, { itemType: "subagent" }> {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input.threadId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input.threadId)
      || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 64000
      || !["spawn", "followup"].includes(String(input.kind))) {
    throw new Error("threadId, kind (spawn/followup), and a nonempty prompt up to 64000 characters are required.");
  }
  return {
    id: `prompt-record:${input.threadId}:${createHash("sha256").update(`${input.kind}\0${input.prompt}`).digest("hex").slice(0, 24)}`,
    itemType: "subagent", eventType: "item.completed", tool: `record_${input.kind}_prompt`,
    status: "", receiverThreadIds: [input.threadId], agents: [], prompt: input.prompt
  };
}
