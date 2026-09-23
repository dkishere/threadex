import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson, e2eDataDir, interruptTerminalStreams, runnerLogPath, runnerUpdate, selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";
import { SessionStore } from "../src/server/sessionStore";
import { resolve } from "node:path";

test("client event API omits raw output and unchanged state while the original feed remains available", async ({ request }) => {
  const session = scenarioSessions.events;
  await selectSession(request, session.id);
  const turnId = `${session.id}-baseline`;
  await runnerUpdate(request, { id: "compact-raw-output", sessionId: session.id, turnId, event: "heartbeat", data: { output: "x".repeat(256 * 1024) } });
  await runnerUpdate(request, { id: "compact-completed", sessionId: session.id, turnId, event: "done", data: { diagnostics: "x".repeat(256 * 1024) } });
  const full = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=0`));
  const compact = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=0&view=client`));
  expect(full.events.some((event: any) => event.eventId === "compact-raw-output")).toBe(true);
  expect(compact.events.some((event: any) => event.eventId === "compact-raw-output")).toBe(false);
  expect(compact.events.find((event: any) => event.eventId === "compact-completed").payload).toBeNull();
  expect(compact).toMatchObject({ workspaceId: "default", hasMore: false, resetRequired: false });
  expect(compact.nextPos).toBe(full.nextPos);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 10);
  const unchanged = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=${compact.nextPos}&view=client&stateVersion=${compact.stateVersion}`));
  expect(unchanged.events).toEqual([]);
  expect(unchanged).not.toHaveProperty("statusMonitor");
  expect(unchanged).not.toHaveProperty("processMonitors");
  expect(unchanged).not.toHaveProperty("grillSummaries");
  expect(unchanged.stateVersion).toBe(compact.stateVersion);
  expect(JSON.stringify(unchanged).length).toBeLessThan(256);
});

test("compact completion events still recover the full answer after terminal SSE is lost", async ({ page, request }) => {
  const session = scenarioSessions.result;
  const turnId = "e2e-compact-result";
  const logPath = runnerLogPath(turnId);
  // Seed the claimed writer directly: queueing via the pending API can race
  // its automatic scheduler and launch a real runner before the fixture claims it.
  const fixture = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
  try {
    await fixture.ready();
    await fixture.recordSessionTurn({ id: turnId, sessionId: session.id, userInput: "Wait for compact completion", agentResponse: "", status: "running", tokenIn: 0, tokenOut: 0 });
  } finally { await fixture.close(); }
  await runnerUpdate(request, { id: `${turnId}:claimed-runner`, sessionId: session.id, turnId, event: "runner.started", runnerPid: process.pid, logPath });
  await selectSession(request, session.id);
  await interruptTerminalStreams(page);
  let compactResult = false;
  page.on("response", async response => {
    if (!response.url().includes("/api/events?")) return;
    const body = await response.json().catch(() => ({}));
    if (body.events?.some((event: any) => event.eventId === "compact-result-recovery" && event.payload === null)) compactResult = true;
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
  await runnerUpdate(request, { id: "compact-result-recovery", sessionId: session.id, turnId, event: "result", data: { reply: "Full answer recovered from the saved turn", tokenIn: 2, tokenOut: 3 } });
  await expect(page.getByText("Full answer recovered from the saved turn", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  await expect.poll(() => compactResult).toBe(true);
});

test("browser uses versioned idle polls without clearing loaded monitor state", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.switchBeta.id);
  const polls: any[] = [];
  const versions: Array<string | null> = [];
  page.on("response", async response => {
    if (!response.url().includes("/api/events?")) return;
    const body = await response.json().catch(() => null);
    if (!body) return;
    polls.push(body);
    versions.push(new URL(response.url()).searchParams.get("stateVersion"));
  });
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`);
  await expect.poll(() => polls.length).toBeGreaterThanOrEqual(2);
  expect(versions[0]).toBeNull();
  expect(versions[1]).toBe(polls[0].stateVersion);
  expect(polls[1]).not.toHaveProperty("processMonitors");
});
