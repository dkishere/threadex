import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionStore } from "../src/server/sessionStore.js";
import {
  apiBaseUrl,
  checkedJson,
  e2eDataDir,
  postJson,
  runnerLogPath,
  selectSession
} from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

test("dead-runner diagnosis drains a large log before marking the turn stopped", async ({ request }) => {
  const session = scenarioSessions.replay;
  const turnId = "e2e-turn-watchdog-large-log";
  const reply = "Recovered completion from the runner log tail";
  const logPath = runnerLogPath(turnId);
  const timestamp = new Date().toISOString();
  const padding = " ".repeat(384 * 1024);
  const prefixEntries = Array.from({ length: 3 }, (_, index) => ({
    id: `${turnId}:padding-${index}`,
    ts: timestamp,
    jsonlIndex: index,
    sessionId: session.id,
    turnId,
    event: "heartbeat",
    data: { index }
  }));
  const terminalEntries = [
    {
      id: `${turnId}:result`,
      ts: timestamp,
      jsonlIndex: prefixEntries.length,
      sessionId: session.id,
      turnId,
      event: "result",
      data: {
        sessionId: session.id,
        turnId,
        threadId: `thread-${session.id}`,
        elapsedMs: 125,
        reply,
        tokenIn: 31,
        tokenOut: 17
      }
    },
    {
      id: `${turnId}:done`,
      ts: timestamp,
      jsonlIndex: prefixEntries.length + 1,
      sessionId: session.id,
      turnId,
      event: "done",
      data: { ok: true }
    }
  ];
  const log = [
    ...prefixEntries.map((entry) => `${JSON.stringify(entry)}${padding}`),
    ...terminalEntries.map((entry) => JSON.stringify(entry))
  ].join("\n") + "\n";
  expect(Buffer.byteLength(log)).toBeGreaterThan(1024 * 1024);
  writeFileSync(logPath, log, "utf8");

  const exitedRunner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (!exitedRunner.pid) throw new Error("Failed to start the dead-PID fixture process.");
  const deadPid = exitedRunner.pid;
  await once(exitedRunner, "exit");
  expect(() => process.kill(deadPid, 0)).toThrow();

  // Seed the running attempt directly. Queue dispatch reserves its own UUID
  // path and correctly rejects a runner.started callback for a different log.
  const store = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
  try {
    await store.ready();
    await store.recordSessionTurn({
      id: turnId,
      sessionId: session.id,
      userInput: "Recover this completed runner from its durable log",
      agentResponse: "",
      status: "running",
      tokenIn: 0,
      tokenOut: 0
    });
    expect(await store.markSessionTurnRunning({ id: turnId, runnerPid: deadPid, runnerLogPath: logPath })).toBe(true);
  } finally {
    await store.close();
  }
  await selectSession(request, session.id);

  // Snapshot reconciliation runs after the response, so wait for a later
  // snapshot to expose both the recovered turn and cleared execution status.
  await expect.poll(async () => {
    const snapshot = await checkedJson(await request.get(`${apiBaseUrl}/api/workspace/snapshot`));
    return {
      turn: snapshot.activeSession.turns.find((turn: { id: string }) => turn.id === turnId),
      executionStatus: snapshot.sessionExecutionStatuses[session.id]
    };
  }).toMatchObject({
    turn: {
      status: "done",
      agentResponse: reply,
      tokenIn: 31,
      tokenOut: 17,
      runnerPid: null,
      runnerExitCode: 0,
      pendingReason: null
    },
    executionStatus: undefined
  });

  const watchdogInspection = await postJson(request, "/api/session-inspector/session", {
    sessionId: session.id,
    turnId,
    includeEvents: true,
    eventName: "runner.watchdog.dead"
  });
  expect(watchdogInspection.events).toEqual([]);
});
