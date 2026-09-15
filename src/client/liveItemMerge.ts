export type RankedLiveItem = {
  id: string;
  originThreadId?: string;
  eventType: "item.started" | "item.updated" | "item.completed";
};

type ReasoningLiveItem = RankedLiveItem & {
  itemType?: string;
  text?: string;
};

type LiveItemSegment = {
  type: string;
  item?: ReasoningLiveItem;
};

export function liveItemKey(item: Pick<RankedLiveItem, "id" | "originThreadId">) {
  return `${item.originThreadId ?? ""}:${item.id}`;
}

function eventRank(eventType: RankedLiveItem["eventType"]) {
  if (eventType === "item.completed") return 3;
  if (eventType === "item.updated") return 2;
  return 1;
}

/**
 * Reconcile a durable snapshot with live items already rendered in the client.
 * A snapshot can be assembled while a runner callback is still being persisted,
 * so missing or newer local items must survive that refresh.
 */
export function mergeSnapshotLiveItems<T extends RankedLiveItem>(snapshotItems: T[], currentItems: T[]): T[] {
  const currentById = new Map(currentItems.map((item) => [liveItemKey(item), item]));
  const merged = snapshotItems.map((snapshotItem) => {
    const key = liveItemKey(snapshotItem);
    const currentItem = currentById.get(key);
    currentById.delete(key);
    return currentItem && eventRank(currentItem.eventType) > eventRank(snapshotItem.eventType)
      ? currentItem
      : snapshotItem;
  });

  return [...merged, ...currentItems.filter((item) => currentById.has(liveItemKey(item)))];
}

/**
 * A terminal turn is authoritative even if its final reasoning notification was
 * missed by the live client. Empty reasoning placeholders disappear; readable
 * reasoning summaries remain in the timeline but can no longer spin.
 */
export function finalizePendingReasoningItems<T extends ReasoningLiveItem>(items: T[]): T[] {
  return items.flatMap((item) => {
    if (item.itemType !== "reasoning") return [item];

    const completed = item.eventType === "item.completed"
      ? item
      : ({ ...item, eventType: "item.completed" } as T);
    return completed.text?.trim() ? [completed] : [];
  });
}

export function finalizePendingReasoningSegments<T extends LiveItemSegment>(segments: T[]): T[] {
  return segments.flatMap((segment) => {
    if (segment.type !== "live" || !segment.item) return [segment];
    const [item] = finalizePendingReasoningItems([segment.item]);
    return item ? [{ ...segment, item } as T] : [];
  });
}

/**
 * Reasoning spans are transport details, not timeline steps. Render one stable
 * turn-level status at the end while work is active, based on the latest work
 * span, and none afterward.
 */
export function withTurnLevelStatus<T extends LiveItemSegment>(
  segments: T[],
  running: boolean,
  pendingStatus?: string,
): T[] {
  const latestWorkItem = [...segments]
    .reverse()
    .find((segment) => segment.type === "live" && (
      segment.item?.itemType === "reasoning" ||
      segment.item?.itemType === "file_change" ||
      segment.item?.itemType === "command_execution"
    ))
    ?.item;
  const withoutReasoning = segments.filter(
    (segment) => segment.type !== "live" || segment.item?.itemType !== "reasoning"
  );
  if (!running) return withoutReasoning;

  const text = pendingStatus || (latestWorkItem?.itemType === "file_change"
    ? "Editing"
    : latestWorkItem?.itemType === "command_execution"
      ? "Running"
      : "Thinking");

  return [
    ...withoutReasoning,
    {
      id: "live:turn-level-status",
      type: "live",
      item: {
        id: "turn-level-status",
        itemType: "reasoning",
        eventType: "item.started",
        text
      }
    } as unknown as T
  ];
}
