import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_EVENT_TYPES } from "../eventProtocol";
import { changedEventState, clientEvent, clientEventPage, versionEventState } from "./eventPoll";
import type { RingEvent } from "./eventRingLog";

function event(pos: number, type = "runner.result", payload: unknown = null, workspaceId: string | null = "one"): RingEvent {
  return { pos, eventId: `event-${pos}`, type, workspaceId, sessionId: "session", turnId: "turn", timestamp: "2026-09-22T10:00:00Z", payload };
}

test("client events omit redundant transcript payloads while preserving renderable data", (t) => {
  const entries = [
    event(1, "runner.item", { aggregatedOutput: "x".repeat(1024 * 1024) }),
    event(2, "runner.codex", { method: "item/tool/output", params: { output: "x".repeat(1024 * 1024) } }),
    event(3, "runner.result", { reply: "x".repeat(1024 * 1024) }),
    event(4, "runner.done", { diagnostics: "x".repeat(1024 * 1024) })
  ];
  const page = clientEventPage(entries, "one", 0);
  assert.deepEqual(page.events, [event(3), event(4, "runner.done")]);
  assert.equal(page.nextPos, 4);
  assert.equal(page.hasMore, false);
  const before = Buffer.byteLength(JSON.stringify(entries));
  const after = Buffer.byteLength(JSON.stringify(page));
  assert.ok(after < before / 1000);
  t.diagnostic(`Synthetic 4 MiB transcript fixture: ${before} bytes before, ${after} bytes in the client page`);
  for (const type of CLIENT_EVENT_TYPES) assert.ok(clientEvent(event(1, type)), type);
  for (const type of ["runner.approval.requested", "runner.developer_instructions", "todo.changed"]) {
    const input = event(1, type, { text: "must remain complete", nested: { options: ["A", "B"] } });
    assert.deepEqual(clientEvent(input), input);
  }
  assert.deepEqual(clientEvent(event(1, "runner.approval.resolved", { approvalId: "approval", params: "large" }))?.payload, { approvalId: "approval" });
  assert.deepEqual(clientEvent(event(1, "runner.runner.callback_error", { event: "done", stack: "large" }))?.payload, { event: "done" });
});

test("paged cursors skip irrelevant events but never advance past an undelivered event", () => {
  const entries = [event(1), event(2, "runner.item"), event(3, "runner.result", null, "other"), event(4), event(5, "runner.done"), event(6, "runner.item")];
  const first = clientEventPage(entries, "one", 0, { count: 1, bytes: 128 * 1024 });
  assert.deepEqual(first.events.map(item => item.pos), [1]);
  assert.equal(first.nextPos, 3);
  assert.equal(first.hasMore, true);
  const second = clientEventPage(entries, "one", first.nextPos, { count: 1, bytes: 128 * 1024 });
  assert.deepEqual(second.events.map(item => item.pos), [4]);
  const last = clientEventPage(entries, "one", second.nextPos, { count: 1, bytes: 128 * 1024 });
  assert.deepEqual(last.events.map(item => item.pos), [5]);
  assert.equal(last.nextPos, 6);
  assert.equal(last.hasMore, false);
  assert.equal(clientEventPage([event(1, "runner.item")], "one", 0).nextPos, 1);
});

test("byte budgets split pages without truncating large approval questions", () => {
  const approval = event(2, "runner.approval.requested", { questions: "x".repeat(5000) });
  const entries = [event(1), approval, event(3)];
  const first = clientEventPage(entries, "one", 0, { count: 128, bytes: 1024 });
  assert.equal(first.nextPos, 1);
  assert.equal(first.events.length, 1);
  const second = clientEventPage(entries, "one", 1, { count: 128, bytes: 1024 });
  assert.deepEqual(second.events, [approval]);
  assert.equal(second.nextPos, 2);
  assert.equal(second.hasMore, true);
});

test("client pages keep workspace isolation, global notifications and reset semantics", () => {
  const entries = [event(10, "workspace.switched", null, null), event(11)];
  assert.equal(clientEventPage(entries, "one", 8).resetRequired, true);
  assert.equal(clientEventPage(entries, "one", 12).resetRequired, true);
  assert.equal(clientEventPage([], "one", 1).resetRequired, true);
  assert.deepEqual(clientEventPage(entries, "other", 9).events.map(item => item.pos), [10]);
  assert.equal(clientEventPage(entries, "other", 9).nextPos, 11);
});

test("state versions omit unchanged sections and send explicit empty arrays for removals", () => {
  const state = { statusMonitor: [{ id: "other" }], processMonitors: [{ command: "large command" }], grillSummaries: [{ revision: 1 }] };
  const initial = versionEventState("one", state);
  const full = changedEventState(initial);
  assert.deepEqual(full.statusMonitor, state.statusMonitor);
  assert.deepEqual(changedEventState(versionEventState("one", structuredClone(state)), full.stateVersion), { stateVersion: full.stateVersion });
  const next = changedEventState(versionEventState("one", { ...state, grillSummaries: [] }), full.stateVersion);
  assert.deepEqual(Object.keys(next).sort(), ["grillSummaries", "stateVersion"]);
  assert.deepEqual(next.grillSummaries, []);
  assert.deepEqual(Object.keys(changedEventState(versionEventState("two", state), full.stateVersion)).sort(),
    ["grillSummaries", "processMonitors", "stateVersion", "statusMonitor"]);
  assert.deepEqual(Object.keys(changedEventState(initial, "invalid")).sort(), Object.keys(full).sort());
});
