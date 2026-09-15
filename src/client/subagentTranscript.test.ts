import assert from "node:assert/strict";
import test from "node:test";
import {
  isExactRootSubagentActivity,
  parseSubagentTranscriptPayload,
  visibleSubagentAgents,
} from "./subagentTranscript";

test("identifies only the exact /root parent activity", () => {
  assert.equal(
    isExactRootSubagentActivity({
      itemType: "subagent",
      label: "/root",
      status: "interacted",
      agents: [{ id: "parent", name: "/root", status: "interacted" }],
    }),
    true,
  );
  assert.equal(
    isExactRootSubagentActivity({
      itemType: "subagent",
      label: "/root/inspect_ui",
      status: "started",
      agents: [{ id: "child", name: "/root/inspect_ui", status: "started" }],
    }),
    false,
  );
  assert.equal(
    isExactRootSubagentActivity({
      itemType: "subagent",
      agents: [
        { id: "parent", name: "/root", status: "running" },
        { id: "child", name: "/root/child", status: "running" },
      ],
    }),
    false,
  );
});

test("removes a redundant empty inner activity row but keeps meaningful messages", () => {
  const item = {
    itemType: "subagent",
    label: "/root/inspect_ui",
    status: "Started",
    agents: [
      { id: "child", name: "/root/inspect_ui", status: "started" },
      { id: "child-message", name: "/root/inspect_ui", status: "started", message: "Checking the UI" },
      { id: "other", name: "/root/other", status: "started" },
    ],
  };
  assert.deepEqual(
    visibleSubagentAgents(item).map((agent) => agent.id),
    ["child-message", "other"],
  );
});

test("parses transcript turns and drops malformed items defensively", () => {
  const payload = parseSubagentTranscriptPayload({
    sessionId: "session-1",
    threadId: "thread-1",
    turns: [
      {
        id: "turn-1",
        status: "done",
        items: [
          {
            id: "message-1",
            eventType: "item.completed",
            itemType: "agent_message",
            text: "Finished inspection",
          },
          { itemType: "reasoning", text: "missing identifiers" },
        ],
      },
    ],
  });

  assert.equal(payload.turns.length, 1);
  assert.equal(payload.turns[0]?.items.length, 1);
  assert.equal(payload.turns[0]?.items[0]?.itemType, "agent_message");
});
