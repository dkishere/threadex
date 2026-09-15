import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TurnRingLog, type TurnRingEntry } from "./turnRingLog";

function temporaryLog() {
  const directory = mkdtempSync(resolve(tmpdir(), "turn-ring-log-"));
  return {
    directory,
    path: resolve(directory, "turn-ring.jsonl"),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  };
}

function readEntries(path: string): TurnRingEntry[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnRingEntry);
}

test("writes prompts and agent responses as independent JSONL records", async () => {
  const fixture = temporaryLog();
  try {
    const log = new TurnRingLog(fixture.path, 4096);
    await log.appendUserPrompt({
      source: "chat.start",
      sessionId: "session-1",
      turnId: "turn-1",
      userPrompt: "Fix the parser.",
      timestamp: "2026-08-18T10:00:00.000Z"
    });
    await log.appendAgentResponse({
      source: "runner.result",
      sessionId: "session-1",
      turnId: "turn-1",
      agentResponse: "Parser fixed.",
      status: "done",
      timestamp: "2026-08-18T10:01:00.000Z"
    });

    assert.deepEqual(readEntries(fixture.path), [
      {
        version: 1,
        timestamp: "2026-08-18T10:00:00.000Z",
        event: "user_prompt",
        source: "chat.start",
        sessionId: "session-1",
        turnId: "turn-1",
        userPrompt: "Fix the parser."
      },
      {
        version: 1,
        timestamp: "2026-08-18T10:01:00.000Z",
        event: "agent_response",
        source: "runner.result",
        sessionId: "session-1",
        turnId: "turn-1",
        agentResponse: "Parser fixed.",
        status: "done"
      }
    ]);
    assert.equal(statSync(fixture.path).mode & 0o777, 0o600);
  } finally {
    fixture.cleanup();
  }
});

test("drops the oldest complete records before the byte limit is exceeded", async () => {
  const fixture = temporaryLog();
  try {
    const maxBytes = 900;
    const log = new TurnRingLog(fixture.path, maxBytes);
    for (let index = 0; index < 12; index += 1) {
      await log.appendUserPrompt({
        source: "chat.start",
        sessionId: "session-ring",
        turnId: `turn-${index}`,
        userPrompt: `${index}:${"x".repeat(90)}`
      });
    }

    const entries = readEntries(fixture.path);
    assert.ok(statSync(fixture.path).size <= maxBytes);
    assert.equal(entries.at(-1)?.turnId, "turn-11");
    assert.ok(!entries.some((entry) => entry.turnId === "turn-0"));
    assert.ok(entries.every((entry) => entry.event === "user_prompt"));
  } finally {
    fixture.cleanup();
  }
});

test("serializes concurrent appends and recovers from a truncated final line", async () => {
  const fixture = temporaryLog();
  try {
    writeFileSync(fixture.path, "{\"broken\":", "utf8");
    const log = new TurnRingLog(fixture.path, 16_384);
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.appendAgentResponse({
      source: "runner.result",
      sessionId: "session-concurrent",
      turnId: `turn-${index}`,
      agentResponse: `response-${index}`,
      status: "done"
    })));

    const entries = readEntries(fixture.path);
    assert.equal(entries.length, 20);
    assert.deepEqual(entries.map((entry) => entry.turnId), Array.from({ length: 20 }, (_, index) => `turn-${index}`));
  } finally {
    fixture.cleanup();
  }
});

test("deduplicates durable event ids across server restarts", async () => {
  const fixture = temporaryLog();
  try {
    const firstLog = new TurnRingLog(fixture.path, 4096);
    await firstLog.appendAgentResponse({
      eventId: "response:event-1",
      source: "runner.result",
      sessionId: "session-dedupe",
      turnId: "turn-dedupe",
      agentResponse: "first",
      status: "done"
    });
    await firstLog.appendAgentResponse({
      eventId: "response:event-1",
      source: "runner.result",
      sessionId: "session-dedupe",
      turnId: "turn-dedupe",
      agentResponse: "duplicate",
      status: "done"
    });

    const restartedLog = new TurnRingLog(fixture.path, 4096);
    await restartedLog.appendAgentResponse({
      eventId: "response:event-1",
      source: "runner.result",
      sessionId: "session-dedupe",
      turnId: "turn-dedupe",
      agentResponse: "duplicate after restart",
      status: "done"
    });

    const entries = readEntries(fixture.path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.agentResponse, "first");
  } finally {
    fixture.cleanup();
  }
});

test("rejects a single entry larger than the configured ring", async () => {
  const fixture = temporaryLog();
  try {
    const log = new TurnRingLog(fixture.path, 256);
    await assert.rejects(
      log.appendUserPrompt({
        source: "chat.start",
        sessionId: "session-large",
        turnId: "turn-large",
        userPrompt: "x".repeat(512)
      }),
      /exceeding the 256-byte limit/
    );

    await log.appendUserPrompt({
      source: "chat.start",
      sessionId: "s",
      turnId: "t",
      userPrompt: "small"
    });
    assert.equal(readEntries(fixture.path).length, 1);
  } finally {
    fixture.cleanup();
  }
});
