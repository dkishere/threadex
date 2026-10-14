import type { LiveItem, StructuredCommentType } from "./appTypes";

export type TimelineActivity = {
  id: string;
  item: LiveItem;
  groupType: "command" | "edit" | "search";
};

type TimelineItemEntry = {
  kind: "item";
  id: string;
  item: LiveItem;
};

type TimelineActionGroupEntry = {
  kind: "action_group";
  id: string;
  groupType: string;
  items: Array<{ id: string; item: LiveItem }>;
};

export type CommentaryActivityEntry = {
  kind: "comment_activity";
  id: string;
  item: Extract<LiveItem, { itemType: "agent_message" }>;
  activities: TimelineActivity[];
};

type TimelineEntry = {
  kind: string;
  id: string;
  [key: string]: unknown;
};

export function attachCommentaryActivities<T extends TimelineEntry>(entries: T[]) {
  const result: Array<T | CommentaryActivityEntry> = [];
  let activeComment: CommentaryActivityEntry | null = null;

  for (const entry of entries) {
    if (isStructuredCommentEntry(entry)) {
      activeComment = {
        kind: "comment_activity",
        id: `comment-activity:${entry.id}`,
        item: entry.item,
        activities: []
      };
      result.push(activeComment);
      continue;
    }

    if (activeComment && isAttachableActionGroup(entry)) {
      activeComment.activities.push(...entry.items.map(({ id, item }) => ({
        id,
        item,
        groupType: entry.groupType
      })));
      continue;
    }

    result.push(entry);
  }

  return result;
}

export function commentaryActivityCounts(activities: TimelineActivity[]) {
  const commandCount = activities.filter((activity) => activity.groupType === "command").length;
  const searchCount = activities.filter((activity) => activity.groupType === "search").length;
  const editActivities = activities.filter((activity) => activity.groupType === "edit");
  const changedPaths = new Set(
    editActivities.flatMap(({ item }) => item.itemType === "file_change"
      ? item.changes.map((change) => change.path).filter(Boolean)
      : [])
  );
  return {
    commandCount,
    editCount: changedPaths.size || editActivities.length,
    searchCount
  };
}

export function commentaryTypeForActivities(
  type: StructuredCommentType,
  _activities: TimelineActivity[]
): StructuredCommentType {
  return type;
}

function isStructuredCommentEntry(entry: TimelineEntry): entry is TimelineItemEntry & TWithComment {
  if (entry.kind !== "item") return false;
  const item = (entry as TimelineItemEntry).item;
  return item.itemType === "agent_message" && Boolean(item.comment);
}

function isAttachableActionGroup(entry: TimelineEntry): entry is TimelineActionGroupEntry & {
  groupType: "command" | "edit" | "search";
} {
  if (entry.kind !== "action_group") return false;
  const group = entry as TimelineActionGroupEntry;
  return (group.groupType === "command" || group.groupType === "edit" || group.groupType === "search") && group.items.length > 0;
}

type TWithComment = {
  item: Extract<LiveItem, { itemType: "agent_message" }> & { comment: NonNullable<Extract<LiveItem, { itemType: "agent_message" }>["comment"]> };
};
