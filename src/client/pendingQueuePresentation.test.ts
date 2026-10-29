import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./appTypes";
import { partitionPendingQueueMessages } from "./pendingQueuePresentation";

const message = (id: string, role: "user" | "assistant", turnId: string, turnStatus: ChatMessage["turnStatus"], pendingReason?: ChatMessage["pendingReason"]): ChatMessage => ({
  id, role, turnId, turnStatus, pendingReason, content: id
});

test("backend queued turns stay in queue order until each starts", () => {
  const messages = [
    message("active:user", "user", "active", "running"),
    message("active:assistant", "assistant", "active", "running"),
    message("first:user", "user", "first", "todo", "queued"),
    message("first:assistant", "assistant", "first", "todo", "queued"),
    message("second:user", "user", "second", "todo", "queued"),
    message("second:assistant", "assistant", "second", "todo", "queued")
  ];
  const pending = partitionPendingQueueMessages(messages);
  assert.deepEqual(pending.queued.map(({ prompt }) => prompt.turnId), ["first", "second"]);
  assert.deepEqual(pending.transcript.map(({ id }) => id), ["active:user", "active:assistant"]);

  const started = messages.map((item) => item.turnId === "first" ? { ...item, turnStatus: "running" as const } : item);
  const afterStart = partitionPendingQueueMessages(started);
  assert.deepEqual(afterStart.queued.map(({ prompt }) => prompt.turnId), ["second"]);
  assert.deepEqual(afterStart.transcript.map(({ id }) => id), ["active:user", "active:assistant", "first:user", "first:assistant"]);
});

test("round table turns stay in transcript between stages and queue only behind another turn", () => {
  const roundtable = [message("rt_a:user", "user", "rt_a", "todo", "queued"), message("rt_a:assistant", "assistant", "rt_a", "todo", "queued")];
  const idle = partitionPendingQueueMessages(roundtable);
  assert.equal(idle.queued.length, 0);
  assert.deepEqual(idle.transcript.map(({ id }) => id), ["rt_a:user", "rt_a:assistant"]);

  const behind = partitionPendingQueueMessages([message("active:user", "user", "active", "running"),
    message("active:assistant", "assistant", "active", "running"), ...roundtable]);
  assert.deepEqual(behind.queued.map(({ prompt }) => prompt.turnId), ["rt_a"]);
});

test("account waits stay in transcript instead of the ordinary prompt queue", () => {
  const messages = [message("limit:user", "user", "limit", "todo", "rate_limit"), message("limit:assistant", "assistant", "limit", "todo", "rate_limit")];
  const result = partitionPendingQueueMessages(messages);
  assert.equal(result.queued.length, 0);
  assert.equal(result.transcript.length, 2);
});
