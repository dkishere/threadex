import { asyncInputQuestions, type AsyncInputQuestion } from "../userInputRequest";

type AppServerThreadItem = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
};

export type AppServerMessage = Record<string, unknown> & {
  method?: unknown;
  params?: unknown;
};

export const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const COMMENT_SHORT_MAX_CHARS = 256;
const COMMENT_SHORT_MAX_TOKEN_UNITS = 64;

const COMMENT_FALLBACK_SHORTS: Record<StructuredAgentCommentType, string> = {
  answer: "Answering your question",
  action: "Working on the next step",
  edit: "Editing the requested changes",
  verification: "Verifying the result",
  solution: "Solution identified",
  wait: "Waiting for the next step"
};

const LEGACY_COMMENT_FALLBACK_SHORTS = new Set([
  ...Object.values(COMMENT_FALLBACK_SHORTS),
  "対応中",
  "変更中",
  "検証中",
  "問題が発生",
  "解決策を確認",
  "작업 진행 중",
  "수정 중",
  "검증 중",
  "문제 발생",
  "해결 방법 확인",
  "正在處理",
  "正在修改",
  "正在驗證",
  "遇到問題",
  "已找到解決方法"
]);

const COMMAND_OUTPUT_TAIL_LIMIT = COMMAND_OUTPUT_LIMIT - 160;

export type FileChange = {
  path: string;
  kind: string;
  movePath?: string;
  before?: string;
  after?: string;
  beforeText?: string;
  afterText?: string;
  beforeContent?: string;
  afterContent?: string;
  oldContent?: string;
  newContent?: string;
  previousContent?: string;
  currentContent?: string;
  original?: string;
  updated?: string;
  diff?: string;
  patch?: string;
  unifiedDiff?: string;
};

export type StreamItem = {
  /** App-server notification ownership. These differ from the manager turn
   * when an item was emitted by a collab subagent on the parent connection. */
  originThreadId?: string;
  originTurnId?: string;
} & (
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "agent_message";
      text: string;
      phase?: string;
      delivery?: "async";
      questions?: AsyncInputQuestion[];
      comment?: StructuredAgentComment;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "reasoning";
      text: string;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "command_execution";
      command: string;
      aggregatedOutput: string;
      outputTruncated?: boolean;
      omittedOutputChars?: number;
      exitCode?: number;
      status: string;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "file_change";
      changes: FileChange[];
      status: string;
      /** Final net diff for the turn, rather than an individual edit action. */
      authoritative?: boolean;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "web_search";
      query: string;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "todo_list";
      items: Array<{ text: string; completed: boolean; status?: "pending" | "in_progress" | "completed" }>;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "context_compaction";
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "subagent";
      tool: string;
      status: string;
      label?: string;
      senderThreadId?: string;
      receiverThreadIds: string[];
      prompt?: string;
      model?: string;
      reasoningEffort?: string;
      agents: Array<{ id: string; name?: string; status: string; message?: string }>;
    }
  | {
      id: string;
      eventType: "item.started" | "item.updated" | "item.completed";
      itemType: "error";
      message: string;
    }
);

export type StructuredAgentCommentType = "answer" | "action" | "edit" | "verification" | "solution" | "wait";

export type StructuredAgentCommentExtract = {
  type: StructuredAgentCommentType;
  shortMsg: string;
};

export type StructuredAgentCommentSolution = {
  /** Stable one-based index into the turn-wide issue ledger. */
  issueKey: number;
  solution: string;
};

export type StructuredAgentComment = {
  extracts: StructuredAgentCommentExtract[];
  detail: string;
  /** Issues newly discovered by this comment; earlier issues are not repeated. */
  issues?: string[];
  /** Solutions newly established or updated by this comment. */
  solutions?: StructuredAgentCommentSolution[];
  blockers?: Array<{ issueKey: number; blocker: string }>;
};

/** Native update_plan notifications are separate from textual plan items. */
export function streamItemFromPlanUpdate(params: unknown): StreamItem | undefined {
  const record = readObject(params);
  const turnId = readString(record?.turnId);
  if (!turnId || !Array.isArray(record?.plan)) return undefined;
  const items: Array<{ text: string; completed: boolean; status: "pending" | "in_progress" | "completed" }> = [];
  for (const candidate of record.plan) {
    const entry = readObject(candidate);
    const text = readString(entry?.step);
    const rawStatus = readString(entry?.status);
    if (!text || !["pending", "inProgress", "in_progress", "completed"].includes(rawStatus ?? "")) return undefined;
    const status = rawStatus === "completed" ? "completed" : rawStatus === "pending" ? "pending" : "in_progress";
    items.push({ text, completed: status === "completed", status });
  }
  return { id: `native-plan:${turnId}`, eventType: "item.updated", itemType: "todo_list", items };
}

export function streamItemFromThreadItem(
  item: unknown,
  eventType: StreamItem["eventType"]
): StreamItem | undefined {
  const threadItem = readObject(item) as AppServerThreadItem | null;
  const id = readString(threadItem?.id);
  const type = readString(threadItem?.type);
  if (!threadItem || !id || !type) {
    return undefined;
  }

  if (type === "agentMessage") {
    const rawText = readString(threadItem.text) ?? "";
    const phase = readString(threadItem.phase) ?? undefined;
    const comment = phase === "commentary" ? structureAgentComment(rawText) : undefined;
    return {
      id,
      eventType,
      itemType: "agent_message",
      text: comment?.detail ?? rawText,
      ...(phase ? { phase } : {}),
      ...(threadItem.delivery === "async" ? { delivery: "async" as const, questions: asyncInputQuestions(threadItem.questions) } : {}),
      ...(comment ? { comment } : {})
    };
  }

  if (type === "reasoning") {
    return {
      id,
      eventType,
      itemType: "reasoning",
      text: [...readStringArray(threadItem.summary), ...readStringArray(threadItem.content)].join("\n")
    };
  }

  if (type === "commandExecution") {
    const output = truncateCommandOutput(readString(threadItem.aggregatedOutput) ?? "");
    return {
      id,
      eventType,
      itemType: "command_execution",
      command: readString(threadItem.command) ?? "",
      aggregatedOutput: output.text,
      ...(output.truncated ? { outputTruncated: true, omittedOutputChars: output.omittedChars } : {}),
      exitCode: readNumber(threadItem.exitCode) ?? undefined,
      status: readString(threadItem.status) ?? ""
    };
  }

  if (type === "fileChange") {
    return {
      id,
      eventType,
      itemType: "file_change",
      changes: readFileChanges(threadItem.changes),
      status: readString(threadItem.status) ?? ""
    };
  }

  if (type === "webSearch") {
    return { id, eventType, itemType: "web_search", query: readString(threadItem.query) ?? "" };
  }

  if (type === "plan") {
    return {
      id,
      eventType,
      itemType: "todo_list",
      items: parsePlanText(readString(threadItem.text) ?? "")
    };
  }

  if (type === "contextCompaction") {
    return { id, eventType, itemType: "context_compaction" };
  }

  if (type === "collabAgentToolCall") {
    return {
      id,
      eventType,
      itemType: "subagent",
      tool: readString(threadItem.tool) ?? "agent",
      status: readString(threadItem.status) ?? (eventType === "item.completed" ? "completed" : "inProgress"),
      ...(readString(threadItem.senderThreadId) ? { senderThreadId: readString(threadItem.senderThreadId) ?? undefined } : {}),
      receiverThreadIds: readStringArray(threadItem.receiverThreadIds),
      ...(readString(threadItem.prompt) ? { prompt: readString(threadItem.prompt) ?? undefined } : {}),
      ...(readString(threadItem.model) ? { model: readString(threadItem.model) ?? undefined } : {}),
      ...(readString(threadItem.reasoningEffort)
        ? { reasoningEffort: readString(threadItem.reasoningEffort) ?? undefined }
        : {}),
      agents: readCollabAgentStates(threadItem.agentsStates)
    };
  }

  if (type === "subAgentActivity") {
    const agentThreadId = readString(threadItem.agentThreadId) ?? "";
    return {
      id,
      eventType,
      itemType: "subagent",
      tool: "activity",
      status: readString(threadItem.kind) ?? (eventType === "item.completed" ? "completed" : "inProgress"),
      ...(readString(threadItem.agentPath) ? { label: readString(threadItem.agentPath) ?? undefined } : {}),
      receiverThreadIds: agentThreadId ? [agentThreadId] : [],
      agents: agentThreadId
        ? [{ id: agentThreadId, name: readString(threadItem.agentPath) ?? undefined, status: readString(threadItem.kind) ?? "running" }]
        : []
    };
  }

  return undefined;
}

function structureAgentComment(text: string): StructuredAgentComment | undefined {
  const detail = plainCommentaryDetail(text);
  if (!detail) return undefined;
  return {
    extracts: [{
      type: "action",
      shortMsg: fallbackCommentShort("action", detail)
    }],
    detail
  };
}

function plainCommentaryDetail(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const legacy = readObject(JSON.parse(trimmed));
    const legacyDetail = readString(legacy?.detail)?.trim();
    return legacyDetail || trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeStructuredAgentComment(
  value: unknown,
  fallbackDetail = ""
): StructuredAgentComment | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const detail = readString(record.detail)?.trim() || fallbackDetail.trim();
  if (!detail) return undefined;
  const extracts = normalizeCommentExtracts(record, detail);
  const issues = normalizeCommentIssues(record.issues);
  // Historical trouble extracts are now represented only in the issue ledger.
  if (issues.length === 0) {
    const legacy = Array.isArray(record.extracts) ? record.extracts : [record];
    for (const candidate of legacy) {
      const extract = readObject(candidate);
      if (extract && isLegacyIssueType(extract.type)) {
        const issue = readString(extract.shortMsg)?.trim() || detail;
        if (!issues.includes(issue)) issues.push(issue);
      }
    }
  }
  const solutions = normalizeCommentSolutions(record.solutions);
  const blockers = normalizeCommentSolutions(Array.isArray(record.blockers)
    ? record.blockers.map((entry) => { const item = readObject(entry); return { issueKey: item?.issueKey, solution: item?.blocker }; }) : [])
    .filter((entry) => !solutions.some((solution) => solution.issueKey === entry.issueKey))
    .map(({ issueKey, solution }) => ({ issueKey, blocker: solution }));
  return {
    extracts,
    detail,
    ...(issues.length > 0 ? { issues } : {}),
    ...(solutions.length > 0 ? { solutions } : {}),
    ...(blockers.length > 0 ? { blockers } : {})
  };
}

function normalizeCommentExtracts(record: Record<string, unknown>, detail: string): StructuredAgentCommentExtract[] {
  const rawExtracts = Array.isArray(record.extracts) ? record.extracts : [];
  const normalizedExtracts = rawExtracts.flatMap((candidate) => {
    const extract = readObject(candidate);
    if (!extract) return [];
    if (isLegacyIssueType(extract.type)) return [];
    const rawShortMsg = readString(extract.shortMsg)?.trim();
    if (!rawShortMsg) return [];
    const type = normalizeCommentType(readString(extract.type)?.trim() || inferCommentType(rawShortMsg), rawShortMsg);
    return [{ type, shortMsg: normalizeCommentShort(rawShortMsg, type, detail) }];
  });
  const extracts: StructuredAgentCommentExtract[] = [];
  const extractIndexByType = new Map<StructuredAgentCommentType, number>();
  for (const extract of normalizedExtracts) {
    const existingIndex = extractIndexByType.get(extract.type);
    if (existingIndex === undefined) {
      extractIndexByType.set(extract.type, extracts.length);
      extracts.push(extract);
      continue;
    }
    const existing = extracts[existingIndex];
    if (existing) {
      existing.shortMsg = mergeCommentShorts(existing.shortMsg, extract.shortMsg);
    }
  }
  if (Array.isArray(record.extracts) || extracts.length > 0 || isLegacyIssueType(record.type)) return extracts;

  // Read historical persisted comments, but always emit the new shape.
  const type = normalizeCommentType(readString(record.type)?.trim() || inferCommentType(detail), detail);
  const rawShort = readString(record.short)?.trim() || readString(record.shortMsg)?.trim() || "";
  return [{ type, shortMsg: normalizeCommentShort(rawShort, type, detail) }];
}

function isLegacyIssueType(value: unknown) {
  return typeof value === "string" && ["trouble", "blocker", "error", "diagnosis"].includes(value.trim().toLowerCase());
}

function mergeCommentShorts(first: string, second: string) {
  const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(`${first}${second}`);
  const cleanFirst = first.replace(/[.!?。！？;；]+$/u, "").trimEnd();
  return limitCommentShort(`${cleanFirst}${cjk ? "；" : "; "}${second}`);
}

function normalizeCommentShort(rawShort: string, type: StructuredAgentCommentType, detail: string) {
  const useProvidedShort = Boolean(
    rawShort &&
    !isGenericCommentFallbackShort(rawShort) &&
    commentShortMatchesDetailLanguage(rawShort, detail) &&
    !looksLikeTruncatedDetailPrefix(rawShort, detail)
  );
  return useProvidedShort ? limitCommentShort(rawShort) : fallbackCommentShort(type, detail);
}

function normalizeCommentIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    const issue = readString(candidate)?.trim();
    if (!issue || seen.has(issue)) return [];
    seen.add(issue);
    return [issue];
  });
}

function normalizeCommentSolutions(value: unknown): StructuredAgentCommentSolution[] {
  if (!Array.isArray(value)) return [];
  const byIssue = new Map<number, StructuredAgentCommentSolution>();
  for (const candidate of value) {
    const record = readObject(candidate);
    const issueKey = typeof record?.issueKey === "number" ? record.issueKey : Number(record?.issueKey);
    const solution = readString(record?.solution)?.trim();
    // issueKey addresses the turn-wide ledger, so a delta comment may contain a
    // solution for an issue that is not repeated in this comment's issues.
    if (!Number.isInteger(issueKey) || issueKey < 1 || !solution) continue;
    byIssue.set(issueKey, { issueKey, solution });
  }
  return [...byIssue.values()].sort((left, right) => left.issueKey - right.issueKey);
}

function inferCommentType(text: string) {
  const value = text.toLowerCase();
  if (/\b(wait\w*|pending|queued|paused|holding)\b|等待|等緊|稍候|排隊中|暫停/.test(value)) return "wait";
  if (/\b(solution|resolved|workaround|fixed|recovered)\b|解決|已修正|已修復|方案|繞過/.test(value)) return "solution";
  if (/\b(test\w*|verif\w*|validat\w*|check\w*|build\w*|typecheck\w*)\b/.test(value)) return "verification";
  if (/驗證|測試|檢查|通過/.test(value)) return "verification";
  if (/\b(edit\w*|implement\w*|add(?:ing|ed|s)?|updat\w*|chang\w*|writ\w*|patch\w*|creat\w*)\b|編輯|修改|改動|建立|新增|檔案|文件/.test(value)) return "edit";
  return "action";
}

function normalizeCommentType(type: string, detail: string): StructuredAgentCommentType {
  const value = type.trim().toLowerCase();
  if (value === "answer" || value === "edit" || value === "verification" || value === "solution" || value === "wait") return value;
  if (value === "response" || value === "reply") return "answer";
  if (value === "fix" || value === "resolution" || value === "workaround") return "solution";
  if (value === "action" || value === "research" || value === "progress" || value === "note") return "action";
  return inferCommentType(detail);
}

function commentShortMatchesDetailLanguage(short: string, detail: string) {
  const usesCjkScript = (value: string) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(value);
  return usesCjkScript(short) === usesCjkScript(detail);
}

function looksLikeTruncatedDetailPrefix(short: string, detail: string) {
  const hasEllipsis = /(?:…|\.\.\.)$/u.test(short.trim());
  const prefix = short.trim().replace(/(?:…|\.\.\.)$/u, "").trimEnd();
  return prefix.length > 0 && detail.startsWith(prefix) && (hasEllipsis || prefix === detail);
}

function fallbackCommentShort(type: StructuredAgentCommentType, detail = "") {
  return semanticFallbackCommentShort(detail) || COMMENT_FALLBACK_SHORTS[type];
}

/**
 * Keep a meaningful short label even when the Luna helper is unavailable. This
 * also heals historical generic labels as stored live items are read back.
 */
function semanticFallbackCommentShort(detail: string) {
  const firstContentLine = detail
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^#{1,6}\s/u.test(line));
  if (!firstContentLine) return "";

  const withoutListMarker = firstContentLine.replace(/^(?:[-*•]|\d+[.)])\s+/u, "");
  const withoutStatusLead = withoutListMarker
    .replace(/^(?:我(?:而家)?(?:會先|會|先)?|而家(?:會)?|正在|已經|已)\s*/u, "")
    .replace(/^(?:i(?:\s+am|['’]m|\s+will|['’]ll)|we(?:\s+are|['’]re|\s+will|['’]ll)|now)\s+/iu, "");
  return limitCommentShort(withoutStatusLead.replace(/^[:：\-–—]\s*/u, "").trim());
}

function isGenericCommentFallbackShort(short: string) {
  return LEGACY_COMMENT_FALLBACK_SHORTS.has(short.trim());
}

export function structuredAgentCommentNeedsHeadline(comment: StructuredAgentComment) {
  if (comment.extracts.length === 0 && ((comment.issues?.length ?? 0) > 0 || (comment.solutions?.length ?? 0) > 0 || (comment.blockers?.length ?? 0) > 0)) return false;
  return comment.extracts.length === 0 || comment.extracts.every((extract) => isGenericCommentFallbackShort(extract.shortMsg));
}

function limitCommentShort(text: string) {
  const characters = [...text.trim()];
  if (
    characters.length <= COMMENT_SHORT_MAX_CHARS &&
    commentShortTokenUnits(characters) <= COMMENT_SHORT_MAX_TOKEN_UNITS
  ) {
    return characters.join("");
  }

  const prefix: string[] = [];
  let tokenUnits = 0;
  let letterRunLength = 0;
  for (const character of characters) {
    if (prefix.length >= COMMENT_SHORT_MAX_CHARS - 1) break;
    const whitespace = /\s/u.test(character);
    const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character);
    const letterOrNumber = /[\p{L}\p{N}]/u.test(character);
    const combiningMark = /\p{M}/u.test(character);
    const cost = whitespace || combiningMark
      ? 0
      : cjk
        ? 1
        : letterOrNumber
          ? letterRunLength % 4 === 0 ? 1 : 0
          : 1;
    if (tokenUnits + cost > COMMENT_SHORT_MAX_TOKEN_UNITS - 1) break;
    prefix.push(character);
    tokenUnits += cost;
    letterRunLength = whitespace || cjk || !letterOrNumber ? 0 : letterRunLength + 1;
  }
  return `${prefix.join("").trimEnd()}…`;
}

function commentShortTokenUnits(characters: string[]) {
  let units = 0;
  let letterRunLength = 0;
  for (const character of characters) {
    if (/\s/u.test(character) || /\p{M}/u.test(character)) {
      letterRunLength = 0;
      continue;
    }
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) {
      units += 1;
      letterRunLength = 0;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(character)) {
      if (letterRunLength % 4 === 0) units += 1;
      letterRunLength += 1;
      continue;
    }
    units += 1;
    letterRunLength = 0;
  }
  return units;
}

export function summarizeAppServerMessage(message: AppServerMessage) {
  const method = readString(message.method) ?? "unknown";
  return {
    method,
    params: summarizeParams(method, message.params)
  };
}

/**
 * Convert the app-server's authoritative per-turn git diff into the same file
 * change shape used by streamed edit items. Individual fileChange items are an
 * activity log and can include edits that were later reverted; turn/diff/updated
 * is the final net result for the turn.
 */
export function fileChangesFromTurnDiff(value: unknown): FileChange[] {
  if (typeof value !== "string" || !value.trim()) return [];

  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("diff --git ")) starts.push(index);
  }

  return starts.flatMap((start, blockIndex) => {
    const end = starts[blockIndex + 1] ?? lines.length;
    const blockLines = lines.slice(start, end);
    while (blockLines.at(-1) === "") blockLines.pop();
    const oldHeader = blockLines.find((line) => line.startsWith("--- "))?.slice(4);
    const newHeader = blockLines.find((line) => line.startsWith("+++ "))?.slice(4);
    const renameFrom = blockLines.find((line) => line.startsWith("rename from "))?.slice(12);
    const renameTo = blockLines.find((line) => line.startsWith("rename to "))?.slice(10);
    const headerPaths = pathsFromDiffGitHeader(blockLines[0]);
    const oldPath = normalizedTurnDiffPath(renameFrom ?? oldHeader ?? headerPaths.oldPath);
    const newPath = normalizedTurnDiffPath(renameTo ?? newHeader ?? headerPaths.newPath);
    const oldMissing = (oldHeader ?? "").trim() === "/dev/null";
    const newMissing = (newHeader ?? "").trim() === "/dev/null";
    const path = oldMissing ? newPath : oldPath || newPath;
    if (!path) return [];

    const kind = oldMissing ? "add" : newMissing ? "delete" : renameFrom || renameTo ? "move" : "update";
    const unifiedDiff = blockLines.join("\n");
    return [{
      path,
      kind,
      unifiedDiff,
      patch: unifiedDiff,
      diff: unifiedDiff,
      ...(kind === "move" && newPath && newPath !== path ? { movePath: newPath } : {})
    }];
  });
}

function pathsFromDiffGitHeader(line: string | undefined) {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line ?? "");
  return {
    oldPath: match?.[1] ?? "",
    newPath: match?.[2] ?? ""
  };
}

function normalizedTurnDiffPath(value: string | undefined) {
  if (!value) return "";
  const withoutTimestamp = value.split("\t", 1)[0].trim();
  if (!withoutTimestamp || withoutTimestamp === "/dev/null") return "";
  const unquoted = decodeQuotedGitPath(withoutTimestamp);
  return unquoted.replace(/^[ab]\//u, "");
}

function decodeQuotedGitPath(value: string) {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1).replace(/\\([\\"tnr])/gu, (_match, escaped: string) => (
      escaped === "t" ? "\t" : escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped
    ));
  }
}

export function truncateCommandOutput(value: string, previouslyOmittedChars = 0) {
  if (value.length <= COMMAND_OUTPUT_LIMIT) {
    if (previouslyOmittedChars > 0) {
      const marker = `[output truncated: omitted ${previouslyOmittedChars.toLocaleString()} chars]\n`;
      return { text: marker + value, truncated: true, omittedChars: previouslyOmittedChars };
    }
    return { text: value, truncated: false, omittedChars: 0 };
  }

  const omittedChars = previouslyOmittedChars + value.length - COMMAND_OUTPUT_TAIL_LIMIT;
  const marker = `[output truncated: omitted ${omittedChars.toLocaleString()} chars]\n`;
  return {
    text: marker + value.slice(-COMMAND_OUTPUT_TAIL_LIMIT),
    truncated: true,
    omittedChars
  };
}

function summarizeParams(method: string, params: unknown): unknown {
  const record = readObject(params);
  if (!record) {
    return params ?? null;
  }

  if (method === "item/commandExecution/outputDelta") {
    const delta = readString(record.delta) ?? "";
    const preview = truncateCommandOutput(delta);
    return {
      itemId: readString(record.itemId) ?? null,
      deltaLength: delta.length,
      deltaPreview: preview.text,
      deltaTruncated: preview.truncated
    };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = streamItemFromThreadItem(record.item, method === "item/started" ? "item.started" : "item.completed");
    return {
      item: item ? summarizeStreamItem(item) : null
    };
  }

  if (method === "turn/completed") {
    const turn = readObject(record.turn);
    return {
      turn: turn
        ? {
            id: readString(turn.id) ?? null,
            status: readString(turn.status) ?? null,
            error: turn.error ?? null
          }
        : null
    };
  }

  return params ?? null;
}

function summarizeStreamItem(item: StreamItem) {
  if (item.itemType === "command_execution") {
    return {
      type: item.itemType,
      command: item.command,
      status: item.status,
      exitCode: item.exitCode,
      aggregatedOutputLength: item.aggregatedOutput.length,
      outputTruncated: item.outputTruncated ?? false,
      omittedOutputChars: item.omittedOutputChars ?? 0
    };
  }

  return { type: item.itemType, ...item };
}

function readFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const stringFields: Array<keyof Omit<FileChange, "path" | "kind">> = [
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

  return value.flatMap((change) => {
    const record = readObject(change);
    const path = readString(record?.path) ?? readString(record?.file) ?? "";
    const kind = readString(record?.kind) ?? readString(record?.type) ?? "";
    if (!path) {
      return [];
    }

    const fileChange: FileChange = { path, kind };
    for (const field of stringFields) {
      const fieldValue = readString(record?.[field]);
      if (fieldValue !== null) {
        fileChange[field] = fieldValue;
      }
    }

    return [fileChange];
  });
}


function parsePlanText(text: string): Array<{ text: string; completed: boolean }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      text: line.replace(/^[-*]\s*\[[ xX]\]\s*/, "").replace(/^[-*]\s*/, ""),
      completed: /^[-*]\s*\[[xX]\]/.test(line)
    }));
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : [];
}

function readCollabAgentStates(value: unknown): Array<{ id: string; status: string; message?: string }> {
  const states = readObject(value);
  if (!states) {
    return [];
  }

  return Object.entries(states).flatMap(([id, stateValue]) => {
    const state = readObject(stateValue);
    const status = readString(state?.status);
    if (!status) {
      return [];
    }
    const message = readString(state?.message);
    return [{ id, status, ...(message ? { message } : {}) }];
  });
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
