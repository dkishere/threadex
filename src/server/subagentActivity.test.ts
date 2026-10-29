import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeSubagentActivity, SUBAGENT_ACTIVITY_RETAINED_PER_AGENT, SUBAGENT_ACTIVITY_TEXT_MAX_CHARS,
  type SubagentActivityPayload } from "../eventProtocol";
import { collectSendMessages } from "../client/sendMessageView";
import { ClaudeStreamMapper } from "./claudeEvents";
import { clientEventPage } from "./eventPoll";
import { RunnerStreamForwarder } from "./runnerStreamForwarder";
import { SessionStore } from "./sessionStore.js";
import { subagentHeartbeatStreamKey, summarizeSubagentActivity } from "./subagentActivity";

const agentId = "toolu_parent_agent";
const at = (second: number) => new Date(Date.UTC(2026, 9, 26, 14, 20, second)).toISOString();
const activity = (seq: number, kind: SubagentActivityPayload["kind"], extra: Partial<SubagentActivityPayload> = {}): SubagentActivityPayload =>
  ({ agentId, source: "claude", kind, seq, at: at(seq % 60), ...extra });

async function withStore(run: (store: SessionStore) => Promise<void>) {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "subagent-activity-")), "test.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    await store.recordSessionTurn({ id: "turn", sessionId: "session", userInput: "go", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    await store.recordSessionTurn({ id: "other", sessionId: "session", userInput: "later", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "done" });
    await run(store);
  } finally {
    await store.close();
  }
}

const record = (store: SessionStore, entry: SubagentActivityPayload, jsonlIndex: number | null = entry.seq, turnId = "turn") =>
  store.recordSubagentActivity({ sessionId: "session", turnId, eventId: `event-${entry.agentId}-${entry.seq}`, jsonlIndex, activity: entry });

test("normalizer keeps the contract shape, bounds text and rejects unkeyed payloads", () => {
  const normalized = normalizeSubagentActivity({
    agentId: ` ${agentId} `, source: "claude", kind: "heartbeat", seq: 4, at: "2026-10-26T14:20:00Z",
    text: "x".repeat(SUBAGENT_ACTIVITY_TEXT_MAX_CHARS + 50), elapsedMs: 61000.7, lastActivityAt: "2026-10-26T14:19:59Z",
    processAlive: true, waiting: "nope", injected: { huge: true }
  });
  assert.equal(normalized?.agentId, agentId);
  assert.equal(normalized?.text?.length, SUBAGENT_ACTIVITY_TEXT_MAX_CHARS);
  assert.deepEqual({ ...normalized, text: undefined }, { agentId, source: "claude", kind: "heartbeat", seq: 4,
    at: "2026-10-26T14:20:00.000Z", text: undefined, elapsedMs: 61000, lastActivityAt: "2026-10-26T14:19:59.000Z", processAlive: true });
  assert.equal(normalizeSubagentActivity({ agentId, kind: "finished", seq: 9 }, at(1))?.status, "completed", "finished defaults to completed");
  assert.equal(normalizeSubagentActivity({ agentId, kind: "finished", seq: 9 })?.at, undefined, "an event needs a timestamp");
  for (const invalid of [null, [], { kind: "progress", seq: 1, at: at(1) }, { agentId, kind: "bogus", seq: 1, at: at(1) },
    { agentId, kind: "progress", seq: -1, at: at(1) }, { agentId, kind: "progress", seq: 1.5, at: at(1) },
    { agentId, kind: "progress", seq: 1, at: at(1), source: "codex" }]) {
    assert.equal(normalizeSubagentActivity(invalid), null, JSON.stringify(invalid));
  }
});

test("child activity persists under its parent tool_use and turn, deduped by (agentId, seq)", async () => {
  await withStore(async (store) => {
    assert.equal(await record(store, activity(0, "started", { description: "Commit 2" })), true);
    assert.equal(await record(store, activity(1, "message", { text: "Reading files" })), true);
    assert.equal(await record(store, activity(1, "message", { text: "Reading files" })), false, "replayed seq is a duplicate");
    assert.equal(await record(store, { ...activity(0, "progress"), agentId: "toolu_other" }, 0, "other"), true);
    const byTurn = await store.listSessionSubagentActivity("session");
    assert.deepEqual(byTurn.turn?.map((entry) => [entry.agentId, entry.seq, entry.kind]), [[agentId, 0, "started"], [agentId, 1, "message"]]);
    assert.deepEqual(byTurn.other?.map((entry) => entry.agentId), ["toolu_other"]);
    assert.deepEqual(Object.keys(await store.listSessionSubagentActivity("session", ["other"])), ["other"]);
  });
});

test("only the latest heartbeat is retained, even when an older one is replayed later", async () => {
  await withStore(async (store) => {
    await record(store, activity(5, "heartbeat", { elapsedMs: 60000, processAlive: true }));
    await record(store, activity(7, "heartbeat", { elapsedMs: 120000, processAlive: true }));
    await record(store, activity(6, "heartbeat", { elapsedMs: 90000, processAlive: true }));
    const heartbeats = (await store.listSessionSubagentActivity("session")).turn?.filter((entry) => entry.kind === "heartbeat");
    assert.deepEqual(heartbeats?.map((entry) => [entry.seq, entry.elapsedMs]), [[7, 120000]]);
  });
});

test("activity is capped per agent while lifecycle events are kept", async () => {
  await withStore(async (store) => {
    const extra = 5;
    await record(store, activity(0, "started"));
    for (let seq = 1; seq <= SUBAGENT_ACTIVITY_RETAINED_PER_AGENT + extra; seq += 1) {
      await record(store, activity(seq, seq % 2 ? "message" : "tool", { text: `step ${seq}` }));
    }
    await record(store, activity(2, "message", { text: "late replay of a pruned event" }));
    const entries = (await store.listSessionSubagentActivity("session")).turn ?? [];
    const activityEntries = entries.filter((entry) => entry.kind !== "started");
    assert.equal(activityEntries.length, SUBAGENT_ACTIVITY_RETAINED_PER_AGENT);
    assert.equal(activityEntries[0]?.seq, extra + 1);
    assert.equal(entries[0]?.kind, "started");
  });
});

test("finished closes the live subagent card unless a later runner item superseded it", async () => {
  await withStore(async (store) => {
    const card = { id: agentId, eventType: "item.updated", itemType: "subagent", tool: "spawn_agent", status: "inProgress",
      receiverThreadIds: [], agents: [{ id: agentId, name: "general-purpose", status: "running" }] };
    await store.recordSessionTurnEvent({ id: "card", turnId: "turn", sessionId: "session", eventName: "item", payload: card, jsonlIndex: 3 });
    await record(store, activity(20, "finished", { status: "failed" }), 40);
    let item = (await store.listSessionTurnLiveItems("session", "turn"))[0] as Record<string, unknown>;
    assert.equal(item.status, "failed");
    assert.equal(item.eventType, "item.completed");
    assert.deepEqual((item.agents as Array<Record<string, unknown>>).map((agent) => agent.status), ["failed"]);

    // A newer runner item (higher jsonl index) wins over a stale finished replay.
    await store.recordSessionTurnEvent({ id: "card-2", turnId: "turn", sessionId: "session", eventName: "item",
      payload: { ...card, status: "completed", eventType: "item.completed", agents: [{ id: agentId, status: "completed" }] }, jsonlIndex: 50 });
    await store.recordSubagentActivity({ sessionId: "session", turnId: "turn", eventId: "late", jsonlIndex: 45,
      activity: activity(21, "finished", { status: "stopped" }) });
    item = (await store.listSessionTurnLiveItems("session", "turn"))[0] as Record<string, unknown>;
    assert.equal(item.status, "completed");
  });
});

test("SendMessage records survive reload on the main-session card and on a sub-agent's activity", async () => {
  await withStore(async (store) => {
    const sendMessage = { toolUseId: "toolu_send", sender: { kind: "main" }, to: "aa822c2fcdb3b1b3a", recipientAgentId: agentId,
      summary: "Fix drift", message: "繼續", status: "sent", resultSummary: "{\"success\":true}", at: at(1), completedAt: at(2) };
    const card = { id: "toolu_send", eventType: "item.completed", itemType: "subagent", tool: "send_message", status: "completed",
      label: "Fix drift", prompt: "繼續", receiverThreadIds: [agentId], sendMessage,
      agents: [{ id: agentId, name: "aa822c2fcdb3b1b3a", status: "completed" }] };
    await store.recordSessionTurnEvent({ id: "send", turnId: "turn", sessionId: "session", eventName: "item", payload: card, jsonlIndex: 3 });
    const item = (await store.listSessionTurnLiveItems("session", "turn"))[0] as Record<string, unknown>;
    assert.deepEqual(item.sendMessage, sendMessage);

    const childSend = { ...sendMessage, toolUseId: "toolu_child", sender: { kind: "subagent", agentId } };
    assert.equal(await record(store, activity(5, "send_message", { sendMessage: childSend } as Partial<SubagentActivityPayload>)), true);
    assert.equal(await record(store, activity(5, "send_message", { sendMessage: childSend } as Partial<SubagentActivityPayload>)), false);
    const events = (await store.listSessionSubagentActivity("session")).turn ?? [];
    assert.deepEqual(events.map((entry) => [entry.kind, entry.sendMessage?.toolUseId, entry.sendMessage?.sender]),
      [["send_message", "toolu_child", { kind: "subagent", agentId }]]);
  });
});

test("SendMessage end to end: runner mapper output persists and reloads into one card per message", async () => {
  await withStore(async (store) => {
    const mapper = new ClaudeStreamMapper();
    const outputs = [
      { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: agentId, name: "Agent", input: { description: "w", subagent_type: "general-purpose", name: "worker", prompt: "go" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: agentId, content: "Async agent launched successfully.\nagentId: a1b2c3" }] } },
      { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "toolu_main_send", name: "SendMessage", input: { to: "a1b2c3", summary: "Resume", message: "continue" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_main_send", content: "{\"success\":true}" }] } },
      { type: "assistant", parent_tool_use_id: agentId, message: { id: "c1", content: [{ type: "tool_use", id: "toolu_child_send", name: "SendMessage", input: { to: "worker", message: "self note" } }] } },
      { type: "user", parent_tool_use_id: agentId, message: { content: [{ type: "tool_result", tool_use_id: "toolu_child_send", content: "ok" }] } }
    ].flatMap((frame) => mapper.handle(frame));
    let index = 0;
    for (const output of outputs) {
      index += 1;
      if (output.kind === "item") await store.recordSessionTurnEvent({ id: `e${index}`, turnId: "turn", sessionId: "session", eventName: "item", payload: output.item, jsonlIndex: index });
      if (output.kind === "subagent_activity") await store.recordSubagentActivity({ sessionId: "session", turnId: "turn", eventId: `e${index}`, jsonlIndex: index, activity: output.payload });
    }
    const liveItems = await store.listSessionTurnLiveItems("session", "turn");
    const snapshot = summarizeSubagentActivity((await store.listSessionSubagentActivity("session")).turn ?? [], false);
    const views = collectSendMessages(liveItems, snapshot.flatMap((agent) => agent.events));
    assert.deepEqual(views.map((view) => [view.record.toolUseId, view.record.sender.kind, view.record.recipientAgentId, view.record.status]).sort(),
      [["toolu_child_send", "subagent", agentId, "sent"], ["toolu_main_send", "main", agentId, "sent"]]);
  });
});

test("send_message activity needs a valid record, which is re-bounded on read", () => {
  assert.equal(normalizeSubagentActivity({ agentId, kind: "send_message", seq: 1, at: at(1) }), null);
  assert.equal(normalizeSubagentActivity({ agentId, kind: "send_message", seq: 1, at: at(1), sendMessage: { toolUseId: "t", to: "x", at: at(1) } }), null,
    "a record without a sender is rejected");
  const normalized = normalizeSubagentActivity({ agentId, kind: "send_message", seq: 1, at: at(1),
    sendMessage: { toolUseId: "t", sender: { kind: "subagent", agentId }, to: "peer", message: "y".repeat(9000), status: "weird", at: at(1) } });
  assert.equal(normalized?.sendMessage?.message.length, 8000);
  assert.equal(normalized?.sendMessage?.messageTruncated, true);
  assert.equal(normalized?.sendMessage?.omittedMessageChars, 1001);
  assert.equal(normalized?.sendMessage?.status, "pending");
  assert.equal(normalizeSubagentActivity({ agentId, kind: "tool", seq: 2, at: at(1), sendMessage: { toolUseId: "t" } })?.sendMessage, undefined,
    "only send_message events carry a record");
});

test("snapshot reports the latest heartbeat and closes agents of an ended turn", () => {
  const entries = [activity(0, "started"), activity(3, "heartbeat", { lastActivityAt: at(40), processAlive: true }),
    activity(1, "message", { text: "hi" }), activity(1, "message", { text: "hi" })];
  const [running] = summarizeSubagentActivity(entries, true);
  assert.equal(running?.state, "running");
  assert.equal(running?.latestSeq, 3);
  assert.equal(running?.heartbeat?.seq, 3);
  assert.deepEqual(running?.events.map((entry) => entry.seq), [0, 1]);
  assert.equal(running?.lastActivityAt, at(40));
  assert.equal(summarizeSubagentActivity(entries, false)[0]?.state, "ended");
  const [finished] = summarizeSubagentActivity([...entries, activity(4, "finished", { status: "completed" })], false);
  assert.deepEqual([finished?.state, finished?.status], ["finished", "completed"]);
});

test("runner SSE replay sends every activity event but only the latest heartbeat per agent", async () => {
  type Entry = { event: string; data: SubagentActivityPayload };
  const sent: number[] = [];
  const forwarder = new RunnerStreamForwarder<Entry>({
    apply: async () => undefined,
    emit: (entry) => sent.push(entry.data.seq),
    itemKey: (entry) => subagentHeartbeatStreamKey(entry.event, normalizeSubagentActivity(entry.data)),
    isTerminal: () => false
  });
  const backlog = [activity(0, "started"), activity(1, "heartbeat"), activity(2, "message"), activity(3, "heartbeat"),
    { ...activity(4, "heartbeat"), agentId: "toolu_b" }, activity(5, "heartbeat")].map((data) => ({ event: "subagent_activity", data }));
  await forwarder.forward(backlog);
  assert.deepEqual(sent, [0, 5, 2, 4]);
  // Live delivery after the backlog forwards each new heartbeat at once.
  await forwarder.forward([{ event: "subagent_activity", data: activity(6, "heartbeat") }]);
  assert.deepEqual(sent.at(-1), 6);
});

test("event poll delivers compact liveness without activity text", () => {
  const page = clientEventPage([{ pos: 1, eventId: "e1", type: "runner.subagent_activity", workspaceId: "w", sessionId: "session",
    turnId: "turn", timestamp: at(1), payload: activity(2, "heartbeat", { text: "secret", processAlive: false, elapsedMs: 5 }) },
  { pos: 2, eventId: "e2", type: "runner.subagent_activity", workspaceId: "w", sessionId: "session", turnId: "turn",
    timestamp: at(2), payload: { kind: "heartbeat" } }], "w", 0);
  assert.deepEqual(page.events.map((event) => event.payload),
    [{ agentId, kind: "heartbeat", seq: 2, at: at(2), elapsedMs: 5, processAlive: false }, null]);
  assert.equal(page.nextPos, 2);
});
