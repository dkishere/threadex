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
    }
  | { kind: "rate_limit"; status: string; resetsAt: string | null; info: Record<string, unknown> }
  | { kind: "api_error"; error: string; text: string }
  | { kind: "prompt_suggestion"; suggestion: string };

type TextKind = "text" | "thinking";

type ToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

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
  lastAgentText = "";

  /** Tool calls the user declined render as declined rather than failed. */
  markDeclined(toolUseId: string) {
    this.declinedTools.add(toolUseId);
  }

  handle(message: unknown): ClaudeMapperOutput[] {
    const record = readObject(message);
    if (!record) return [];
    const type = readString(record.type);
    // Subagent internals stay inside their Agent/Task card in this first version.
    if (readString(record.parent_tool_use_id)) return [];

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
        this.tools.set(id, tool);
        const item = toolStartItem(tool);
        if (item) outputs.push({ kind: "item", item });
      }
    }
    return outputs;
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
      const item = toolCompletedItem(tool, {
        output: toolResultText(block?.content),
        isError: block?.is_error === true,
        declined: this.declinedTools.has(tool.id),
        detail: readObject(record.tool_use_result)
      });
      if (item) outputs.push({ kind: "item", item });
    }
    return outputs;
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
      numTurns: readNumber(record.num_turns)
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
    agents: [{
      id: tool.id,
      name: readString(tool.input.subagent_type) ?? "agent",
      status: agentStatus,
      ...(output?.trim() ? { message: clip(output.trim(), 4000) } : {})
    }]
  };
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
