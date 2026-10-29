import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubagentActivity,
  applySubagentActivitySnapshot,
  getSubagentActivity,
  presentSubagentActivity,
  resetSubagentActivityStore
} from "./subagentActivityStore";

const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const event = (seq: number, seconds: number, extra: Record<string, unknown> = {}) =>
  ({ agentId: "toolu_1", source: "claude", seq, at: at(seconds), kind: "message", ...extra });

test("dedupes by seq and keeps only the latest heartbeat", () => {
  resetSubagentActivityStore();
  applySubagentActivity(event(0, 0, { kind: "started", description: "Explore" }));
  applySubagentActivity(event(1, 5, { kind: "tool", toolName: "Read", description: "src/a.ts" }));
  applySubagentActivity(event(1, 5, { kind: "tool", toolName: "Read", description: "src/a.ts" }));
  applySubagentActivity(event(2, 40, { kind: "heartbeat", lastActivityAt: at(5), processAlive: true }));
  applySubagentActivity(event(3, 75, { kind: "heartbeat", lastActivityAt: at(5), processAlive: true }));
  const view = getSubagentActivity("toolu_1")!;
  assert.equal(view.events.length, 2);
  assert.equal(view.heartbeat?.seq, 3);
  assert.equal(view.lastActivityAt, at(5));
  assert.equal(view.lastSignalAt, at(75));
  const shown = presentSubagentActivity(view, T0 + 80_000);
  assert.equal(shown.tone, "quiet");
  assert.equal(shown.detail, "Using Read · src/a.ts");
});

test("flags a running agent as stalled once heartbeats stop or the process is gone", () => {
  resetSubagentActivityStore();
  applySubagentActivity(event(0, 0, { kind: "tool", toolName: "Bash" }));
  const view = getSubagentActivity("toolu_1")!;
  assert.equal(presentSubagentActivity(view, T0 + 10_000).tone, "running");
  assert.equal(presentSubagentActivity(view, T0 + 121_000).tone, "stalled");
  applySubagentActivity(event(1, 30, { kind: "heartbeat", lastActivityAt: at(0), processAlive: false }));
  assert.equal(presentSubagentActivity(getSubagentActivity("toolu_1")!, T0 + 31_000).tone, "stalled");
});

test("shows waiting until newer activity arrives", () => {
  resetSubagentActivityStore();
  applySubagentActivity(event(0, 0, { kind: "tool", toolName: "Edit" }));
  applySubagentActivity(event(1, 30, { kind: "waiting", waiting: "approval" }));
  let shown = presentSubagentActivity(getSubagentActivity("toolu_1")!, T0 + 31_000);
  assert.equal(shown.tone, "waiting");
  assert.equal(shown.label, "Waiting for approval");
  applySubagentActivity(event(2, 40, { kind: "message", text: "done editing" }));
  shown = presentSubagentActivity(getSubagentActivity("toolu_1")!, T0 + 41_000);
  assert.equal(shown.tone, "running");
  assert.equal(shown.detail, "done editing");
});

test("finished events close the agent with their status", () => {
  resetSubagentActivityStore();
  applySubagentActivity(event(0, 0, { kind: "started" }));
  applySubagentActivity(event(1, 9, { kind: "finished", status: "failed" }));
  const shown = presentSubagentActivity(getSubagentActivity("toolu_1")!, T0 + 999_000);
  assert.equal(shown.tone, "error");
  assert.equal(shown.label, "Failed");
});

test("snapshot merges with live events and an ended turn stays ended", () => {
  resetSubagentActivityStore();
  applySubagentActivity(event(2, 20, { kind: "message", text: "live" }));
  applySubagentActivitySnapshot([{
    agentId: "toolu_1",
    state: "ended",
    heartbeat: event(1, 15, { kind: "heartbeat", lastActivityAt: at(10) }),
    events: [event(0, 10, { kind: "started" })]
  }, { agentId: "", events: [] }, null]);
  const view = getSubagentActivity("toolu_1")!;
  assert.deepEqual(view.events.map((entry) => entry.seq), [0, 2]);
  assert.equal(view.state, "ended");
  assert.equal(presentSubagentActivity(view, T0 + 999_000).label, "Ended");
  applySubagentActivitySnapshot([{ agentId: "toolu_1", state: "ended", events: [event(0, 10, { kind: "started" })] }]);
  assert.equal(getSubagentActivity("toolu_1")!.state, "ended");
  applySubagentActivity(event(3, 30, { kind: "message", text: "resumed" }));
  assert.equal(getSubagentActivity("toolu_1")!.state, "running");
});

test("ignores invalid payloads", () => {
  resetSubagentActivityStore();
  applySubagentActivity({ agentId: "toolu_1", kind: "nope", seq: 0, at: at(0) });
  applySubagentActivity(null);
  assert.equal(getSubagentActivity("toolu_1"), undefined);
});
