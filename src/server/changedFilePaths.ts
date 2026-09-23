/** Shared event contract for DB history and Git provenance; no filesystem/Git I/O.
 * Returns sorted, unique, nonempty paths exactly as reported (including both
 * rename paths), without resolving against a repository. Non-Git projects use it
 * too. Only successful completed edit items count: started/failed edits and
 * aggregate diffs are not new writes and may repeat already consumed edits. */
export function changedFilePaths(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (item.itemType !== "file_change" || item.eventType !== "item.completed"
    || item.status !== "completed" || item.authoritative === true || !Array.isArray(item.changes)) return [];
  const paths = item.changes.flatMap(change => {
    if (!change || typeof change !== "object") return [];
    return [change.path, change.movePath, change.move_path]
      .filter((path): path is string => typeof path === "string" && path.length > 0 && !path.includes("\0"));
  });
  return [...new Set(paths)].sort();
}
