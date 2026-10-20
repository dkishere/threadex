import assert from "node:assert/strict";
import test from "node:test";
import { compactTimelineEntries } from "./sessionHelpers01";
import { subagentPromptRecord } from "../server/subagentPromptRecord";

test("saved prompts join the native card without replacing its status or label", () => {
  const native = { ...claudeAgent("native", "Done"), label: "/root/check", receiverThreadIds: ["child"] };
  const record = subagentPromptRecord({ threadId: "child", kind: "spawn", prompt: "檢查原文" });
  const entries = compactTimelineEntries({ compactLiveItemGroup: () => null }, [
    { type: "live", id: "native", item: native }, { type: "live", id: "record", item: record }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].item.status, "completed");
  assert.ok(entries[0].item.activityUpdates.some((item: any) => item.prompt === "檢查原文"));
});

function claudeAgent(id: string, message: string) {
  return {
    id,
    eventType: "item.completed",
    itemType: "subagent",
    tool: "spawn_agent",
    status: "completed",
    label: "Search code",
    receiverThreadIds: [],
    prompt: `Find ${id}`,
    agents: [{ id, name: "Explore", status: "completed", message }]
  };
}

test("child commentary and commands appear only inside the subagent transcript", () => {
  const childComment = { type: "live", id: "child-comment", item: {
    id: "comment", itemType: "agent_message", originThreadId: "child", text: "Working on it",
    comment: { detail: "Working on it", extracts: [] }
  } };
  const childCommand = { type: "live", id: "child-command", item: {
    id: "command", itemType: "command_execution", originThreadId: "child", command: "npm test"
  } };
  const parentComment = { type: "live", id: "parent-comment", item: {
    id: "parent", itemType: "agent_message", originThreadId: "root", text: "Reviewing the result"
  } };
  const card = { type: "live", id: "card", item: {
    id: "activity", itemType: "subagent", tool: "activity", originThreadId: "root",
    label: "/root/worker", receiverThreadIds: ["child"], agents: [], status: "running"
  } };
  const ctx = { compactLiveItemGroup: () => null };
  const source = [childComment, parentComment, card, childCommand];
  const entries = compactTimelineEntries(ctx, source);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "parent-comment");
  assert.equal(entries[1].item.itemType, "subagent");
  assert.equal(source.length, 4, "stored child events remain available");
  assert.deepEqual(compactTimelineEntries(ctx, [childComment, childCommand]).map((entry: any) => entry.id),
    ["child-comment", "child-command"], "child transcript retains its own content");
});

test("separate Claude Agent calls with the same label keep their own prompts and results", () => {
  const entries = compactTimelineEntries({ compactLiveItemGroup: () => null }, [
    { type: "live", id: "segment-1", item: claudeAgent("tool-1", "Found first") },
    { type: "live", id: "segment-2", item: claudeAgent("tool-2", "Found second") }
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry: any) => entry.item?.prompt), ["Find tool-1", "Find tool-2"]);
  assert.deepEqual(entries.map((entry: any) => entry.item?.agents[0]?.message), ["Found first", "Found second"]);
});
