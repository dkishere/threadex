import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { RunnerLogReplay, type IndexedRunnerLogEntry } from "./runnerLogReader.js";
import { replayPendingRunnerLog, replayRunnerLogForTurn } from "./runnerLogRecovery.js";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "runner-log-recovery-"));
  const runnerLogDir = resolve(root, "runner-logs");
  const pendingLogDir = resolve(root, "pending-runner-logs");
  mkdirSync(runnerLogDir);
  mkdirSync(pendingLogDir);
  return {
    runnerLogDir,
    logPath: resolve(runnerLogDir, "turn-1.attempt-uuid.ndjson"),
    pendingLogPath: resolve(pendingLogDir, "turn-1.attempt-uuid.ndjson"),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function entry(event: string, index = 0): IndexedRunnerLogEntry {
  return {
    id: `entry-${index}`,
    ts: "2026-10-24T12:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    jsonlIndex: index,
    event,
    data: event === "result" ? { reply: "Recovered reply", tokenIn: 31, tokenOut: 17 } : { ok: true }
  };
}

function log(entries: IndexedRunnerLogEntry[]) {
  return entries.map(item => JSON.stringify(item)).join("\n") + "\n";
}

function runningTurn(logPath: string | null) {
  return { id: "turn-1", status: "running" as "running" | "done" | "todo", runnerPid: 12345 as number | null, runnerLogPath: logPath };
}

test("overlapping and later watchdog replays all observe persisted completion", async () => {
  const f = fixture();
  try {
    writeFileSync(f.logPath, log([entry("result"), entry("done", 1)]));
    const turn = runningTurn(f.logPath);
    let saved = { ...turn };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let applications = 0;
    const dependencies = {
      replay: new RunnerLogReplay(),
      getTurn: async () => saved,
      applyEntry: async (item: IndexedRunnerLogEntry) => {
        await gate;
        applications++;
        if (item.event === "result") saved = { ...saved, status: "done", runnerPid: null };
      }
    };
    const first = replayRunnerLogForTurn(turn, dependencies);
    const overlapping = replayRunnerLogForTurn(turn, dependencies);
    release();
    assert.deepEqual(await Promise.all([first, overlapping]), [true, true]);
    assert.equal(await replayRunnerLogForTurn(turn, dependencies), true);
    assert.equal(applications, 2, "completion stays visible without replaying entries");
  } finally { f.cleanup(); }
});

test("terminal entries that did not change saved running state do not suppress diagnosis", async () => {
  const f = fixture();
  try {
    writeFileSync(f.logPath, log([entry("result"), entry("done", 1)]));
    const turn = runningTurn(f.logPath);
    assert.equal(await replayRunnerLogForTurn(turn, {
      replay: new RunnerLogReplay(), getTurn: async () => turn, applyEntry: async () => {}
    }), false);
  } finally { f.cleanup(); }
});

test("a lone done event does not settle a still-running turn", async () => {
  const f = fixture();
  try {
    writeFileSync(f.logPath, log([entry("done")]));
    const turn = runningTurn(f.logPath);
    assert.equal(await replayRunnerLogForTurn(turn, {
      replay: new RunnerLogReplay(), getTurn: async () => turn, applyEntry: async () => {}
    }), false);
  } finally { f.cleanup(); }
});

test("a pending result is recognized from saved todo state", async () => {
  const f = fixture();
  try {
    writeFileSync(f.logPath, log([entry("pending")]));
    const turn = runningTurn(f.logPath);
    let saved = { ...turn };
    assert.equal(await replayRunnerLogForTurn(turn, {
      replay: new RunnerLogReplay(), getTurn: async () => saved,
      applyEntry: async () => { saved = { ...saved, status: "todo", runnerPid: null }; }
    }), true);
  } finally { f.cleanup(); }
});

test("diagnosis skips stale snapshots if the runner attempt changed during replay", async () => {
  const f = fixture();
  try {
    const turn = runningTurn(f.logPath);
    assert.equal(await replayRunnerLogForTurn(turn, {
      replay: new RunnerLogReplay(), getTurn: async () => ({ ...turn, runnerLogPath: "retry.ndjson" }),
      applyEntry: async () => { assert.fail("missing log should not be applied"); }
    }), true);
  } finally { f.cleanup(); }
});

test("turns without a log still recheck their saved status", async () => {
  const turn = runningTurn(null);
  const dependencies = {
    replay: new RunnerLogReplay(), getTurn: async () => ({ ...turn, status: "done" as const }),
    applyEntry: async () => { assert.fail("no log should be applied"); }
  };
  assert.equal(await replayRunnerLogForTurn(turn, dependencies), true);
  assert.equal(await replayRunnerLogForTurn(turn, { ...dependencies, getTurn: async () => turn }), false);
});

test("pending replay uses the persisted UUID attempt path for result entries without logPath", async () => {
  const f = fixture();
  try {
    writeFileSync(f.pendingLogPath, log([entry("result"), entry("done", 1)]));
    const turn = runningTurn(f.logPath);
    const paths: string[] = [];
    assert.equal(await replayPendingRunnerLog(f.pendingLogPath, "/unused-fallback", {
      getTurn: async () => turn,
      applyEntry: async (_item, path) => { paths.push(path); }
    }), 2);
    assert.deepEqual(paths, [f.logPath, f.logPath]);
    assert.equal(existsSync(f.pendingLogPath), false);
  } finally { f.cleanup(); }
});

test("stale pending files retain their original attempt path rather than completing a retry", async () => {
  const f = fixture();
  try {
    writeFileSync(f.pendingLogPath, log([entry("result")]));
    const retry = runningTurn(resolve(f.runnerLogDir, "turn-1.retry-uuid.ndjson"));
    await replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, {
      getTurn: async () => retry,
      applyEntry: async (_item, path) => {
        assert.equal(path, f.logPath);
        assert.notEqual(path, retry.runnerLogPath, "the existing attempt guard must reject this update");
      }
    });
  } finally { f.cleanup(); }
});

test("missing turn metadata falls back to the pending attempt filename including its UUID", async () => {
  const f = fixture();
  try {
    writeFileSync(f.pendingLogPath, log([entry("result")]));
    await replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, {
      getTurn: async () => null,
      applyEntry: async (_item, path) => { assert.equal(path, f.logPath); }
    });
  } finally { f.cleanup(); }
});

test("pending replay drains beyond 1MB through result and done before deleting the file", async () => {
  const f = fixture();
  try {
    const entries = [
      ...Array.from({ length: 4 }, (_, i) => ({ ...entry("heartbeat", i), data: { padding: "x".repeat(384 * 1024) } })),
      entry("result", 4), entry("done", 5)
    ];
    const contents = log(entries);
    assert.ok(Buffer.byteLength(contents) > 1024 * 1024);
    writeFileSync(f.pendingLogPath, contents);
    const applied: string[] = [];
    assert.equal(await replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, {
      getTurn: async () => runningTurn(f.logPath),
      applyEntry: async item => {
        assert.equal(existsSync(f.pendingLogPath), true);
        applied.push(item.event);
      }
    }), entries.length);
    assert.deepEqual(applied, entries.map(item => item.event));
    assert.equal(existsSync(f.pendingLogPath), false);
  } finally { f.cleanup(); }
});

test("failed pending application preserves the file and can retry its terminal entries", async () => {
  const f = fixture();
  try {
    writeFileSync(f.pendingLogPath, log([entry("result"), entry("done", 1)]));
    const getTurn = async () => runningTurn(f.logPath);
    await assert.rejects(replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, {
      getTurn, applyEntry: async () => { throw new Error("DB unavailable"); }
    }), /DB unavailable/);
    assert.equal(existsSync(f.pendingLogPath), true);
    assert.equal(await replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, {
      getTurn, applyEntry: async () => {}
    }), 2);
    assert.equal(existsSync(f.pendingLogPath), false);
  } finally { f.cleanup(); }
});

test("a partially appended pending entry is retained and can finish on a later replay", async () => {
  const f = fixture();
  try {
    const contents = log([entry("result")]);
    const split = Math.floor(contents.length / 2);
    writeFileSync(f.pendingLogPath, contents.slice(0, split));
    const applied: string[] = [];
    const dependencies = {
      getTurn: async () => runningTurn(f.logPath),
      applyEntry: async (item: IndexedRunnerLogEntry) => { applied.push(item.event); }
    };
    await assert.rejects(replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, dependencies), /incomplete trailing entry/);
    assert.equal(existsSync(f.pendingLogPath), true);
    appendFileSync(f.pendingLogPath, contents.slice(split));
    await replayPendingRunnerLog(f.pendingLogPath, f.runnerLogDir, dependencies);
    assert.deepEqual(applied, ["result"]);
    assert.equal(existsSync(f.pendingLogPath), false);
  } finally { f.cleanup(); }
});
