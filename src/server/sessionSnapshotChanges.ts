import { fileChangeLineStats } from "../fileChangeLineStats";

const contentKeys = ["before", "after", "beforeText", "afterText", "beforeContent", "afterContent", "oldContent", "newContent", "previousContent", "currentContent", "original", "updated", "diff", "patch", "unifiedDiff"];

/** Keep large historical file bodies out of navigation responses. Stored events remain intact. */
export function snapshotChangeItems(sessionId: string, turnId: string, items: unknown[]): unknown[] {
  return items.map(value => {
    const item = value as Record<string, any>;
    if (item?.itemType !== "file_change" || !Array.isArray(item.changes) || typeof item.id !== "string") return value;
    return { ...item, changes: item.changes.map((change: Record<string, any>, index: number) => {
      if (contentKeys.reduce((size, key) => size + (typeof change[key] === "string" ? change[key].length : 0), 0) < 32_768) return change;
      const compact: Record<string, any> = { ...change, ...fileChangeLineStats(change) };
      for (const key of contentKeys) delete compact[key];
      compact.contentUrl = `/api/sessions/${encodeURIComponent(sessionId)}/file-change-content?turnId=${encodeURIComponent(turnId)}&itemId=${encodeURIComponent(item.id)}&index=${index}`;
      return compact;
    }) };
  });
}
