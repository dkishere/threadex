import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizePendingReasoningItems,
  finalizePendingReasoningSegments,
  mergeSnapshotLiveItems,
  withTurnLevelStatus
} from "../client/liveItemMerge.js";

type Item = {
  id: string;
  eventType: "item.started" | "item.updated" | "item.completed";
  value: string;
};

test("snapshot reconciliation preserves live items not persisted yet", () => {
  const snapshot: Item[] = [
    { id: "command-1", eventType: "item.completed", value: "durable command" }
  ];
  const current: Item[] = [
    { id: "command-1", eventType: "item.completed", value: "live command" },
    { id: "file-change-1", eventType: "item.completed", value: "edited App.tsx" }
  ];

  assert.deepEqual(mergeSnapshotLiveItems(snapshot, current), [
    { id: "command-1", eventType: "item.completed", value: "durable command" },
    { id: "file-change-1", eventType: "item.completed", value: "edited App.tsx" }
  ]);
});

test("snapshot reconciliation keeps the newer event revision", () => {
  const snapshot: Item[] = [
    { id: "file-change-1", eventType: "item.started", value: "starting" }
  ];
  const current: Item[] = [
    { id: "file-change-1", eventType: "item.completed", value: "finished" }
  ];

  assert.deepEqual(mergeSnapshotLiveItems(snapshot, current), current);
});

test("terminal cleanup removes empty reasoning placeholders and stops readable reasoning", () => {
  const items = [
    { id: "reasoning-empty", itemType: "reasoning", eventType: "item.started" as const, text: "" },
    { id: "reasoning-summary", itemType: "reasoning", eventType: "item.updated" as const, text: "Checked the event flow" },
    { id: "command-1", itemType: "command_execution", eventType: "item.completed" as const, text: "" }
  ];

  assert.deepEqual(finalizePendingReasoningItems(items), [
    { id: "reasoning-summary", itemType: "reasoning", eventType: "item.completed", text: "Checked the event flow" },
    { id: "command-1", itemType: "command_execution", eventType: "item.completed", text: "" }
  ]);
});

test("terminal cleanup applies the same reasoning rules to timeline segments", () => {
  const segments = [
    {
      id: "live:reasoning-empty",
      type: "live",
      item: { id: "reasoning-empty", itemType: "reasoning", eventType: "item.updated" as const, text: "" }
    },
    {
      id: "live:reasoning-summary",
      type: "live",
      item: { id: "reasoning-summary", itemType: "reasoning", eventType: "item.started" as const, text: "Verified" }
    },
    { id: "answer", type: "text", text: "Done" }
  ];

  assert.deepEqual(finalizePendingReasoningSegments(segments), [
    {
      id: "live:reasoning-summary",
      type: "live",
      item: { id: "reasoning-summary", itemType: "reasoning", eventType: "item.completed", text: "Verified" }
    },
    { id: "answer", type: "text", text: "Done" }
  ]);
});

test("running timelines collapse spans into one trailing status based on the latest work item", () => {
  const segments = [
    {
      id: "live:command-1",
      type: "live",
      item: { id: "command-1", itemType: "command_execution", eventType: "item.completed" as const }
    },
    {
      id: "live:reasoning-1",
      type: "live",
      item: { id: "reasoning-1", itemType: "reasoning", eventType: "item.completed" as const, text: "First span" }
    },
    {
      id: "live:reasoning-2",
      type: "live",
      item: { id: "reasoning-2", itemType: "reasoning", eventType: "item.started" as const, text: "" }
    },
    {
      id: "live:command-2",
      type: "live",
      item: { id: "command-2", itemType: "command_execution", eventType: "item.completed" as const }
    }
  ];

  const collapsed = withTurnLevelStatus(segments, true);
  assert.deepEqual(collapsed.map((segment) => segment.id), [
    "live:command-1",
    "live:command-2",
    "live:turn-level-status"
  ]);
  assert.equal(collapsed.filter((segment) => segment.item?.itemType === "reasoning").length, 1);
  assert.equal(collapsed.at(-1)?.item?.eventType, "item.started");
  assert.equal((collapsed.at(-1)?.item as { text?: string } | undefined)?.text, "Running");

  const editing = withTurnLevelStatus([
    ...segments,
    {
      id: "live:file-change-1",
      type: "live",
      item: { id: "file-change-1", itemType: "file_change", eventType: "item.started" as const }
    }
  ], true);
  assert.equal((editing.at(-1)?.item as { text?: string } | undefined)?.text, "Editing");

  const thinking = withTurnLevelStatus([
    ...segments,
    {
      id: "live:reasoning-latest",
      type: "live",
      item: { id: "reasoning-latest", itemType: "reasoning", eventType: "item.started" as const, text: "" }
    }
  ], true);
  assert.equal((thinking.at(-1)?.item as { text?: string } | undefined)?.text, "Thinking");

  assert.deepEqual(
    withTurnLevelStatus(segments, false).map((segment) => segment.id),
    ["live:command-1", "live:command-2"]
  );
});
