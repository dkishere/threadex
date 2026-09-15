import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.ok(diskLineCount < 160);
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
    assert.ok(statSync(target.path).size < 10_000);
  } finally {
    target.cleanup();
  }
});
