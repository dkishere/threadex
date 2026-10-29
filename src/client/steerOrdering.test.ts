import assert from "node:assert/strict";
import test from "node:test";
import { appendSteerSegment, applyLiveItemToMessage, mergeSnapshotSegmentsWithLocalSteers, steerSegmentFromMessage, streamItemsToSegments, upsertLiveSegment } from "./sessionHelpers01";

const toSegment = (message: any) => steerSegmentFromMessage({}, message);
const append = (segments: any[], message: any) => appendSteerSegment({ steerSegmentFromMessage: toSegment }, segments, message);
const steer = { id: "s", content: "Change direction", createdAt: "2026-09-16T10:01:00Z" };
const snapshot = [
  { id: "before", type: "live", item: { sortCreated: "2026-09-16T10:00:00Z" } },
  { id: "after", type: "live", item: { sortCreated: "2026-09-16T10:02:00Z" } }
];
const ctx = {
  appendSteerSegment: append,
  steerSegmentFromMessage: toSegment,
  compareSteerMessages: () => 0,
  isDisplayableMessageSegment: () => true,
  normalizeMessageSegments: (segments: any[]) => segments
};

test("snapshot refresh never restores classified commentary text in either direction", () => {
  const text = { id: "agent::note:0", sourceId: "agent::note", type: "text", text: "Reading the runner" };
  const card = { id: "live::note", type: "live", item: { id: "note", itemType: "agent_message", comment: { detail: text.text } } };
  const tool = { id: "live::cmd", type: "live", item: { itemType: "command_execution" } };
  const answer = { id: "agent::answer", type: "text", text: "Fixed." };
  for (const [incoming, current] of [
    [[text, tool, answer], [card, tool, answer]],
    [[card, tool, answer], [text, tool, answer]],
    [[text, card, tool, answer], [card, tool, answer]],
    [[card, tool, answer], [text, card, tool, answer]],
    [[text, card, tool, answer], []]
  ]) {
    const result = mergeSnapshotSegmentsWithLocalSteers(ctx, incoming, current as never[]);
    assert.deepEqual(result, [card, tool, answer]);
    assert.deepEqual(mergeSnapshotSegmentsWithLocalSteers(ctx, [text, tool, answer], result as never[]), result);
  }
});

test("restored steers precede later events on fresh and existing snapshots", () => {
  for (const existing of [[], snapshot]) {
    const result = mergeSnapshotSegmentsWithLocalSteers(ctx, snapshot, existing as never[], [steer] as never[]);
    assert.deepEqual(result.map((segment: any) => segment.id), ["before", "steer:s", "after"]);
  }
});

test("existing steer positions remain stable and are not duplicated", () => {
  const existing = [snapshot[0], toSegment(steer), snapshot[1]];
  assert.deepEqual(mergeSnapshotSegmentsWithLocalSteers(ctx, snapshot, existing as never[], [steer] as never[]), existing);
  assert.deepEqual(append(existing, steer), existing);
  assert.equal(append(snapshot, { ...steer, createdAt: undefined }).at(-1).id, "steer:s");
});

test("restored plain text retains its timestamp for steer placement", () => {
  const segments = streamItemsToSegments({
    liveItemKey: (item: any) => item.id,
    appendTextSegment: (segments: any[], id: string, text: string) => [...segments, { id, type: "text", text }],
    normalizeMessageSegments: (segments: any[]) => segments
  }, [{ id: "reply", itemType: "agent_message", text: "Following the steer", sortCreated: "2026-09-16T10:02:00Z" }], undefined);
  assert.deepEqual(append(segments, steer).map((segment: any) => segment.id), ["steer:s", "agent:reply"]);
});

test("a later commentary item replaces its streamed plain text in place", () => {
  const liveCtx = { liveItemKey: (item: any) => item.id, liveItemForDisplay: (item: any) => item, isDisplayableLiveItem: () => true };
  const segments = streamItemsToSegments({
    liveItemKey: (item: any) => item.id,
    appendTextSegment: (segments: any[], id: string, text: string) => [...segments, { id: `${id}:0`, sourceId: id, type: "text", text }],
    normalizeMessageSegments: (segments: any[]) => segments,
    upsertLiveSegment: (segments: any[], item: any) => upsertLiveSegment(liveCtx, segments, item)
  }, [
    { id: "note", itemType: "agent_message", eventType: "item.completed", text: "Reading the runner" },
    { id: "cmd", itemType: "command_execution", eventType: "item.started", command: "cat runner.ts" },
    { id: "note", itemType: "agent_message", eventType: "item.completed", text: "Reading the runner", phase: "commentary", comment: { detail: "Reading the runner" } }
  ], undefined);
  assert.deepEqual(segments.map((segment: any) => segment.id), ["live:note", "live:cmd"]);
});

test("restored root final answers stay as text so earlier answers survive reload", () => {
  const liveCtx = {
    liveItemKey: (item: any) => item.id,
    liveItemForDisplay: (item: any) => item,
    isDisplayableLiveItem: (item: any) => !(item.itemType === "agent_message" && item.phase === "final_answer")
  };
  const report = "| Service | Uncovered |\n| --- | --- |\n| UM | 14 |\n| CP | 12 |";
  const segments = streamItemsToSegments({
    liveItemKey: (item: any) => item.id,
    appendTextSegment: (segments: any[], id: string, text: string) => [...segments, { id: `${id}:0`, sourceId: id, type: "text", text }],
    normalizeMessageSegments: (segments: any[]) => segments,
    upsertLiveSegment: (segments: any[], item: any) => upsertLiveSegment(liveCtx, segments, item)
  }, [
    { id: "child", itemType: "agent_message", eventType: "item.completed", phase: "final_answer", originThreadId: "child-thread", text: "Child report", comment: { detail: "Child report" } },
    { id: "report", itemType: "agent_message", eventType: "item.completed", phase: "final_answer", originThreadId: "root-thread", text: report, comment: { detail: report } },
    { id: "closure", itemType: "agent_message", eventType: "item.completed", phase: "final_answer", originThreadId: "root-thread", text: "The audit is complete.", comment: { detail: "The audit is complete." } }
  ], "root-thread");
  assert.deepEqual(segments.map((segment: any) => [segment.id, segment.text]), [
    ["agent:report:0", report],
    ["agent:closure:0", "The audit is complete."]
  ]);
});

test("replacing streamed text with commentary also removes it from the reply text", () => {
  const liveCtx = { liveItemKey: (item: any) => item.id, liveItemForDisplay: (item: any) => item, isDisplayableLiveItem: () => true };
  const message = applyLiveItemToMessage({
    ...liveCtx,
    finalizePendingReasoningItems: (items: any[]) => items,
    normalizeLiveItems: (items: any[]) => items,
    normalizeMessageSegments: (segments: any[]) => segments,
    upsertLiveSegment: (segments: any[], item: any) => upsertLiveSegment(liveCtx, segments, item)
  }, {
    content: "Earlier answer. Reading the runner",
    turnStatus: "running",
    segments: [
      { id: "agent:first:0", sourceId: "agent:first", type: "text", text: "Earlier answer. " },
      { id: "agent:note:0", sourceId: "agent:note", type: "text", text: "Reading the runner" }
    ]
  }, { id: "note", itemType: "agent_message", eventType: "item.completed", text: "Reading the runner", phase: "commentary", comment: { detail: "Reading the runner" } });
  assert.equal(message.content, "Earlier answer. ");
  assert.deepEqual(message.segments.map((segment: any) => segment.id), ["agent:first:0", "live:note"]);
});
