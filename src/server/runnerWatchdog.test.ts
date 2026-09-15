import assert from "node:assert/strict";
import test from "node:test";
import { runnerStartupIsWithinGrace, type RunnerStartupState } from "./runnerWatchdog.js";

const now = Date.parse("2026-09-04T09:00:00.000Z");

function startupState(overrides: Partial<RunnerStartupState> = {}): RunnerStartupState {
  return {
    runnerPid: null,
    runnerStarted: null,
    runnerHeartbeat: null,
    created: "2026-09-04T08:59:58.000Z",
    ...overrides
  };
}

test("defers dead-runner diagnosis while a newly claimed turn is starting", () => {
  assert.equal(runnerStartupIsWithinGrace(startupState(), now, 45_000), true);
});

test("uses a pending retry heartbeat instead of its original creation time", () => {
  assert.equal(runnerStartupIsWithinGrace(startupState({
    created: "2026-09-03T09:00:00.000Z",
    runnerHeartbeat: "2026-09-04T08:59:59.000Z"
  }), now, 45_000), true);
});

test("allows an unstarted orphan to be released after the startup grace period", () => {
  assert.equal(runnerStartupIsWithinGrace(startupState({
    created: "2026-09-04T08:58:00.000Z"
  }), now, 45_000), false);
});

test("does not apply startup grace after a PID has been attached", () => {
  assert.equal(runnerStartupIsWithinGrace(startupState({ runnerPid: 12345 }), now, 45_000), false);
});
