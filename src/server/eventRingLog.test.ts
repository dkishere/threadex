import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { EventRingLog, loadEventRing } from "./eventRingLog";

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "event-ring-log-"));
  return {
    path: resolve(directory, "event-ring.jsonl"),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function event(index: number) {
  return {
    eventId: `event-${index}`,
    type: "runner.item",
    workspaceId: "default",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: { index },
    timestamp: `2026-09-02T12:00:${String(index % 60).padStart(2, "0")}.000Z`
  };
}

test("appends events without rewriting the complete ring for every record", async () => {
  const target = fixture();
  try {
    const log = new EventRingLog(target.path, 128);
    for (let index = 0; index < 500; index += 1) await log.append(event(index));

    const diskLineCount = readFileSync(target.path, "utf8").trim().split("\n").length;
    assert.ok(diskLineCount >= 128);
    assert.ok(diskLineCount <= 256, "stale lines are compacted once they reach the retained capacity");
    assert.equal(log.entries.length, 128);
    assert.equal(log.entries[0]?.eventId, "event-372");
    assert.equal(log.latestPosition, 500);
    assert.equal(statSync(target.path).mode & 0o777, 0o600);
  } finally {
    target.cleanup();
  }
});

test("serializes concurrent appends and deduplicates event ids", async () => {
  const target = fixture();
  try {
    const log = new EventRingLog(target.path, 64);
    await Promise.all(Array.from({ length: 40 }, (_, index) => log.append(event(index))));
    assert.equal(await log.append(event(20)), false);

    assert.equal(log.entries.length, 40);
    assert.deepEqual(log.entries.map((entry) => entry.pos), Array.from({ length: 40 }, (_, index) => index + 1));
    assert.equal(loadEventRing(target.path, 64).length, 40);
  } finally {
    target.cleanup();
  }
});

test("repairs a truncated final record before appending", async () => {
  const target = fixture();
  try {
    writeFileSync(target.path, `${JSON.stringify({ ...event(1), pos: 1 })}\n{\"broken\":`, "utf8");
    const log = new EventRingLog(target.path, 8);
    await log.append(event(2));

    assert.deepEqual(loadEventRing(target.path, 8).map((entry) => entry.eventId), ["event-1", "event-2"]);
  } finally {
    target.cleanup();
  }
});

test("compacts an oversized legacy log during startup", () => {
  const target = fixture();
  try {
    const lines = Array.from({ length: 80 }, (_, index) => JSON.stringify({
      ...event(index),
      pos: index + 1,
      payload: { index, padding: "x".repeat(20_000) }
    }));
    writeFileSync(target.path, `${lines.join("\n")}\n`, "utf8");
    const before = statSync(target.path).size;

    const log = new EventRingLog(target.path, 8);

    assert.equal(log.entries.length, 8);
    assert.ok(statSync(target.path).size < before / 5);
    assert.equal(loadEventRing(target.path, 8).length, 8);
  } finally {
    target.cleanup();
  }
});

test("keeps only the latest replay state for progressive runner items", async () => {
  const target = fixture();
  try {
    const log = new EventRingLog(target.path, 128);
    for (let index = 0; index < 300; index += 1) {
      await log.append({
        ...event(index),
        payload: {
          eventType: "item.updated",
          itemType: "commandExecution",
          id: "command-1",
          aggregatedOutput: `output-${index}`
        }
      });
    }

    assert.equal(log.entries.length, 1);
    assert.equal((log.entries[0]?.payload as { aggregatedOutput?: string }).aggregatedOutput, "output-299");
    assert.equal(loadEventRing(target.path, 128).length, 1);
    assert.ok(readFileSync(target.path, "utf8").trim().split("\n").length <= 128, "superseded updates are compacted at the ring capacity");
  } finally {
    target.cleanup();
  }
});

test("large rings compact and reload when whole-log string I/O exceeds the engine limit", async t => {
  const target = fixture();
  const read = fs.readFileSync;
  const write = fs.writeFileSync;
  // Scale down the string limit so this regression does not need a 512 MiB fixture.
  const stringLimit = 32 * 1024;
  const readMock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] === target.path && args[1] === "utf8" && statSync(target.path).size > stringLimit) {
      throw new RangeError("Invalid string length");
    }
    return read(...args);
  });
  const writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (typeof args[1] === "string" && args[1].length > stringLimit) {
      throw new RangeError("Invalid string length");
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    const log = new EventRingLog(target.path, 8);
    for (let index = 0; index < 12; index++) {
      await log.append({ ...event(index), payload: { padding: "x".repeat(8 * 1024) } });
    }
    assert.ok(statSync(target.path).size > stringLimit);
    assert.deepEqual(log.entries.map(entry => entry.pos), [5, 6, 7, 8, 9, 10, 11, 12]);

    const reloaded = new EventRingLog(target.path, 8);
    assert.deepEqual(reloaded.entries, log.entries, "reloading must preserve payloads and replay positions");
    assert.equal(await reloaded.append(event(11)), false, "reloading must preserve deduplication");
    await reloaded.append(event(12));
    await reloaded.append(event(13));
    assert.equal(reloaded.latestPosition, 14, "compaction must allow subsequent publication");
    assert.deepEqual(loadEventRing(target.path, 8), reloaded.entries);
    assert.equal(statSync(target.path).mode & 0o777, 0o600);
  } finally {
    readMock.mock.restore();
    writeMock.mock.restore();
    syncBuiltinESMExports();
    target.cleanup();
  }
});

test("chunked reads preserve UTF-8, multi-chunk records and valid entries around malformed lines", () => {
  const target = fixture();
  try {
    const first = { ...event(1), pos: 1, payload: { text: "🧵香港".repeat(20_000) } };
    const second = { ...event(2), pos: 2 };
    // Align a multi-byte character across the 64 KiB read boundary.
    const prefix = JSON.stringify(first).indexOf("🧵");
    const padding = " ".repeat(64 * 1024 - prefix - 1);
    writeFileSync(target.path, `${padding}${JSON.stringify(first)}\n{broken}\n${JSON.stringify(second)}`, "utf8");

    const log = new EventRingLog(target.path, 8);
    assert.deepEqual(log.entries, [first, second]);
    assert.deepEqual(loadEventRing(target.path, 8), [first, second]);
    assert.ok(readFileSync(target.path, "utf8").endsWith("\n"), "startup must repair a missing final newline");
  } finally {
    target.cleanup();
  }
});
