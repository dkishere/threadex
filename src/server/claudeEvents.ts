import {
  clipSendMessageText,
  SEND_MESSAGE_RESULT_MAX_CHARS,
  SEND_MESSAGE_TEXT_MAX_CHARS,
  type SendMessageRecord,
  type SubagentActivityPayload
} from "../eventProtocol";
import { structureAgentComment, truncateCommandOutput, type FileChange, type StreamItem } from "./codexEvents";

/**
 * Claude Agent SDK -> Threadex stream translation.
 *
 * The SDK emits Claude Code messages (system/init, stream_event deltas, whole
 * assistant messages, user tool_result messages and a terminal result). This
 * module turns them into the same StreamItem shape the Codex app-server path
 * produces, so the server, database and UI do not need to know which agent ran.
 * Messages are parsed defensively as plain records: the SDK is loaded lazily and
 * its types are not required to typecheck Threadex.
 */

export const CLAUDE_THREAD_PREFIX = "claude:";

export function toClaudeThreadId(sessionId: string) {
  return `${CLAUDE_THREAD_PREFIX}${sessionId}`;
}

export function fromClaudeThreadId(threadId: string | null | undefined): string | null {
  const value = threadId?.trim();
  if (!value?.startsWith(CLAUDE_THREAD_PREFIX)) return null;
  return value.slice(CLAUDE_THREAD_PREFIX.length) || null;
}

export function isClaudeThreadId(threadId: string | null | undefined) {
  return Boolean(threadId?.trim().startsWith(CLAUDE_THREAD_PREFIX));
}

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type ClaudeMapperOutput =
  | { kind: "item"; item: StreamItem }
  | { kind: "session"; sessionId: string; model: string | null; permissionMode: string | null }
  | {
      kind: "result";
      ok: boolean;
      subtype: string;
      text: string | null;
      errors: string[];
      usage: ClaudeUsage | null;
      costUsd: number | null;
      sessionId: string | null;
      durationMs: number | null;
      numTurns: number | null;
      // Client uuids of the prompts this turn consumed, including steers the
      // CLI folded into the running turn between tool rounds.
      userMessageUuids: string[];
      queuedTurnCount: number | null;
    }
  | { kind: "rate_limit"; status: string; resetsAt: string | null; info: Record<string, unknown> }
  | { kind: "api_error"; error: string; text: string }
  | { kind: "prompt_suggestion"; suggestion: string }
  | { kind: "subagent_usage"; agentId: string; tokenUsage: { last: SubagentTokenCounts; total: SubagentTokenCounts } }
  | { kind: "subagent_activity"; payload: SubagentActivityPayload };

/** Child agents keep reporting progress about every few seconds; the card needs far fewer rows. */
const SUBAGENT_PROGRESS_MIN_MS = 5_000;
/** Dedupe window for repeated assistant frames of one API response. */
const SUBAGENT_SEEN_MAX = 2_000;

type SubagentState = {
  seq: number;
  startedAt: number;
  lastActivityAt: number;
  lastEmitAt: number;
  lastProgressAt: number;
  progressSignature: string;
  taskId?: string;
  /** Survives the Agent tool_result: a background agent's result is only its launch receipt. */
  background: boolean;
  finished: boolean;
};

/** Codex-shaped counts so subagent samples share the Codex usage parser. */
type SubagentTokenCounts = { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number };

type TextKind = "text" | "thinking";

type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Agent/Task only: the model and effort the child actually runs with, when known. */
  actual?: { model?: string; effort?: string };
  /** Agent/Task only: the system prompt its agent definition gives the child (an actor's identity and memory). */
  actorContext?: string;
};

/** SDK agent definitions whose model, effort and system prompt the system fixes, keyed by subagent_type. */
export type ClaudeAgentDefinitions = Record<string, { model: string; effort?: string; prompt?: string }>;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SILENT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
const READ_OUTPUT_LIMIT = 0;
const SEARCH_OUTPUT_LIMIT = 8 * 1024;
const GENERIC_OUTPUT_LIMIT = 8 * 1024;
export const CLAUDE_TODO_ITEM_ID = "claude-todo-list";

export function isClaudeEditTool(name: string) {
  return EDIT_TOOLS.has(name);
}

export class ClaudeStreamMapper {
  private currentMessageId: string | null = null;
  private readonly streamBlockIds = new Map<string, Map<number, string>>();
  private readonly streamCounters = new Map<string, Record<TextKind, number>>();
  private readonly completedCounters = new Map<string, Record<TextKind, number>>();
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, ToolState>();
  private readonly declinedTools = new Set<string>();
  private sessionAnnounced = false;
  private readonly pendingTextIds = new Set<string>();
  /** Latest usage per API message id, grouped by the Agent call that ran it. */
  private readonly subagentMessageUsage = new Map<string, Map<string, ClaudeUsage>>();
  lastAgentText = "";
  private readonly subagents = new Map<string, SubagentState>();
  private readonly seenChildBlocks = new Set<string>();
  /** Names and runtime agent ids a SendMessage may address, mapped to the Agent/Task tool_use id. */
  private readonly agentAliases = new Map<string, string>();
  /** Main-session SendMessage calls by tool_use id. */
  private readonly sendMessages = new Map<string, SendMessageRecord>();
  /** Sub-agent SendMessage calls still awaiting their result, by tool_use id. */
  private readonly childSends = new Map<string, SendMessageRecord>();
  /** Test seam for the clock. */
  now = () => Date.now();

  /** `agents` are this run's SDK agent definitions; the runner strips model and effort from
   * Agent calls to them, so the definition, not the call input, is what the child runs with. */
  constructor(private readonly agents: ClaudeAgentDefinitions = {}) {}

  /** Tool calls the user declined render as declined rather than failed. */
  markDeclined(toolUseId: string) {
    this.declinedTools.add(toolUseId);
  }

  handle(message: unknown): ClaudeMapperOutput[] {
    const record = readObject(message);
    if (!record) return [];
    const type = readString(record.type);
    // Subagent frames never become main-thread items: their usage and a bounded,
    // deduplicated activity feed are reported against the Agent/Task tool_use id.
    const parentToolUseId = readString(record.parent_tool_use_id);
    if (parentToolUseId) {
      this.touchAgent(parentToolUseId);
      if (type === "user") return this.handleSubagentUser(parentToolUseId, record);
      return type === "assistant" ? this.handleSubagentAssistant(parentToolUseId, record) : [];
    }

    if (type === "system") return this.handleSystem(record);
    if (type === "stream_event") return this.handleStreamEvent(record);
    if (type === "assistant") return this.handleAssistant(record);
    if (type === "user") return this.handleUser(record);
    if (type === "result") return [
      ...this.classifyPendingText(record.subtype === "success" && record.is_error !== true ? "final_answer" : "commentary"),
      this.handleResult(record)
    ];
    if (type === "prompt_suggestion") {
      const suggestion = readString(record.suggestion)?.trim();
      return suggestion ? [{ kind: "prompt_suggestion", suggestion }] : [];
    }
    if (type === "rate_limit_event") {
      const info = readObject(record.rate_limit_info) ?? {};
      return [{
        kind: "rate_limit",
        status: readString(info.status) ?? "unknown",
        resetsAt: readTimestamp(info.resetsAt ?? info.resets_at),
        info
      }];
    }
    return [];
  }

  private handleSystem(record: Record<string, unknown>): ClaudeMapperOutput[] {
    const subtype = readString(record.subtype);
    if (subtype === "init") {
      const sessionId = readString(record.session_id);
      if (!sessionId || this.sessionAnnounced) return [];
      this.sessionAnnounced = true;
      return [{ kind: "session", sessionId, model: readString(record.model), permissionMode: readString(record.permissionMode) }];
    }
    if (subtype === "permission_denied") {
      // Auto-mode classifier (or deny rule) refused the call without asking: render it as declined, not failed.
      const toolUseId = readString(record.tool_use_id);
      if (toolUseId) this.markDeclined(toolUseId);
      return [];
    }
    if (subtype === "task_started" || subtype === "task_progress" || subtype === "task_notification") {
      return this.handleTask(subtype, record);
    }
    if (subtype === "compact_boundary") {
      const metadata = readObject(record.compact_metadata);
      const beforeTokens = readNumber(metadata?.pre_tokens);
      return [{
        kind: "item",
        item: {
          id: `compact:${readString(record.uuid) ?? Date.now()}`,
          eventType: "item.completed",
          itemType: "context_compaction",
          ...(beforeTokens !== null ? { beforeTokens } : {})
        }
      }];
    }
    return [];
  }

  private handleStreamEvent(record: Record<string, unknown>): ClaudeMapperOutput[] {
    const event = readObject(record.event);
    const eventType = readString(event?.type);
    if (!event || !eventType) return [];

    if (eventType === "message_start") {
      this.currentMessageId = readString(readObject(event.message)?.id) ?? readString(record.uuid);
      return [];
    }
    const messageId = this.currentMessageId;
    const index = readNumber(event.index);
    if (!messageId || index === null) return [];

    if (eventType === "content_block_start") {
      const block = readObject(event.content_block);
      const blockType = readString(block?.type);
      if (blockType !== "text" && blockType !== "thinking") return [];
      const ordinal = nextCounter(this.streamCounters, messageId, blockType);
      const itemId = textItemId(messageId, blockType, ordinal);
      mapFor(this.streamBlockIds, messageId).set(index, itemId);
      const initial = readString(blockType === "text" ? block?.text : block?.thinking) ?? "";
      this.texts.set(itemId, initial);
      return initial ? [this.textItem(itemId, blockType, "item.updated")] : [];
    }

    if (eventType === "content_block_delta") {
      const itemId = this.streamBlockIds.get(messageId)?.get(index);
      const delta = readObject(event.delta);
      const deltaType = readString(delta?.type);
      if (!itemId || !delta) return [];
      if (deltaType === "text_delta") {
        this.texts.set(itemId, (this.texts.get(itemId) ?? "") + (readString(delta.text) ?? ""));
        return [this.textItem(itemId, "text", "item.updated")];
      }
      if (deltaType === "thinking_delta") {
        this.texts.set(itemId, (this.texts.get(itemId) ?? "") + (readString(delta.thinking) ?? ""));
        return [this.textItem(itemId, "thinking", "item.updated")];
      }
    }
    return [];
  }

  private handleAssistant(record: Record<string, unknown>): ClaudeMapperOutput[] {
    const outputs: ClaudeMapperOutput[] = [];
    const message = readObject(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const apiError = readString(record.error);
    if (apiError) {
      outputs.push({ kind: "api_error", error: apiError, text: textFromContent(content) });
      return outputs;
    }
    const messageId = readString(message?.id) ?? readString(record.uuid) ?? `assistant-${Date.now()}`;

    for (const rawBlock of content) {
      const block = readObject(rawBlock);
      const blockType = readString(block?.type);
      if (!block || !blockType) continue;
      if (blockType === "text" || blockType === "thinking") {
        const ordinal = nextCounter(this.completedCounters, messageId, blockType);
        const itemId = textItemId(messageId, blockType, ordinal);
        const text = readString(blockType === "text" ? block.text : block.thinking) ?? this.texts.get(itemId) ?? "";
        this.texts.set(itemId, text);
        if (blockType === "text" && text.trim()) this.lastAgentText = text;
        if (blockType === "text" && text.trim()) this.pendingTextIds.add(itemId);
        if (text.trim()) outputs.push(this.textItem(itemId, blockType, "item.completed"));
      } else if (blockType === "tool_use") {
        outputs.push(...this.classifyPendingText("commentary"));
        const id = readString(block.id);
        const name = readString(block.name);
        if (!id || !name) continue;
        const tool: ToolState = { id, name, input: readObject(block.input) ?? {} };
        const definition = (name === "Agent" || name === "Task") ? this.agents[readString(tool.input.subagent_type) ?? ""] : undefined;
        if (definition) {
          tool.actual = { model: definition.model, ...(definition.effort ? { effort: definition.effort } : {}) };
          if (definition.prompt?.trim()) tool.actorContext = definition.prompt;
        }
        this.tools.set(id, tool);
        this.agentState(id);
        if (name === "Agent" || name === "Task") {
          const agentName = readString(tool.input.name)?.trim();
          if (agentName) this.agentAliases.set(agentName, id);
        }
        if (name === "SendMessage") {
          if (this.sendMessages.has(id)) continue;
          const record = this.sendMessageRecord(id, tool.input, { kind: "main" });
          this.sendMessages.set(id, record);
          outputs.push({ kind: "item", item: sendMessageItem(record, "item.started") });
          continue;
        }
        const item = toolStartItem(tool);
        if (item) outputs.push({ kind: "item", item });
      }
    }
    return outputs;
  }

  /** State for a running Agent/Task call, created on first sign of life; null for any other tool id. */
  private agentState(agentId: string): SubagentState | null {
    const existing = this.subagents.get(agentId);
    if (existing) return existing;
    const name = this.tools.get(agentId)?.name;
    if (name !== "Agent" && name !== "Task") return null;
    const now = this.now();
    const state: SubagentState = { seq: 0, startedAt: now, lastActivityAt: now, lastEmitAt: 0, lastProgressAt: 0, progressSignature: "", background: false, finished: false };
    this.subagents.set(agentId, state);
    return state;
  }

  private touchAgent(agentId: string) {
    const state = this.agentState(agentId);
    if (state && !state.finished) state.lastActivityAt = this.now();
  }

  private activity(agentId: string, kind: SubagentActivityPayload["kind"], extra: Partial<SubagentActivityPayload> = {}): ClaudeMapperOutput[] {
    const state = this.agentState(agentId);
    if (!state) return [];
    const now = this.now();
    state.seq += 1;
    state.lastEmitAt = now;
    const payload: SubagentActivityPayload = {
      agentId, source: "claude", kind, at: new Date(now).toISOString(), seq: state.seq,
      ...(state.taskId ? { taskId: state.taskId } : {}),
      elapsedMs: Math.max(0, now - state.startedAt),
      lastActivityAt: new Date(state.lastActivityAt).toISOString(),
      ...extra
    };
    return [{ kind: "subagent_activity", payload }];
  }

  private childContentActivity(agentId: string, messageId: string | null, message: Record<string, unknown> | null): ClaudeMapperOutput[] {
    const content = Array.isArray(message?.content) ? message.content : [];
    const outputs: ClaudeMapperOutput[] = [];
    content.forEach((rawBlock, index) => {
      const block = readObject(rawBlock);
      const type = readString(block?.type);
      if (!block || (type !== "text" && type !== "tool_use")) return;
      // One API response arrives as several frames that repeat earlier blocks.
      const key = `${agentId}:${type === "tool_use" ? readString(block.id) ?? `${messageId}:${index}` : `${messageId}:${index}`}`;
      if (this.seenChildBlocks.has(key)) return;
      if (type === "text") {
        const text = readString(block.text)?.trim();
        if (!text) return;
        this.rememberChildBlock(key);
        outputs.push(...this.activity(agentId, "message", { text: text.slice(0, 2000) }));
      } else {
        this.rememberChildBlock(key);
        const toolUseId = readString(block.id);
        if (readString(block.name) === "SendMessage" && toolUseId && !this.childSends.has(toolUseId)) {
          this.childSends.set(toolUseId, this.sendMessageRecord(toolUseId, readObject(block.input) ?? {}, { kind: "subagent", agentId }));
        }
        outputs.push(...this.activity(agentId, "tool", { toolName: readString(block.name) ?? undefined }));
      }
    });
    return outputs;
  }

  private sendMessageRecord(toolUseId: string, input: Record<string, unknown>, sender: SendMessageRecord["sender"]): SendMessageRecord {
    const to = readString(input.to)?.trim() || readString(input.recipient)?.trim() || "unknown";
    const summary = readString(input.summary)?.trim();
    const raw = readString(input.message) ?? (input.message !== undefined ? JSON.stringify(input.message) : "");
    const clipped = clipSendMessageText(raw, SEND_MESSAGE_TEXT_MAX_CHARS);
    const recipientAgentId = this.agentAliases.get(to) ?? (this.tools.has(to) ? to : undefined);
    return {
      toolUseId, sender, to,
      ...(recipientAgentId ? { recipientAgentId } : {}),
      ...(summary ? { summary: summary.slice(0, 500) } : {}),
      message: clipped.text,
      ...(clipped.omitted > 0 ? { messageTruncated: true as const, omittedMessageChars: clipped.omitted } : {}),
      status: "pending",
      at: new Date(this.now()).toISOString()
    };
  }

  /** Settles a SendMessage from its tool_result; a JSON `success: false` result counts as failed. */
  private settleSendMessage(record: SendMessageRecord, output: string, failed: boolean): SendMessageRecord {
    const parsed = parseJsonObject(output);
    const resumed = readString(parsed?.resumedAgentId);
    const recipientAgentId = record.recipientAgentId ?? (resumed ? this.agentAliases.get(resumed) : undefined);
    const resultSummary = output.trim() ? clipSendMessageText(output.trim(), SEND_MESSAGE_RESULT_MAX_CHARS).text : "";
    return {
      ...record,
      ...(recipientAgentId ? { recipientAgentId } : {}),
      status: failed || parsed?.success === false ? "failed" : "sent",
      ...(resultSummary ? { resultSummary } : {}),
      completedAt: new Date(this.now()).toISOString()
    };
  }

  private handleSubagentUser(agentId: string, record: Record<string, unknown>): ClaudeMapperOutput[] {
    const content = Array.isArray(readObject(record.message)?.content) ? readObject(record.message)!.content as unknown[] : [];
    const outputs: ClaudeMapperOutput[] = [];
    for (const rawBlock of content) {
      const block = readObject(rawBlock);
      const toolUseId = readString(block?.tool_use_id);
      const pending = toolUseId ? this.childSends.get(toolUseId) : undefined;
      if (readString(block?.type) !== "tool_result" || !toolUseId || !pending) continue;
      this.childSends.delete(toolUseId);
      const sendMessage = this.settleSendMessage(pending, toolResultText(block?.content), block?.is_error === true);
      outputs.push(...this.activity(agentId, "send_message", { sendMessage }));
    }
    return outputs;
  }

  /** A sub-agent that ends before its SendMessage result arrives still reports the message, as pending. */
  private flushChildSends(agentId: string): ClaudeMapperOutput[] {
    const outputs: ClaudeMapperOutput[] = [];
    for (const [toolUseId, pending] of this.childSends) {
      if (pending.sender.kind !== "subagent" || pending.sender.agentId !== agentId) continue;
      this.childSends.delete(toolUseId);
      outputs.push(...this.activity(agentId, "send_message", { sendMessage: pending }));
    }
    return outputs;
  }

  private rememberChildBlock(key: string) {
    this.seenChildBlocks.add(key);
    if (this.seenChildBlocks.size > SUBAGENT_SEEN_MAX) {
      const oldest = this.seenChildBlocks.values().next().value;
      if (oldest !== undefined) this.seenChildBlocks.delete(oldest);
    }
  }

  private handleTask(subtype: string, record: Record<string, unknown>): ClaudeMapperOutput[] {
    const agentId = readString(record.tool_use_id);
    if (!agentId) return [];
    const state = this.agentState(agentId);
    if (!state) return [];
    const taskId = readString(record.task_id) ?? undefined;
    if (taskId) state.taskId = taskId;
    const description = readString(record.description) ?? undefined;
    if (subtype === "task_started") {
      if (record.is_backgrounded === true) state.background = true;
      if (state.seq > 0 || state.finished) return [];
      return this.activity(agentId, "started", { ...(description ? { description: description.slice(0, 500) } : {}) });
    }
    if (state.finished) return [];
    state.lastActivityAt = this.now();
    if (subtype === "task_progress") {
      state.background = true;
      const usage = readObject(record.usage);
      const toolUses = readNumber(usage?.tool_uses);
      const totalTokens = readNumber(usage?.total_tokens);
      const toolName = readString(record.last_tool_name) ?? undefined;
      const signature = `${toolUses ?? ""}|${toolName ?? ""}|${description ?? ""}`;
      const now = this.now();
      if (signature === state.progressSignature || now - state.lastProgressAt < SUBAGENT_PROGRESS_MIN_MS) return [];
      state.progressSignature = signature;
      state.lastProgressAt = now;
      return this.activity(agentId, "progress", {
        ...(description ? { description: description.slice(0, 500) } : {}),
        ...(toolName ? { toolName } : {}),
        ...(readString(record.summary) ? { text: (readString(record.summary) ?? "").slice(0, 2000) } : {}),
        ...(toolUses !== null ? { toolUses } : {}),
        ...(totalTokens !== null ? { totalTokens } : {})
      });
    }
    // task_notification: the background task ended for good.
    const rawStatus = readString(record.status);
    const status = rawStatus === "failed" || rawStatus === "stopped" ? rawStatus : "completed";
    return this.finishAgent(agentId, status, readString(record.summary) ?? undefined);
  }

  private finishAgent(agentId: string, status: "completed" | "failed" | "stopped", summary?: string): ClaudeMapperOutput[] {
    const state = this.agentState(agentId);
    const tool = this.tools.get(agentId);
    if (!state || !tool || state.finished) return [];
    const flushed = this.flushChildSends(agentId);
    state.finished = true;
    return [
      ...flushed,
      ...this.activity(agentId, "finished", { status, ...(summary ? { text: summary.slice(0, 2000) } : {}) }),
      // The launch receipt completed the card once; close it for real so a live stream stops showing it as running.
      { kind: "item", item: subagentItem(tool, "item.completed", status, summary) }
    ];
  }

  /**
   * Liveness beat for every running Agent/Task that has been quiet for `quietMs`.
   * Beats stop once an agent shows no real sign of life for `stallMs`, so a hung agent does not
   * keep the runner log moving forever; one last beat marks the point where it went quiet.
   */
  heartbeats(options: { quietMs: number; stallMs: number; processAlive: boolean; waiting?: "approval" | "input" }): ClaudeMapperOutput[] {
    const now = this.now();
    const outputs: ClaudeMapperOutput[] = [];
    for (const [agentId, state] of this.subagents) {
      if (state.finished || now - state.lastEmitAt < options.quietMs) continue;
      const stalled = now - state.lastActivityAt >= options.stallMs;
      if (stalled && state.lastEmitAt > state.lastActivityAt + options.stallMs) continue;
      outputs.push(...this.activity(agentId, options.waiting ? "waiting" : "heartbeat", {
        processAlive: options.processAlive,
        ...(options.waiting ? { waiting: options.waiting } : {})
      }));
    }
    return outputs;
  }

  private handleSubagentAssistant(agentId: string, record: Record<string, unknown>): ClaudeMapperOutput[] {
    const message = readObject(record.message);
    const messageId = readString(message?.id);
    const usage = readUsage(message?.usage);
    // The child's own API responses name the model it really runs on; refresh its card once it changes.
    // Synthetic messages (e.g. "<synthetic>") are not API responses and name no real model.
    const observedModel = readString(message?.model)?.startsWith("<") ? undefined : readString(message?.model);
    const tool = this.tools.get(agentId);
    const outputs: ClaudeMapperOutput[] = [];
    // Once the task ended, a late frame must not reopen the finished card.
    if (observedModel && tool && tool.actual?.model !== observedModel) {
      tool.actual = { ...tool.actual, model: observedModel };
      if (!this.subagents.get(agentId)?.finished) outputs.push({ kind: "item", item: subagentItem(tool, "item.updated", "inProgress") });
    }
    outputs.push(...this.childContentActivity(agentId, messageId, message));
    if (!messageId || !usage) return outputs;
    // One API response arrives as several frames (one per content block) that repeat its usage.
    const messages = mapFor(this.subagentMessageUsage, agentId);
    const previous = messages.get(messageId);
    if (previous && JSON.stringify(previous) === JSON.stringify(usage)) return outputs;
    messages.set(messageId, usage);
    const total: ClaudeUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    for (const value of messages.values()) {
      total.inputTokens += value.inputTokens;
      total.outputTokens += value.outputTokens;
      total.cacheReadInputTokens += value.cacheReadInputTokens;
      total.cacheCreationInputTokens += value.cacheCreationInputTokens;
    }
    return [...outputs, { kind: "subagent_usage", agentId, tokenUsage: { last: subagentTokenCounts(usage), total: subagentTokenCounts(total) } }];
  }

  private handleUser(record: Record<string, unknown>): ClaudeMapperOutput[] {
    const message = readObject(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const outputs: ClaudeMapperOutput[] = [];
    for (const rawBlock of content) {
      const block = readObject(rawBlock);
      if (readString(block?.type) !== "tool_result") continue;
      const toolUseId = readString(block?.tool_use_id);
      const tool = toolUseId ? this.tools.get(toolUseId) : undefined;
      if (!tool) continue;
      const sent = this.sendMessages.get(tool.id);
      if (sent) {
        if (sent.status !== "pending") continue;
        const declined = this.declinedTools.has(tool.id);
        const settled = this.settleSendMessage(sent, toolResultText(block?.content), declined || block?.is_error === true);
        this.sendMessages.set(tool.id, settled);
        outputs.push({ kind: "item", item: sendMessageItem(settled, "item.completed", declined) });
        continue;
      }
      if (tool.name === "Agent" || tool.name === "Task") this.learnAgentId(tool.id, toolResultText(block?.content), readObject(record.tool_use_result));
      const item = toolCompletedItem(tool, {
        output: toolResultText(block?.content),
        isError: block?.is_error === true,
        declined: this.declinedTools.has(tool.id),
        detail: readObject(record.tool_use_result)
      });
      if (item) outputs.push({ kind: "item", item });
      outputs.push(...this.endForegroundAgent(tool.id, record, toolResultText(block?.content), block?.is_error === true));
    }
    return outputs;
  }

  /** The runtime agent id a later SendMessage addresses ("agentId: …" in the launch receipt or result). */
  private learnAgentId(toolUseId: string, output: string, detail: Record<string, unknown> | null) {
    const agentId = readString(detail?.agentId) ?? /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(output)?.[1];
    if (agentId) this.agentAliases.set(agentId, toolUseId);
  }

  /** A foreground Agent call ends with its tool_result; a background launch's result is only a receipt. */
  private endForegroundAgent(agentId: string, record: Record<string, unknown>, output: string, isError: boolean): ClaudeMapperOutput[] {
    const state = this.subagents.get(agentId);
    if (!state || state.finished) return [];
    const detail = readObject(record.tool_use_result);
    const asyncLaunch = state.background || /async agent launched/i.test(output) ||
      readString(detail?.status) === "async_launched" || detail?.isAsync === true;
    if (asyncLaunch) {
      state.background = true;
      return [];
    }
    const flushed = this.flushChildSends(agentId);
    state.finished = true;
    return [...flushed, ...this.activity(agentId, "finished", { status: isError ? "failed" : "completed" })];
  }

  private handleResult(record: Record<string, unknown>): ClaudeMapperOutput {
    const subtype = readString(record.subtype) ?? "unknown";
    const isError = record.is_error === true || subtype !== "success";
    const text = readString(record.result);
    if (!isError && text?.trim()) this.lastAgentText = text;
    const errors = Array.isArray(record.errors)
      ? record.errors.flatMap((value) => typeof value === "string" ? [value] : [])
      : [];
    return {
      kind: "result",
      ok: !isError,
      subtype,
      text,
      errors: errors.length > 0 || !isError ? errors : [text?.trim() || `Claude turn ended with ${subtype}.`],
      usage: readUsage(record.usage),
      costUsd: readNumber(record.total_cost_usd),
      sessionId: readString(record.session_id),
      durationMs: readNumber(record.duration_ms),
      numTurns: readNumber(record.num_turns),
      userMessageUuids: Array.isArray(record.user_message_uuids)
        ? record.user_message_uuids.flatMap((value) => typeof value === "string" ? [value] : [])
        : readString(record.user_message_uuid) ? [readString(record.user_message_uuid) as string] : [],
      queuedTurnCount: readNumber(record.queued_turn_count)
    };
  }

  private textItem(itemId: string, kind: TextKind, eventType: StreamItem["eventType"]): ClaudeMapperOutput {
    const text = this.texts.get(itemId) ?? "";
    return {
      kind: "item",
      item: kind === "text"
        ? { id: itemId, eventType, itemType: "agent_message", text }
        : { id: itemId, eventType, itemType: "reasoning", text }
    };
  }

  // The SDK can deliver text and tool blocks separately, without a phase.
  // Keep their stable IDs and classify text once the following action is known.
  private classifyPendingText(phase: "commentary" | "final_answer"): ClaudeMapperOutput[] {
    const outputs: ClaudeMapperOutput[] = [];
    for (const id of this.pendingTextIds) {
      const text = this.texts.get(id) ?? "";
      const comment = phase === "commentary" ? structureAgentComment(text) : undefined;
      outputs.push({ kind: "item", item: {
        id, eventType: "item.completed", itemType: "agent_message", text, phase,
        ...(comment ? { comment } : {})
      } });
    }
    this.pendingTextIds.clear();
    return outputs;
  }
}

function toolStartItem(tool: ToolState): StreamItem | undefined {
  if (SILENT_TOOLS.has(tool.name)) return undefined;
  const { id, name, input } = tool;
  if (name === "TodoWrite") return todoItem(input, "item.completed");
  if (name === "WebSearch" || name === "WebFetch") {
    return { id, eventType: "item.started", itemType: "web_search", query: readString(input.query) ?? readString(input.url) ?? "" };
  }
  if (name === "Task" || name === "Agent") {
    return subagentItem(tool, "item.started", "inProgress");
  }
  if (EDIT_TOOLS.has(name)) {
    return { id, eventType: "item.started", itemType: "file_change", changes: fileChangesFromTool(tool, null), status: "inProgress" };
  }
  return { id, eventType: "item.started", itemType: "command_execution", command: commandLabel(tool), aggregatedOutput: "", status: "inProgress" };
}

function toolCompletedItem(
  tool: ToolState,
  result: { output: string; isError: boolean; declined: boolean; detail: Record<string, unknown> | null }
): StreamItem | undefined {
  if (SILENT_TOOLS.has(tool.name) || tool.name === "TodoWrite") return undefined;
  const { id, name } = tool;
  const status = result.declined ? "declined" : result.isError ? "failed" : "completed";
  if (name === "WebSearch" || name === "WebFetch") {
    return { id, eventType: "item.completed", itemType: "web_search", query: readString(tool.input.query) ?? readString(tool.input.url) ?? "" };
  }
  if (name === "Task" || name === "Agent") {
    return subagentItem(tool, "item.completed", status, result.output);
  }
  if (EDIT_TOOLS.has(name)) {
    return { id, eventType: "item.completed", itemType: "file_change", changes: fileChangesFromTool(tool, result.detail), status };
  }
  const limit = name === "Read" ? READ_OUTPUT_LIMIT
    : name === "Grep" || name === "Glob" || name === "LS" ? SEARCH_OUTPUT_LIMIT
    : name === "Bash" ? undefined
    : GENERIC_OUTPUT_LIMIT;
  const rawOutput = limit === undefined ? result.output : clip(result.output, limit);
  const output = truncateCommandOutput(rawOutput);
  return {
    id,
    eventType: "item.completed",
    itemType: "command_execution",
    command: commandLabel(tool),
    aggregatedOutput: output.text,
    ...(output.truncated ? { outputTruncated: true, omittedOutputChars: output.omittedChars } : {}),
    ...(name === "Bash" && !result.declined ? { exitCode: result.isError ? 1 : 0 } : {}),
    status
  };
}

function todoItem(input: Record<string, unknown>, eventType: StreamItem["eventType"]): StreamItem {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return {
    id: CLAUDE_TODO_ITEM_ID,
    eventType,
    itemType: "todo_list",
    items: todos.flatMap((value) => {
      const todo = readObject(value);
      const text = readString(todo?.content) ?? readString(todo?.activeForm);
      if (!text) return [];
      const rawStatus = readString(todo?.status);
      const status = rawStatus === "completed" || rawStatus === "in_progress" ? rawStatus : "pending";
      return [{ text, completed: status === "completed", status }];
    })
  };
}

function subagentItem(tool: ToolState, eventType: StreamItem["eventType"], status: string, output?: string): StreamItem {
  const label = readString(tool.input.description) ?? undefined;
  const agentStatus = status === "inProgress" ? "running" : status;
  return {
    id: tool.id,
    eventType,
    itemType: "subagent",
    tool: "spawn_agent",
    status,
    ...(label ? { label } : {}),
    receiverThreadIds: [],
    ...(readString(tool.input.prompt) ? { prompt: readString(tool.input.prompt) ?? undefined } : {}),
    ...(readString(tool.input.model) ? { model: readString(tool.input.model) ?? undefined } : {}),
    ...(readString(tool.input.effort) || readString(tool.input.reasoning_effort)
      ? { reasoningEffort: readString(tool.input.effort) ?? readString(tool.input.reasoning_effort) ?? undefined }
      : {}),
    ...(tool.actual?.model ? { actualModel: tool.actual.model } : {}),
    ...(tool.actual?.effort ? { actualReasoningEffort: tool.actual.effort } : {}),
    // Every emission carries it: a later card event replaces the earlier one.
    ...(tool.actorContext ? { actorContext: tool.actorContext } : {}),
    agents: [{
      id: tool.id,
      name: readString(tool.input.subagent_type) ?? "agent",
      status: agentStatus,
      ...(output?.trim() ? { message: clip(output.trim(), 4000) } : {})
    }]
  };
}

/** Main-session SendMessage card: a `subagent` item addressed to the recipient's Agent card when known. */
function sendMessageItem(record: SendMessageRecord, eventType: StreamItem["eventType"], declined = false): StreamItem {
  const status = declined ? "declined" : record.status === "pending" ? "inProgress" : record.status === "sent" ? "completed" : "failed";
  return {
    id: record.toolUseId,
    eventType,
    itemType: "subagent",
    tool: "send_message",
    status,
    ...(record.summary ? { label: record.summary } : {}),
    receiverThreadIds: record.recipientAgentId ? [record.recipientAgentId] : [],
    prompt: record.message,
    sendMessage: record,
    agents: [{
      id: record.recipientAgentId ?? record.to,
      name: record.to,
      status: status === "inProgress" ? "running" : status,
      ...(record.resultSummary ? { message: record.resultSummary } : {})
    }]
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return readObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function fileChangesFromTool(tool: ToolState, detail: Record<string, unknown> | null): FileChange[] {
  const input = tool.input;
  const path = readString(input.file_path) ?? readString(input.notebook_path) ?? readString(detail?.filePath) ?? "";
  const originalFile = readString(detail?.originalFile);

  if (tool.name === "Write") {
    const created = readString(detail?.type) === "create" || (detail !== null && originalFile === null);
    return [{
      path,
      kind: created ? "add" : "update",
      ...(originalFile !== null ? { before: originalFile } : {}),
      after: readString(input.content) ?? ""
    }];
  }

  if (tool.name === "Edit") {
    const oldString = readString(input.old_string) ?? "";
    const newString = readString(input.new_string) ?? "";
    if (originalFile !== null && oldString) {
      return [{ path, kind: "update", before: originalFile, after: applyEdit(originalFile, oldString, newString, input.replace_all === true) }];
    }
    return [{ path, kind: "update", before: oldString, after: newString }];
  }

  if (tool.name === "MultiEdit") {
    const edits = (Array.isArray(input.edits) ? input.edits : []).flatMap((value) => {
      const edit = readObject(value);
      const oldString = readString(edit?.old_string);
      return oldString === null ? [] : [{ oldString, newString: readString(edit?.new_string) ?? "", replaceAll: edit?.replace_all === true }];
    });
    if (originalFile !== null && edits.length > 0) {
      const after = edits.reduce((text, edit) => applyEdit(text, edit.oldString, edit.newString, edit.replaceAll), originalFile);
      return [{ path, kind: "update", before: originalFile, after }];
    }
    return edits.map((edit) => ({ path, kind: "update", before: edit.oldString, after: edit.newString }));
  }

  // NotebookEdit and future edit tools: identify the file; the turn's Git diff carries the content.
  return [{ path, kind: "update" }];
}

function applyEdit(text: string, oldString: string, newString: string, replaceAll: boolean) {
  if (!oldString) return text;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

function commandLabel(tool: ToolState) {
  const input = tool.input;
  switch (tool.name) {
    case "Bash":
      return readString(input.command) ?? "";
    case "Read": {
      const path = readString(input.file_path) ?? "";
      const offset = readNumber(input.offset);
      const limit = readNumber(input.limit);
      return `Read ${path}${offset !== null || limit !== null ? ` (${offset ?? 1}${limit !== null ? `, ${limit} lines` : ""})` : ""}`;
    }
    case "Grep":
      return `Grep ${JSON.stringify(readString(input.pattern) ?? "")}${readString(input.path) ? ` in ${readString(input.path)}` : ""}${readString(input.glob) ? ` (${readString(input.glob)})` : ""}`;
    case "Glob":
      return `Glob ${readString(input.pattern) ?? ""}${readString(input.path) ? ` in ${readString(input.path)}` : ""}`;
    case "LS":
      return `LS ${readString(input.path) ?? ""}`;
    default:
      return `${tool.name} ${clip(JSON.stringify(input), 300)}`.trim();
  }
}

export function summarizeClaudeToolForApproval(name: string, input: Record<string, unknown>) {
  return commandLabel({ id: "", name, input });
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((value) => {
    const block = readObject(value);
    if (readString(block?.type) === "text") return readString(block?.text) ?? "";
    if (readString(block?.type) === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

function textFromContent(content: unknown[]) {
  return content.map((value) => {
    const block = readObject(value);
    return readString(block?.type) === "text" ? readString(block?.text) ?? "" : "";
  }).filter(Boolean).join("\n");
}

function readUsage(value: unknown): ClaudeUsage | null {
  const usage = readObject(value);
  if (!usage) return null;
  return {
    inputTokens: readNumber(usage.input_tokens) ?? 0,
    outputTokens: readNumber(usage.output_tokens) ?? 0,
    cacheReadInputTokens: readNumber(usage.cache_read_input_tokens) ?? 0,
    cacheCreationInputTokens: readNumber(usage.cache_creation_input_tokens) ?? 0
  };
}

/** Same input convention as the turn's own Claude tokenIn: cache reads and writes are input. */
function subagentTokenCounts(usage: ClaudeUsage): SubagentTokenCounts {
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return { inputTokens, cachedInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens,
    totalTokens: inputTokens + usage.outputTokens };
}

function textItemId(messageId: string, kind: TextKind, ordinal: number) {
  return `${messageId}:${kind}:${ordinal}`;
}

function nextCounter(counters: Map<string, Record<TextKind, number>>, messageId: string, kind: TextKind) {
  const current = counters.get(messageId) ?? { text: 0, thinking: 0 };
  counters.set(messageId, current);
  const value = current[kind];
  current[kind] += 1;
  return value;
}

function mapFor<K, V>(maps: Map<string, Map<K, V>>, key: string) {
  const existing = maps.get(key);
  if (existing) return existing;
  const created = new Map<K, V>();
  maps.set(key, created);
  return created;
}

function clip(value: string, limit: number) {
  if (limit <= 0) return "";
  return value.length > limit ? `${value.slice(0, limit)}\n[… ${value.length - limit} more characters]` : value;
}

function readTimestamp(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
