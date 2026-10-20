export const TRANSCRIPT_PAGE_TURNS = 50;

/** Window rendered turns only; the full transcript remains available to actions. */
export function transcriptWindow<T extends { id: string; turnId?: string }>(
  messages: T[], anchorId?: string | null, limit = TRANSCRIPT_PAGE_TURNS
) {
  const keys = [...new Set(messages.map(message => message.turnId ?? message.id))];
  const anchor = messages.find(message => message.id === anchorId);
  const anchorIndex = anchor ? keys.indexOf(anchor.turnId ?? anchor.id) : -1;
  const start = anchorIndex < 0 ? Math.max(0, keys.length - limit) : anchorIndex;
  const end = Math.min(keys.length, start + limit);
  const visibleKeys = new Set(keys.slice(start, end));
  const firstByKey = new Map<string, string>();
  for (const message of messages) {
    const key = message.turnId ?? message.id;
    if (!firstByKey.has(key)) firstByKey.set(key, message.id);
  }
  return {
    messages: messages.filter(message => visibleKeys.has(message.turnId ?? message.id)),
    start, end, total: keys.length,
    previousAnchor: start > 0 ? firstByKey.get(keys[Math.max(0, start - limit)]) : undefined,
    nextAnchor: end < keys.length ? firstByKey.get(keys[end]) : undefined
  };
}
