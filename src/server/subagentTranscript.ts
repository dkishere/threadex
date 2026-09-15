import {
  normalizeStructuredAgentComment,
  streamItemFromThreadItem,
  truncateCommandOutput,
  type FileChange,
  type StreamItem
} from "./codexEvents";

export type SubagentTranscriptTurn = {
  id: string;
  status: string;
  items: StreamItem[];
};

export type SubagentTranscriptResponse = {
  sessionId: string;
  threadId: string;
  turns: SubagentTranscriptTurn[];
};

type AppServerThread = {
  id: string;
  sessionId: string | null;
  parentThreadId: string | null;
  path: string | null;
  turns: unknown[];
};

const MAX_ANCESTOR_HOPS = 16;
const MAX_TURNS = 64;
const MAX_ITEMS = 512;
const MAX_RESPONSE_ITEM_CHARS = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_SHORT_TEXT_CHARS = 16 * 1024;
const MAX_FILE_CHANGES = 100;
const MAX_FILE_CHANGE_TEXT_CHARS = 8 * 1024;
const MAX_TODO_ITEMS = 200;
const MAX_SUBAGENT_RECEIVERS = 100;
const MAX_SUBAGENT_AGENTS = 100;

const fileChangeTextFields: Array<keyof Omit<FileChange, "path" | "kind">> = [
  "before",
  "after",
  "beforeText",
  "afterText",
  "beforeContent",
  "afterContent",
  "oldContent",
  "newContent",
  "previousContent",
  "currentContent",
  "original",
  "updated",
  "diff",
  "patch",
  "unifiedDiff"
];

export function readAppServerThread(result: unknown): AppServerThread | null {
  const wrapper = readObject(result);
  const thread = readObject(wrapper?.thread);
  const id = boundedIdentifier(thread?.id);
  if (!thread || !id) {
    return null;
  }
  return {
    id,
    sessionId: boundedIdentifier(thread.sessionId),
    parentThreadId: boundedIdentifier(thread.parentThreadId),
    path: boundedString(thread.path, 4_096) || null,
    turns: Array.isArray(thread.turns) ? thread.turns : []
  };
}

export async function subagentThreadBelongsToRoot(input: {
  rootThreadId: string;
  requestedThreadId: string;
  requestedThreadResult: unknown;
  readThread: (threadId: string) => Promise<unknown>;
}): Promise<boolean> {
  const rootThreadId = boundedIdentifier(input.rootThreadId);
  const requestedThreadId = boundedIdentifier(input.requestedThreadId);
  const requestedThread = readAppServerThread(input.requestedThreadResult);
  if (!rootThreadId || !requestedThreadId || !requestedThread || requestedThread.id !== requestedThreadId) {
    return false;
  }
  if (requestedThreadId === rootThreadId) {
    return false;
  }

  const sessionTreeId = requestedThread.sessionId;
  const seen = new Set<string>([requestedThreadId]);
  let parentThreadId = requestedThread.parentThreadId;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
    if (!parentThreadId || seen.has(parentThreadId)) {
      return false;
    }
    if (parentThreadId === rootThreadId) {
      return true;
    }
    seen.add(parentThreadId);
    const parentThread = readAppServerThread(await input.readThread(parentThreadId));
    if (!parentThread || parentThread.id !== parentThreadId) {
      return false;
    }
    if (sessionTreeId && parentThread.sessionId && parentThread.sessionId !== sessionTreeId) {
      return false;
    }
    parentThreadId = parentThread.parentThreadId;
  }
  return false;
}

export function normalizeSubagentTranscript(input: {
  sessionId: string;
  threadId: string;
  threadReadResult: unknown;
  additionalItemsByTurn?: Record<string, unknown[]>;
  liveItemsByTurn?: Record<string, unknown[]>;
}): SubagentTranscriptResponse {
  const thread = readAppServerThread(input.threadReadResult);
  if (!thread || thread.id !== input.threadId) {
    throw new Error("Codex app-server returned an unexpected subagent thread.");
  }

  const turns: SubagentTranscriptTurn[] = [];
  const turnsById = new Map<string, SubagentTranscriptTurn>();
  for (const rawTurn of thread.turns.slice(-MAX_TURNS)) {
    const turn = readObject(rawTurn);
    const turnId = boundedIdentifier(turn?.id);
    if (!turn || !turnId) {
      continue;
    }
    const items = (Array.isArray(turn.items) ? turn.items : []).flatMap((rawItem) => {
      const item = transcriptItemFromThreadItem(rawItem);
      if (!item) return [];
      const normalized = normalizeTranscriptItem({
        ...item,
        originThreadId: input.threadId,
        originTurnId: turnId
      });
      return normalized ? [normalized] : [];
    });
    const normalizedTurn = {
      id: turnId,
      status: boundedString(turn.status, 128) || "completed",
      items: mergeItemsById(items)
    };
    turns.push(normalizedTurn);
    turnsById.set(turnId, normalizedTurn);
  }

  for (const [rawTurnId, rawItems] of Object.entries(input.additionalItemsByTurn ?? {})) {
    const turnId = boundedIdentifier(rawTurnId);
    if (!turnId || !Array.isArray(rawItems)) continue;
    let turn = turnsById.get(turnId);
    if (!turn) {
      turn = { id: turnId, status: "completed", items: [] };
      turns.push(turn);
      turnsById.set(turnId, turn);
    }
    const additionalItems = rawItems.flatMap((rawItem) => {
      const record = readObject(rawItem);
      const normalized = normalizeTranscriptItem(record
        ? { ...record, originThreadId: input.threadId, originTurnId: turnId }
        : rawItem);
      return normalized ? [normalized] : [];
    });
    turn.items = mergeItemsById([...turn.items, ...additionalItems]);
  }

  const attributedLiveItems = Object.values(input.liveItemsByTurn ?? {})
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => readString(readObject(item)?.originThreadId) === input.threadId)
    .sort(compareStoredLiveItems);

  for (const rawItem of attributedLiveItems) {
    const item = normalizeTranscriptItem(rawItem);
    if (!item || item.originThreadId !== input.threadId) {
      continue;
    }
    const originTurnId = boundedIdentifier(item.originTurnId) ?? `${input.threadId}:live`;
    let turn = turnsById.get(originTurnId);
    if (!turn) {
      turn = {
        id: originTurnId,
        status: item.eventType === "item.completed" ? "completed" : "inProgress",
        items: []
      };
      turns.push(turn);
      turnsById.set(originTurnId, turn);
    } else if (item.eventType !== "item.completed") {
      turn.status = "inProgress";
    }
    turn.items = mergeItemsById([...turn.items, item]);
  }

  return {
    sessionId: input.sessionId,
    threadId: input.threadId,
    turns: boundTranscriptTurns(turns)
  };
}

function transcriptItemFromThreadItem(value: unknown): StreamItem | null {
  const parsed = streamItemFromThreadItem(value, "item.completed");
  if (parsed) return parsed;

  const item = readObject(value);
  const id = boundedIdentifier(item?.id);
  if (!item || !id || readString(item.type) !== "userMessage") {
    return null;
  }
  const text = (Array.isArray(item.content) ? item.content : [])
    .flatMap((content) => {
      const record = readObject(content);
      return readString(record?.type) === "text" && readString(record?.text)
        ? [readString(record?.text) ?? ""]
        : [];
    })
    .join("\n")
    .trim();
  if (!text) return null;
  return {
    id,
    eventType: "item.completed",
    itemType: "agent_message",
    phase: "delegated_task",
    text
  };
}

function normalizeTranscriptItem(value: unknown): StreamItem | null {
  const item = readObject(value);
  const id = boundedIdentifier(item?.id);
  const itemType = readString(item?.itemType);
  if (!item || !id || !itemType) {
    return null;
  }
  const eventType = normalizeEventType(item.eventType);
  const originThreadId = boundedIdentifier(item.originThreadId);
  const originTurnId = boundedIdentifier(item.originTurnId);
  const origin = {
    ...(originThreadId ? { originThreadId } : {}),
    ...(originTurnId ? { originTurnId } : {})
  };

  if (itemType === "agent_message") {
    const text = boundedString(item.text, MAX_TEXT_CHARS);
    const comment = normalizeStructuredAgentComment(item.comment, text);
    return {
      id,
      eventType,
      itemType,
      text,
      ...(boundedString(item.phase, 64) ? { phase: boundedString(item.phase, 64) } : {}),
      ...(comment
        ? {
            comment: {
              ...comment,
              extracts: comment.extracts.map((extract) => ({
                ...extract,
                shortMsg: boundedString(extract.shortMsg, 256)
              })),
              detail: boundedString(comment.detail, MAX_TEXT_CHARS)
            }
          }
        : {}),
      ...origin
    };
  }

  if (itemType === "reasoning") {
    return { id, eventType, itemType, text: boundedString(item.text, MAX_TEXT_CHARS), ...origin };
  }

  if (itemType === "command_execution") {
    const previousOmitted = Math.max(0, readFiniteNumber(item.omittedOutputChars) ?? 0);
    const rawOutput = readString(item.aggregatedOutput) ?? "";
    const visibleOutput = previousOmitted > 0
      ? rawOutput.replace(/^\[output truncated: omitted [^\n]+\]\n/, "")
      : rawOutput;
    const output = truncateCommandOutput(visibleOutput, previousOmitted);
    return {
      id,
      eventType,
      itemType,
      command: boundedString(item.command, MAX_SHORT_TEXT_CHARS),
      aggregatedOutput: output.text,
      ...(output.truncated ? { outputTruncated: true, omittedOutputChars: output.omittedChars } : {}),
      ...(readFiniteNumber(item.exitCode) === null ? {} : { exitCode: readFiniteNumber(item.exitCode) ?? undefined }),
      status: boundedString(item.status, 128),
      ...origin
    };
  }

  if (itemType === "file_change") {
    return {
      id,
      eventType,
      itemType,
      changes: normalizeFileChanges(item.changes),
      status: boundedString(item.status, 128),
      ...origin
    };
  }

  if (itemType === "web_search") {
    return { id, eventType, itemType, query: boundedString(item.query, MAX_SHORT_TEXT_CHARS), ...origin };
  }

  if (itemType === "todo_list") {
    const items = Array.isArray(item.items) ? item.items.slice(0, MAX_TODO_ITEMS) : [];
    return {
      id,
      eventType,
      itemType,
      items: items.flatMap((candidate) => {
        const todo = readObject(candidate);
        return todo
          ? [{ text: boundedString(todo.text, 4_096), completed: todo.completed === true,
              ...(["pending", "in_progress", "completed"].includes(String(todo.status)) ? { status: todo.status as "pending" | "in_progress" | "completed" } : {}) }]
          : [];
      }),
      ...origin
    };
  }

  if (itemType === "context_compaction") {
    return { id, eventType, itemType, ...origin };
  }

  if (itemType === "subagent") {
    const senderThreadId = boundedIdentifier(item.senderThreadId);
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.slice(0, MAX_SUBAGENT_RECEIVERS).flatMap((value) => {
          const id = boundedIdentifier(value);
          return id ? [id] : [];
        })
      : [];
    const agents = Array.isArray(item.agents) ? item.agents.slice(0, MAX_SUBAGENT_AGENTS) : [];
    return {
      id,
      eventType,
      itemType,
      tool: boundedString(item.tool, 128) || "agent",
      status: boundedString(item.status, 128),
      ...(boundedString(item.label, 1_024) ? { label: boundedString(item.label, 1_024) } : {}),
      ...(senderThreadId ? { senderThreadId } : {}),
      receiverThreadIds,
      ...(boundedString(item.prompt, MAX_TEXT_CHARS) ? { prompt: boundedString(item.prompt, MAX_TEXT_CHARS) } : {}),
      ...(boundedString(item.model, 256) ? { model: boundedString(item.model, 256) } : {}),
      ...(boundedString(item.reasoningEffort, 128)
        ? { reasoningEffort: boundedString(item.reasoningEffort, 128) }
        : {}),
      agents: agents.flatMap((candidate) => {
        const agent = readObject(candidate);
        const agentId = boundedIdentifier(agent?.id);
        if (!agent || !agentId) return [];
        return [{
          id: agentId,
          ...(boundedString(agent.name, 1_024) ? { name: boundedString(agent.name, 1_024) } : {}),
          status: boundedString(agent.status, 128),
          ...(boundedString(agent.message, MAX_SHORT_TEXT_CHARS)
            ? { message: boundedString(agent.message, MAX_SHORT_TEXT_CHARS) }
            : {})
        }];
      }),
      ...origin
    };
  }

  if (itemType === "error") {
    return { id, eventType, itemType, message: boundedString(item.message, MAX_TEXT_CHARS), ...origin };
  }

  return null;
}

function normalizeFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FILE_CHANGES).flatMap((candidate) => {
    const change = readObject(candidate);
    if (!change) return [];
    const normalized: FileChange = {
      path: boundedString(change.path, 4_096),
      kind: boundedString(change.kind, 128)
    };
    for (const field of fileChangeTextFields) {
      const text = boundedString(change[field], MAX_FILE_CHANGE_TEXT_CHARS);
      if (text) normalized[field] = text;
    }
    return [normalized];
  });
}

function mergeItemsById(items: StreamItem[]) {
  const merged = new Map<string, StreamItem>();
  for (const item of items) merged.set(item.id, item);
  return [...merged.values()];
}

function boundTranscriptTurns(turns: SubagentTranscriptTurn[]) {
  const recentTurns = turns.slice(-MAX_TURNS);
  const kept: SubagentTranscriptTurn[] = [];
  let itemCount = 0;
  let responseItemChars = 0;

  for (let turnIndex = recentTurns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = recentTurns[turnIndex];
    const keptItems: StreamItem[] = [];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      if (itemCount >= MAX_ITEMS) break;
      const item = turn.items[itemIndex];
      const itemChars = JSON.stringify(item).length;
      if (responseItemChars + itemChars > MAX_RESPONSE_ITEM_CHARS) break;
      keptItems.unshift(item);
      itemCount += 1;
      responseItemChars += itemChars;
    }
    if (keptItems.length > 0) {
      kept.unshift({ ...turn, items: keptItems });
    }
    if (itemCount >= MAX_ITEMS || responseItemChars >= MAX_RESPONSE_ITEM_CHARS) break;
  }

  return kept;
}

function compareStoredLiveItems(first: unknown, second: unknown) {
  const firstRecord = readObject(first);
  const secondRecord = readObject(second);
  const firstCreated = readString(firstRecord?.sortCreated) ?? "";
  const secondCreated = readString(secondRecord?.sortCreated) ?? "";
  if (firstCreated !== secondCreated) return firstCreated.localeCompare(secondCreated);
  return (readString(firstRecord?.sortEventId) ?? readString(firstRecord?.id) ?? "")
    .localeCompare(readString(secondRecord?.sortEventId) ?? readString(secondRecord?.id) ?? "");
}

function normalizeEventType(value: unknown): StreamItem["eventType"] {
  return value === "item.started" || value === "item.completed" ? value : "item.updated";
}

function boundedIdentifier(value: unknown) {
  const text = readString(value)?.trim();
  return text && text.length <= 256 ? text : null;
}

function boundedString(value: unknown, maxChars: number) {
  const text = readString(value) ?? "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
