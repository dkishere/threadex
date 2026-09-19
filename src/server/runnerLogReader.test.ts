import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  drainRunnerLogEntries,
  initialRunnerLogReadState,
  RunnerLogReplay,
  shouldRefreshRunnerHeartbeat,
  type IndexedRunnerLogEntry,
  type RunnerLogEntry
} from "./runnerLogReader.js";

test("only live runner-log draining refreshes the watchdog heartbeat", () => {
  assert.equal(shouldRefreshRunnerHeartbeat("live"), true);
  assert.equal(shouldRefreshRunnerHeartbeat("replay"), false);
});

function temporaryLog() {
  const directory = mkdtempSync(resolve(tmpdir(), "runner-log-reader-"));
  return {
    directory,
    path: resolve(directory, "runner.ndjson"),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function runnerEntry(index: number, event = "delta"): RunnerLogEntry {
  return {
    id: `entry-${index}`,
    ts: "2026-08-23T12:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    event,
    data: { text: `${index}:${"x".repeat(80)}` }
  };
}

test("watchdog replay shares overlapping passes and only applies newly appended entries", async () => {
  const fixture = temporaryLog();
  try {
    const replay = new RunnerLogReplay();
    writeFileSync(fixture.path, `${JSON.stringify(runnerEntry(0))}\n`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const applied: string[] = [];
    const first = replay.replay(fixture.path, async (entries) => {
      await gate;
      applied.push(...entries.map((entry) => entry.id));
    });
    const overlapping = replay.replay(fixture.path, () => { assert.fail("duplicate replay"); });
    assert.equal(first, overlapping);
    release();
    await first;
    await replay.replay(fixture.path, () => { assert.fail("unchanged log replayed"); });
    appendFileSync(fixture.path, `${JSON.stringify(runnerEntry(1, "done"))}\n`);
    await replay.replay(fixture.path, (entries) => { applied.push(...entries.map((entry) => entry.id)); });
    assert.deepEqual(applied, ["entry-0", "entry-1"]);
  } finally {
    fixture.cleanup();
  }
});

test("failed watchdog application remains retryable and truncated logs restart", async () => {
  const fixture = temporaryLog();
  try {
    const replay = new RunnerLogReplay();
    writeFileSync(fixture.path, `${JSON.stringify(runnerEntry(0))}\n${JSON.stringify(runnerEntry(1))}\n`);
    await assert.rejects(replay.replay(fixture.path, () => { throw new Error("DB unavailable"); }));
    const applied: string[] = [];
    await replay.replay(fixture.path, (entries) => { applied.push(...entries.map((entry) => entry.id)); });
    writeFileSync(fixture.path, `${JSON.stringify(runnerEntry(2))}\n`);
    await replay.replay(fixture.path, (entries) => { applied.push(...entries.map((entry) => entry.id)); });
    assert.deepEqual(applied, ["entry-0", "entry-1", "entry-2"]);
  } finally {
    fixture.cleanup();
  }
});

test("drains a multi-chunk runner log through result and done at the tail", async () => {
  const fixture = temporaryLog();
  try {
    const entries = [
      ...Array.from({ length: 12 }, (_, index) => runnerEntry(index)),
      runnerEntry(12, "result"),
      runnerEntry(13, "done")
    ];
    const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    writeFileSync(fixture.path, contents, "utf8");

    const batches: string[][] = [];
    const drained: IndexedRunnerLogEntry[] = [];
    const state = await drainRunnerLogEntries(
      fixture.path,
      initialRunnerLogReadState(),
      async (chunkEntries) => {
        await Promise.resolve();
        batches.push(chunkEntries.map((entry) => entry.event));
        drained.push(...chunkEntries);
      },
      { chunkBytes: 128 }
    );

    assert.ok(batches.length > 1);
    assert.deepEqual(drained.map((entry) => entry.id), entries.map((entry) => entry.id));
    assert.deepEqual(drained.map((entry) => entry.event).slice(-2), ["result", "done"]);
    assert.deepEqual(drained.map((entry) => entry.jsonlIndex), entries.map((_, index) => index));
    assert.deepEqual(state, {
      offset: Buffer.byteLength(contents),
      buffer: "",
      jsonlIndex: entries.length
    });
  } finally {
    fixture.cleanup();
  }
});

test("resumes draining from returned offset, buffer, and JSONL index state", async () => {
  const fixture = temporaryLog();
  try {
    const resultLine = JSON.stringify(runnerEntry(0, "result"));
    const splitAt = Math.floor(resultLine.length / 2);
    writeFileSync(fixture.path, resultLine.slice(0, splitAt), "utf8");

    const beforeLivenessCheck: IndexedRunnerLogEntry[] = [];
    const pausedState = await drainRunnerLogEntries(
      fixture.path,
      initialRunnerLogReadState(),
      (entries) => {
        beforeLivenessCheck.push(...entries);
      },
      { chunkBytes: 32 }
    );

    assert.deepEqual(beforeLivenessCheck, []);
    assert.equal(pausedState.buffer, resultLine.slice(0, splitAt));
    assert.equal(pausedState.jsonlIndex, 0);

    const doneLine = JSON.stringify(runnerEntry(1, "done"));
    appendFileSync(fixture.path, `${resultLine.slice(splitAt)}\n${doneLine}\n`, "utf8");

    const afterLivenessCheck: IndexedRunnerLogEntry[] = [];
    const finalState = await drainRunnerLogEntries(
      fixture.path,
      pausedState,
      (entries) => {
        afterLivenessCheck.push(...entries);
      },
      { chunkBytes: 32 }
    );

    assert.deepEqual(afterLivenessCheck.map((entry) => entry.event), ["result", "done"]);
    assert.deepEqual(afterLivenessCheck.map((entry) => entry.jsonlIndex), [0, 1]);
    assert.deepEqual(finalState, {
      offset: Buffer.byteLength(`${resultLine}\n${doneLine}\n`),
      buffer: "",
      jsonlIndex: 2
    });
  } finally {
    fixture.cleanup();
  }
});
