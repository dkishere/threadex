export const TRANSCRIPT_PAGE_TURNS = 50;

/**
 * Window rendered turns only; the full transcript remains available to actions.
 * The window always runs from its first turn to the latest one, so loading
 * earlier turns prepends history instead of replacing the rendered page.
 */
export function transcriptWindow<T extends { id: string; turnId?: string }>(
  messages: T[], firstMessageId?: string | null, limit = TRANSCRIPT_PAGE_TURNS
) {
  const keys = [...new Set(messages.map(message => message.turnId ?? message.id))];
  const latestStart = Math.max(0, keys.length - limit);
  const first = messages.find(message => message.id === firstMessageId);
  const firstIndex = first ? keys.indexOf(first.turnId ?? first.id) : -1;
  const start = firstIndex < 0 ? latestStart : Math.min(firstIndex, latestStart);
  const visibleKeys = new Set(keys.slice(start));
  const firstByKey = new Map<string, string>();
  for (const message of messages) {
    const key = message.turnId ?? message.id;
    if (!firstByKey.has(key)) firstByKey.set(key, message.id);
  }
  const earlierStart = Math.max(0, start - limit);
  return {
    messages: messages.filter(message => visibleKeys.has(message.turnId ?? message.id)),
    start, total: keys.length,
    earlierFirstMessageId: start > 0 ? firstByKey.get(keys[earlierStart]) : undefined,
    earlierTurnCount: start - earlierStart
  };
}
