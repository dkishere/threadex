// Timeline grouping creates fresh wrapper arrays on every streamed update.
// Compare their immutable items, without walking command output or diff text.
export function sameTimelineItems(
  left: readonly { id: string; item: unknown; groupType?: string }[],
  right: readonly { id: string; item: unknown; groupType?: string }[]
): boolean {
  return left === right || (left.length === right.length && left.every((entry, index) => {
    const next = right[index];
    return entry.id === next.id && entry.item === next.item && entry.groupType === next.groupType;
  }));
}
