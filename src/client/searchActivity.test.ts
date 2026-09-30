import assert from "node:assert/strict";
import test from "node:test";
import type { LiveItem } from "./appTypes.js";
import { buildMessageIndicatorMarks } from "./sessionHelpers03.js";
import { actionGroupTitle, compactLiveItemGroup, compactTimelineEntries } from "./sessionHelpers01.js";

function search(id: string): LiveItem {
  return { id, itemType: "web_search", eventType: "item.completed", query: `query ${id}` };
}

type SubagentTimelineCard = Extract<LiveItem, { itemType: "subagent" }> & {
  activityUpdates: Array<Extract<LiveItem, { itemType: "subagent" }>>;
};

test("compacts consecutive web searches into one search action group", () => {
  const compactGroup = (item: LiveItem) => compactLiveItemGroup({ isCommandLiveItem: () => false }, item);
  const entries = compactTimelineEntries({ compactLiveItemGroup: compactGroup }, [
    { id: "live:search-1", type: "live", item: search("search-1") },
    { id: "live:search-2", type: "live", item: search("search-2") }
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "action_group");
  assert.equal(entries[0]?.groupType, "search");
  assert.equal(entries[0]?.items.length, 2);
  assert.equal(
    actionGroupTitle(
      { collectFileChanges: () => [], subagentNames: () => [] },
      entries[0]?.items.map(({ item }: { item: LiveItem }) => item),
      "search"
    ),
    "Searched 2 queries"
  );
});

test("renders one subagent entry per child with the latest status and retained task updates", () => {
  const subagent = (
    id: string,
    threadId: string,
    label: string,
    status: string,
    prompt?: string,
    message?: string
  ): LiveItem => ({
    id,
    itemType: "subagent",
    eventType: status === "started" ? "item.started" : "item.completed",
    tool: "activity",
    status,
    label,
    receiverThreadIds: [threadId],
    ...(prompt ? { prompt } : {}),
    agents: [{ id: threadId, name: label, status, ...(message ? { message } : {}) }]
  });
  const compactGroup = (item: LiveItem) => compactLiveItemGroup({ isCommandLiveItem: () => false }, item);
  const segments = [
    subagent("standards-start", "thread-standards", "/root/standards", "started", "Review standards"),
    subagent("spec-start", "thread-spec", "/root/spec", "started", "Review spec"),
    subagent("standards-done", "thread-standards", "/root/standards", "completed", undefined, "Standards findings"),
    subagent("spec-followup", "thread-spec", "/root/spec", "interacted", "Check the edge case"),
    {
      id: "unattributed-status",
      itemType: "subagent",
      eventType: "item.completed",
      tool: "wait_agent",
      status: "completed",
      receiverThreadIds: [],
      agents: []
    } as LiveItem,
    subagent("spec-done", "thread-spec", "/root/spec", "completed", undefined, "Spec findings")
  ].map((item) => ({ id: `live:${item.id}`, type: "live" as const, item }));

  const entries = compactTimelineEntries({ compactLiveItemGroup: compactGroup }, segments);
  const agentEntries = entries.filter((entry) => entry.kind === "item" && entry.item.itemType === "subagent") as Array<{
    item: SubagentTimelineCard;
  }>;

  assert.equal(entries.length, 2);
  assert.deepEqual(agentEntries.map(({ item }) => [item.label, item.status]), [
    ["/root/standards", "completed"],
    ["/root/spec", "completed"]
  ]);
  assert.deepEqual(agentEntries[0]?.item.activityUpdates.map((item) => item.prompt), ["Review standards", undefined]);
  assert.deepEqual(agentEntries[0]?.item.agents.map((agent: { message?: string }) => agent.message), ["Standards findings"]);
  assert.deepEqual(agentEntries[1]?.item.activityUpdates.map((item) => item.prompt), [
    "Review spec",
    "Check the edge case",
    undefined
  ]);
  assert.deepEqual(agentEntries[1]?.item.agents.map((agent: { message?: string }) => agent.message), ["Spec findings"]);

  const completedToolCall = subagent("tool-completed", "thread-running", "/root/running", "completed");
  if (completedToolCall.itemType === "subagent") completedToolCall.agents[0]!.status = "running";
  const runningEntry = compactTimelineEntries({ compactLiveItemGroup: compactGroup }, [
    { id: `live:${completedToolCall.id}`, type: "live", item: completedToolCall }
  ])[0];
  assert.equal(runningEntry?.kind === "item" ? runningEntry.item.status : undefined, "running");
});

test("keeps a single purple scroll-rail mark for multiple subagent cards in one turn", () => {
  const first = {
    id: "agent-a",
    itemType: "subagent",
    eventType: "item.completed",
    tool: "activity",
    status: "completed",
    label: "/root/agent_a",
    receiverThreadIds: ["thread-a"],
    agents: []
  } as LiveItem;
  const second = { ...first, id: "agent-b", label: "/root/agent_b", receiverThreadIds: ["thread-b"] } as LiveItem;
  const compactGroup = (item: LiveItem) => compactLiveItemGroup({ isCommandLiveItem: () => false }, item);
  const segments = [first, second].map((item) => ({ id: `live:${item.id}`, type: "live" as const, item }));
  const marks = buildMessageIndicatorMarks({
    actionGroupTitle: () => "",
    appendSteerSegment: (current: unknown[]) => current,
    compactIndicatorTitle: (value: string, fallback: string) => value || fallback,
    compactTimelineEntries: (current: typeof segments) => compactTimelineEntries({ compactLiveItemGroup: compactGroup }, current),
    compareSteerMessages: () => 0,
    isDisplayableMessageSegment: () => true,
    liveItemKey: (item: LiveItem) => item.id,
    messageIndicatorItemTitle: (item: LiveItem) => item.itemType === "subagent" ? item.label ?? "Subagent" : "Activity",
    messageIndicatorTitle: () => "",
    messageIndicatorToneForGroup: () => "agent",
    messageIndicatorToneForItem: (item: LiveItem) => item.itemType === "subagent" ? "subagent" : "agent",
    removeLastTextSegment: (current: typeof segments) => current,
    timelineAnchorId: (messageId: string, entryId: string) => `timeline:${messageId}:${entryId}`
  }, [
    { id: "assistant-turn", role: "assistant", turnId: "turn-1", turnStatus: "running", segments },
    {
      id: "assistant-turn-followup",
      role: "assistant",
      turnId: "turn-1",
      turnStatus: "running",
      segments: [segments[1] as (typeof segments)[number]]
    }
  ]);

  const subagentMarks = marks.filter((mark: { tone: string; anchorId?: string }) => mark.tone === "subagent");
  assert.equal(subagentMarks.length, 1);
  assert.equal(subagentMarks[0]?.anchorId, "timeline:assistant-turn:subagent:live:agent-a:identity:thread-a");
});
