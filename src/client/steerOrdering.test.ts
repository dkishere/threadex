import assert from "node:assert/strict";
import test from "node:test";
import { appendSteerSegment, mergeSnapshotSegmentsWithLocalSteers, steerSegmentFromMessage, streamItemsToSegments } from "./sessionHelpers01";

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
