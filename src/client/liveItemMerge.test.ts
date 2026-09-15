import assert from "node:assert/strict";
import test from "node:test";
import { liveItemKey, mergeSnapshotLiveItems, withTurnLevelStatus } from "./liveItemMerge";

type Item = {
  id: string;
  originThreadId?: string;
  eventType: "item.started" | "item.updated" | "item.completed";
  value: string;
};

test("live item identity includes its origin thread", () => {
  assert.equal(
    liveItemKey({ id: "message-1", originThreadId: "child-thread" }),
    "child-thread:message-1",
  );

  const root: Item = {
    id: "message-1",
    eventType: "item.completed",
    value: "root response",
  };
  const child: Item = {
    id: "message-1",
    originThreadId: "child-thread",
    eventType: "item.completed",
    value: "child response",
  };

  assert.deepEqual(mergeSnapshotLiveItems([root], [child]), [root, child]);
});

test("newer revisions still replace items from the same origin thread", () => {
  const snapshot: Item = {
    id: "command-1",
    originThreadId: "child-thread",
    eventType: "item.started",
    value: "starting",
  };
  const current: Item = {
    ...snapshot,
    eventType: "item.completed",
    value: "finished",
  };
  assert.deepEqual(mergeSnapshotLiveItems([snapshot], [current]), [current]);
});

test("turn-level status distinguishes connecting from runner thinking", () => {
  const [connecting] = withTurnLevelStatus([] as any[], true, "Connecting");
  const [thinking] = withTurnLevelStatus([] as any[], true);

  assert.equal(connecting.item?.text, "Connecting");
  assert.equal(thinking.item?.text, "Thinking");
});
