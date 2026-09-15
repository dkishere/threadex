import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSubagentTranscript,
  subagentThreadBelongsToRoot
} from "./subagentTranscript.js";

function threadResult(input: {
  id: string;
  parentThreadId?: string | null;
  sessionId?: string;
  turns?: unknown[];
}) {
  return {
    thread: {
      id: input.id,
      parentThreadId: input.parentThreadId ?? null,
      sessionId: input.sessionId ?? "tree-1",
      path: `/codex/sessions/${input.id}.jsonl`,
      turns: input.turns ?? []
    }
  };
}

test("subagent ownership follows a bounded parent chain and rejects the root or another tree", async () => {
  const reads: string[] = [];
  const owned = await subagentThreadBelongsToRoot({
    rootThreadId: "root-thread",
    requestedThreadId: "grandchild-thread",
    requestedThreadResult: threadResult({ id: "grandchild-thread", parentThreadId: "child-thread" }),
    readThread: async (threadId) => {
      reads.push(threadId);
      return threadResult({ id: threadId, parentThreadId: "root-thread" });
    }
  });
  assert.equal(owned, true);
  assert.deepEqual(reads, ["child-thread"]);

  assert.equal(await subagentThreadBelongsToRoot({
    rootThreadId: "root-thread",
    requestedThreadId: "root-thread",
    requestedThreadResult: threadResult({ id: "root-thread" }),
    readThread: async () => assert.fail("the root must be rejected without another read")
  }), false);

  assert.equal(await subagentThreadBelongsToRoot({
    rootThreadId: "root-thread",
    requestedThreadId: "foreign-thread",
    requestedThreadResult: threadResult({ id: "foreign-thread", parentThreadId: "other-root" }),
    readThread: async (threadId) => threadResult({ id: threadId, parentThreadId: null, sessionId: "other-tree" })
  }), false);
});

test("subagent transcript exposes delegated input and reasoning and merges only child-attributed live items", () => {
  const result = normalizeSubagentTranscript({
    sessionId: "session-1",
    threadId: "child-thread",
    threadReadResult: threadResult({
      id: "child-thread",
      parentThreadId: "root-thread",
      turns: [{
        id: "child-turn",
        status: "completed",
        items: [
          {
            id: "delegated-1",
            type: "userMessage",
            content: [{ type: "text", text: "Inspect the server flow." }]
          },
          {
            id: "reasoning-1",
            type: "reasoning",
            summary: ["Checked ingestion."],
            content: ["Found the dropped attribution."]
          },
          { id: "answer-1", type: "agentMessage", text: "Historical answer." }
        ]
      }]
    }),
    liveItemsByTurn: {
      "manager-turn": [
        {
          id: "answer-1",
          eventType: "item.completed",
          itemType: "agent_message",
          text: "Persisted child answer.",
          originThreadId: "child-thread",
          originTurnId: "child-turn",
          sortCreated: "2026-01-01T00:00:01Z"
        },
        {
          id: "command-1",
          eventType: "item.completed",
          itemType: "command_execution",
          command: "rg attribution src/server",
          aggregatedOutput: "one match",
          status: "completed",
          exitCode: 0,
          originThreadId: "child-thread",
          originTurnId: "child-turn",
          sortCreated: "2026-01-01T00:00:02Z"
        },
        {
          id: "compact-1",
          eventType: "item.completed",
          itemType: "context_compaction",
          originThreadId: "child-thread",
          originTurnId: "child-turn",
          sortCreated: "2026-01-01T00:00:03Z"
        },
        {
          id: "root-only",
          eventType: "item.completed",
          itemType: "agent_message",
          text: "Do not leak this root item.",
          originThreadId: "root-thread",
          originTurnId: "root-turn"
        }
      ]
    }
  });

  assert.equal(result.sessionId, "session-1");
  assert.equal(result.threadId, "child-thread");
  assert.equal(result.turns.length, 1);
  const items = result.turns[0].items;
  assert.deepEqual(items.map((item) => item.id), ["delegated-1", "reasoning-1", "answer-1", "command-1", "compact-1"]);
  assert.equal(items[0].itemType, "agent_message");
  assert.equal(items[0].itemType === "agent_message" ? items[0].phase : null, "delegated_task");
  assert.equal(items[1].itemType === "reasoning" ? items[1].text : null, "Checked ingestion.\nFound the dropped attribution.");
  assert.equal(items[2].itemType === "agent_message" ? items[2].text : null, "Persisted child answer.");
  assert.equal(items.every((item) => item.originThreadId === "child-thread"), true);
});

test("subagent transcript bounds item count and long message text", () => {
  const items = Array.from({ length: 600 }, (_, index) => ({
    id: `message-${index}`,
    type: "agentMessage",
    text: index === 599 ? "x".repeat(80_000) : `message ${index}`
  }));
  const result = normalizeSubagentTranscript({
    sessionId: "session-1",
    threadId: "child-thread",
    threadReadResult: threadResult({
      id: "child-thread",
      parentThreadId: "root-thread",
      turns: [{ id: "child-turn", status: "completed", items }]
    })
  });

  assert.equal(result.turns[0].items.length, 512);
  assert.equal(result.turns[0].items[0].id, "message-88");
  const finalItem = result.turns[0].items.at(-1);
  assert.equal(finalItem?.itemType, "agent_message");
  assert.equal(finalItem?.itemType === "agent_message" ? finalItem.text.length : 0, 64 * 1024);
  assert.equal(finalItem?.itemType === "agent_message" ? finalItem.text.endsWith("…") : false, true);
});
