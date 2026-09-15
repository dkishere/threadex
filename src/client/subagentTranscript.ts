import type { StreamItem } from "./appTypes";

export type SubagentAgentSummary = {
  id: string;
  name?: string;
  status: string;
  message?: string;
};

export type SubagentActivityLike = {
  itemType?: string;
  label?: string;
  status?: string;
  agents?: SubagentAgentSummary[];
};

export type SubagentTranscriptTurn = {
  id: string;
  status: string;
  items: StreamItem[];
};

export type SubagentTranscriptPayload = {
  sessionId: string;
  threadId: string;
  turns: SubagentTranscriptTurn[];
  partial?: boolean;
  source?: string;
  warning?: string;
};

function normalizedStatus(value: unknown) {
  return String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function agentDisplayName(agent: SubagentAgentSummary) {
  return (agent.name || agent.id).trim();
}

/** The collaboration activity feed also reports the parent agent as `/root`. */
export function isExactRootSubagentActivity(item: SubagentActivityLike) {
  if (item.itemType !== "subagent") return false;
  const names = [item.label, ...(item.agents ?? []).map(agentDisplayName)]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  return names.length > 0 && names.every((name) => name === "/root");
}

/**
 * A single-agent activity event already puts the agent name and status in its
 * card header. Do not repeat the same empty row immediately below it.
 */
export function visibleSubagentAgents(item: SubagentActivityLike) {
  const agents = item.agents ?? [];
  const headerName = item.label?.trim();
  const headerStatus = normalizedStatus(item.status);
  return agents.filter((agent) => {
    const hasMessage = Boolean(agent.message?.trim());
    const repeatsHeader = Boolean(headerName) && agentDisplayName(agent) === headerName;
    const repeatsStatus = normalizedStatus(agent.status) === headerStatus;
    return hasMessage || !repeatsHeader || !repeatsStatus;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeStreamItem(value: unknown): value is StreamItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.itemType === "string" &&
    (value.eventType === "item.started" ||
      value.eventType === "item.updated" ||
      value.eventType === "item.completed")
  );
}

export function parseSubagentTranscriptPayload(value: unknown): SubagentTranscriptPayload {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.threadId !== "string") {
    throw new Error("The subagent transcript response is invalid.");
  }
  if (!Array.isArray(value.turns)) {
    throw new Error("The subagent transcript response has no turns.");
  }

  const turns = value.turns.flatMap((rawTurn, index): SubagentTranscriptTurn[] => {
    if (!isRecord(rawTurn) || !Array.isArray(rawTurn.items)) return [];
    const items = rawTurn.items.filter(looksLikeStreamItem);
    return [
      {
        id: typeof rawTurn.id === "string" ? rawTurn.id : `turn-${index + 1}`,
        status: typeof rawTurn.status === "string" ? rawTurn.status : "unknown",
        items,
      },
    ];
  });

  return {
    sessionId: value.sessionId,
    threadId: value.threadId,
    turns,
    partial: value.partial === true ? true : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    warning: typeof value.warning === "string" ? value.warning : undefined,
  };
}
