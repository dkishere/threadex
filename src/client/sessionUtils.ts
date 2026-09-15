import type { SessionPageState } from "./eventStore";
import type { ChatMessage, QueuedPrompt, SessionBaseDirGroup, SessionRecord, SessionTreeNode } from "./appTypes";

export function toSessionPageState(
  sessions: SessionRecord[],
  page: {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
    projects?: Array<{
      cwd: string;
      offset: number;
      limit: number;
      hasMore: boolean;
      total: number;
      nextOffset: number | null;
    }>;
  } | undefined
): SessionPageState {
  return {
    sessions,
    offset: page?.offset ?? 0,
    limit: page?.limit ?? 20,
    hasMore: page?.hasMore ?? false,
    nextOffset: page?.nextOffset ?? null,
    projects: Array.isArray(page?.projects) ? page.projects : []
  };
}

export function buildSessionTree(sessions: SessionRecord[]): SessionTreeNode[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const childrenByParentId = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    if (!session.parentSessionId || !sessionById.has(session.parentSessionId) || session.parentSessionId === session.id) {
      continue;
    }
    const children = childrenByParentId.get(session.parentSessionId) ?? [];
    children.push(session);
    childrenByParentId.set(session.parentSessionId, children);
  }

  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => compareSessionTreeRecords(left, right, childrenByParentId));
  }

  const roots = sessions
    .filter((session) => !session.parentSessionId || !sessionById.has(session.parentSessionId) || session.parentSessionId === session.id)
    .sort((left, right) => compareSessionTreeRecords(left, right, childrenByParentId));
  const included = new Set<string>();
  const nodes: SessionTreeNode[] = [];
  for (const root of roots) {
    const node = buildSessionTreeNode(root, childrenByParentId, 0, new Set<string>(), included);
    if (node) nodes.push(node);
  }
  for (const session of sessions) {
    if (included.has(session.id)) continue;
    const node = buildSessionTreeNode(session, childrenByParentId, 0, new Set<string>(), included);
    if (node) nodes.push(node);
  }
  return nodes;
}

export function groupSessionsByBaseDir(
  sessions: SessionRecord[],
  workspaceId?: string | null
): SessionBaseDirGroup[] {
  const sessionsByCwd = new Map<string, SessionRecord[]>();
  const scopedSessions = workspaceId
    ? sessions.filter((session) => session.workspaceId === workspaceId)
    : sessions;
  for (const session of scopedSessions) {
    const cwd = session.cwd.trim();
    const groupedSessions = sessionsByCwd.get(cwd) ?? [];
    groupedSessions.push(session);
    sessionsByCwd.set(cwd, groupedSessions);
  }

  return [...sessionsByCwd.entries()]
    .map(([cwd, groupedSessions]) => ({
      cwd,
      label: baseDirLabel(cwd),
      count: groupedSessions.length,
      baseSessionId: groupedSessions[0].id,
      sessions: buildSessionTree(groupedSessions),
      latestUpdated: groupedSessions.reduce(
        (latest, session) => session.updated > latest ? session.updated : latest,
        ""
      )
    }))
    .sort((left, right) => right.latestUpdated.localeCompare(left.latestUpdated) || left.cwd.localeCompare(right.cwd))
    .map(({ latestUpdated: _latestUpdated, ...group }) => group);
}

export function baseDirLabel(cwd: string): string {
  const normalized = cwd.trim().replace(/[\\/]+$/, "");
  if (!normalized) return cwd.trim() || "Unknown directory";
  const parts = normalized.split(/[\\/]/);
  return parts.at(-1) || normalized;
}

function buildSessionTreeNode(
  session: SessionRecord,
  childrenByParentId: Map<string, SessionRecord[]>,
  depth: number,
  ancestors: Set<string>,
  included: Set<string>
): SessionTreeNode | null {
  if (ancestors.has(session.id)) return null;
  ancestors.add(session.id);
  included.add(session.id);
  const children = (childrenByParentId.get(session.id) ?? [])
    .map((child) => buildSessionTreeNode(child, childrenByParentId, depth + 1, ancestors, included))
    .filter((node): node is SessionTreeNode => Boolean(node));
  ancestors.delete(session.id);
  return { record: session, children, depth };
}

function compareSessionTreeRecords(
  left: SessionRecord,
  right: SessionRecord,
  childrenByParentId: Map<string, SessionRecord[]>
) {
  const latest = latestSessionTreeTimestamp(right, childrenByParentId, new Set<string>()).localeCompare(
    latestSessionTreeTimestamp(left, childrenByParentId, new Set<string>())
  );
  if (latest !== 0) return latest;
  const updated = right.updated.localeCompare(left.updated);
  if (updated !== 0) return updated;
  const created = right.created.localeCompare(left.created);
  if (created !== 0) return created;
  return right.id.localeCompare(left.id);
}

function latestSessionTreeTimestamp(
  session: SessionRecord,
  childrenByParentId: Map<string, SessionRecord[]>,
  visited: Set<string>
): string {
  if (visited.has(session.id)) return session.updated;
  visited.add(session.id);
  let latest = session.updated;
  for (const child of childrenByParentId.get(session.id) ?? []) {
    const childLatest = latestSessionTreeTimestamp(child, childrenByParentId, visited);
    if (childLatest > latest) latest = childLatest;
  }
  visited.delete(session.id);
  return latest;
}

export function pendingAssistantMessages(messages: ChatMessage[]) {
  return messages.filter(
    (message) => message.role === "assistant" && message.turnStatus === "todo" && Boolean(message.turnId)
  );
}

export function findUserMessageForTurn(messages: ChatMessage[], turnId: string) {
  const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.turnId === turnId);
  if (assistantIndex <= 0) {
    return null;
  }

  return [...messages.slice(0, assistantIndex)]
    .reverse()
    .find((message) => message.role === "user" && message.kind !== "steer") ?? null;
}

export function reorderPendingTurnMessages(messages: ChatMessage[], turnId: string, direction: "up" | "down") {
  const pendingMessages = pendingAssistantMessages(messages);
  const currentIndex = pendingMessages.findIndex((message) => message.turnId === turnId);
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= pendingMessages.length) {
    return null;
  }

  const currentTurnId = pendingMessages[currentIndex].turnId;
  const targetTurnId = pendingMessages[targetIndex].turnId;
  if (!currentTurnId || !targetTurnId) {
    return null;
  }

  const currentPair = turnMessagePair(messages, currentTurnId);
  const targetPair = turnMessagePair(messages, targetTurnId);
  if (!currentPair || !targetPair) {
    return null;
  }

  const result = [...messages];
  const currentMessages = result.splice(currentPair.start, currentPair.count);
  const targetStart = currentPair.start < targetPair.start ? targetPair.start - currentPair.count : targetPair.start;
  const targetMessages = result.splice(targetStart, targetPair.count);

  if (direction === "up") {
    result.splice(targetStart, 0, ...currentMessages, ...targetMessages);
  } else {
    result.splice(currentPair.start, 0, ...targetMessages, ...currentMessages);
  }
  return result;
}

export function moveQueuedPromptInList(prompts: QueuedPrompt[], promptId: string, direction: "up" | "down") {
  const currentIndex = prompts.findIndex((prompt) => prompt.id === promptId);
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= prompts.length) {
    return null;
  }

  const next = [...prompts];
  const [prompt] = next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, prompt);
  return next;
}

export function promoteQueuedPromptToSteer(prompts: QueuedPrompt[], promptId: string) {
  const currentIndex = prompts.findIndex((prompt) => prompt.id === promptId);
  if (currentIndex < 0) {
    return prompts;
  }

  const next = [...prompts];
  const [prompt] = next.splice(currentIndex, 1);
  const firstQueuedIndex = next.findIndex((candidate) => candidate.kind === "queue");
  next.splice(firstQueuedIndex < 0 ? next.length : firstQueuedIndex, 0, { ...prompt, kind: "steer" });
  return next;
}

export function moveQueuedPromptToTarget(prompts: QueuedPrompt[], promptId: string, targetPromptId: string) {
  const currentIndex = prompts.findIndex((prompt) => prompt.id === promptId);
  const targetIndex = prompts.findIndex((prompt) => prompt.id === targetPromptId);
  if (currentIndex < 0 || targetIndex < 0) {
    return null;
  }

  const next = [...prompts];
  const [prompt] = next.splice(currentIndex, 1);
  next.splice(currentIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, prompt);
  return next;
}

function turnMessagePair(messages: ChatMessage[], turnId: string) {
  const assistantIndex = messages.findIndex((message) => message.role === "assistant" && message.turnId === turnId);
  if (assistantIndex < 0) {
    return null;
  }

  const userIndex = assistantIndex > 0 && messages[assistantIndex - 1]?.role === "user" ? assistantIndex - 1 : assistantIndex;
  let endIndex = assistantIndex + 1;
  while (
    endIndex < messages.length &&
    messages[endIndex]?.role === "user" &&
    messages[endIndex]?.kind === "steer" &&
    messages[endIndex]?.turnId === turnId
  ) {
    endIndex += 1;
  }

  return {
    start: userIndex,
    count: endIndex - userIndex
  };
}

export function findAssistantMessageId(messages: ChatMessage[], turnId: string) {
  return [...messages].reverse().find((message) => message.role === "assistant" && message.turnId === turnId)?.id;
}
