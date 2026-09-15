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
  activities: TimelineActivity[]
): StructuredCommentType {
  if (activities.some((activity) => activityIndicatesEdit(activity))) return "edit";
  if (type === "edit" && activities.length > 0) return "action";
  return type;
}

function activityIndicatesEdit(activity: TimelineActivity) {
  return activity.groupType === "edit" || activity.item.itemType === "file_change" || (
    activity.item.itemType === "command_execution" &&
    commandIndicatesEdit(activity.item.command)
  );
}

function commandIndicatesEdit(command: string) {
  return shellCommandSources(command).some((source) => source
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => shellSegmentIndicatesEdit(segment)));
}

function shellCommandSources(command: string) {
  const sources = [command];
  for (const match of command.matchAll(/(?:^|\s)-(?:l)?c\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const shellPayload = match[1] ?? match[2];
    if (shellPayload) sources.push(shellPayload);
  }
  return sources;
}

function shellSegmentIndicatesEdit(segment: string) {
  const words = segment.trim().replace(/^[({]+/, "").split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const word = words[index]?.replace(/^["']+|["']+$/g, "") ?? "";
    const commandName = word.split("/").at(-1)?.toLowerCase() ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (commandName === "env" || commandName === "sudo" || commandName === "command" || commandName === "exec" || commandName === "nohup") {
      index += 1;
      while (words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (commandName === "edit") return true;
    if (commandName !== "sed") return false;
    return words.slice(index + 1).some((argument) => {
      const value = argument.replace(/^["']+|["']+$/g, "");
      return /^--in-place(?:=|$)/.test(value) || /^-[^-]*i/.test(value);
    });
  }
  return false;
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
