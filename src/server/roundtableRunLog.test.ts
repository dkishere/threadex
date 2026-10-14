import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { RoundtableRunLog } from "./roundtableRunLog";

test("roundtable journals retain timed tool activity and errors without auth or reasoning payloads", () => {
  const directory = mkdtempSync("/private/tmp/roundtable-log-test-");
  try {
    const log = new RoundtableRunLog(directory, { sessionId: "session", turnId: "turn", actorId: "actor", model: "model", effort: "high" });
    log.providerEvent("codex", { method: "item/started", params: { item: { type: "commandExecution", command: "git status", id: "tool-1" } } });
    log.providerEvent("codex", { method: "item/completed", params: { item: { type: "commandExecution", exitCode: 0, aggregatedOutput: "clean" } } });
    log.providerEvent("claude", { type: "assistant", message: { content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "tool_use", name: "Read", input: { path: "README.md", api_key: "secret-value" } }
    ] } });
    log.providerEvent("codex", { method: "item/reasoning/textDelta", params: { delta: "private reasoning" } });
    log.finish("error", "Provider disconnected");
    const text = readFileSync(log.attempt.logPath, "utf8");
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5, 6]);
    assert.ok(events.every(event => Number.isFinite(Date.parse(event.at))));
    assert.match(text, /git status/);
    assert.match(text, /Provider disconnected/);
    assert.doesNotMatch(text, /private reasoning|secret-value/);
    assert.equal(events.at(-1).event, "run.error");
    assert.equal(log.attempt.eventCount, 6);
    assert.equal(log.attempt.finishedAt, events.at(-1).at);
    assert.equal(statSync(log.attempt.logPath).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
