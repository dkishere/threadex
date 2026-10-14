import type { WorkspaceManagerHistoryPage } from "../workspaceManager";

export function sessionSnapshotUrl(sessionId: string, managerView = false, beforeTurnId?: string, turnId?: string) {
  const query = new URLSearchParams();
  if (managerView) query.set("view", "workspace-chat");
  if (managerView && beforeTurnId) query.set("beforeTurnId", beforeTurnId);
  if (managerView && turnId) query.set("turnId", turnId);
  return `/api/sessions/${encodeURIComponent(sessionId)}/snapshot${query.size ? `?${query}` : ""}`;
}

type HistorySnapshot<T> = { turns: T[]; managerHistory: WorkspaceManagerHistoryPage };

/** Older pages cannot overwrite a turn refreshed while the request was in flight. */
export function mergeManagerHistory<T extends { id: string; created: string; status?: string }>(
  previous: HistorySnapshot<T> | null, incoming: HistorySnapshot<T>
): HistorySnapshot<T> {
  if (!previous) return incoming;
  const olderPage = incoming.managerHistory.requestedBeforeTurnId !== null;
  if (!olderPage && previous.managerHistory.requestedBeforeTurnId === null) return incoming;
  const incomingIds = new Set(incoming.turns.map(turn => turn.id));
  const retained = olderPage ? previous.turns : previous.turns.filter(turn => turn.status !== "running" || incomingIds.has(turn.id));
  const byId = new Map<string, T>();
  for (const turn of olderPage ? [...incoming.turns, ...retained] : [...retained, ...incoming.turns]) {
    byId.set(turn.id, turn);
  }
  return {
    turns: [...byId.values()].sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    managerHistory: olderPage || previous.managerHistory.requestedBeforeTurnId === null
      ? incoming.managerHistory : previous.managerHistory
  };
}
