import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson, e2eDataDir, interruptTerminalStreams, selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";
import { SessionStore } from "../src/server/sessionStore";
import { resolve } from "node:path";

test("opening the active task uses the embedded snapshot without fetching and switching it again", async ({ page, request }) => {
  const session = scenarioSessions.bootstrap;
  await selectSession(request, session.id);
  const transcriptRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/sessions\/.+\/snapshot$/.test(path) || path === "/api/sessions/switch") transcriptRequests.push(path);
  });
  const snapshotResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace/snapshot");
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByText(`Snapshot response for ${session.title}`, { exact: true })).toBeVisible();
  expect((await snapshotResponse).headers()["server-timing"]).toMatch(/^snapshot;dur=/);
  expect(transcriptRequests).toEqual([]);
});

test("a URL targeting a different task still restores that task and backend selection", async ({ page, request }) => {
  const active = scenarioSessions.switchBeta;
  const target = scenarioSessions.switchAlpha;
  await selectSession(request, active.id);
  await page.goto(`/?workspaceId=default&sessionId=${target.id}`);
  await expect(page.getByText(`Snapshot response for ${target.title}`, { exact: true })).toBeVisible();
  const snapshot = await checkedJson(await request.get(`${apiBaseUrl}/api/workspace/snapshot`));
  expect(snapshot.activeSessionId).toBe(target.id);
  expect(snapshot.activeSession.session.id).toBe(target.id);
});

test("a dead runner recovered after the snapshot updates the saved turn and browser", async ({ page, request }) => {
  const session = scenarioSessions.replay;
  const turnId = "e2e-snapshot-dead-runner";
  await selectSession(request, session.id);
  const fixture = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
  try {
    await fixture.ready();
    await fixture.recordSessionTurn({ id: turnId, sessionId: session.id, userInput: "Recover the dead runner", agentResponse: "", status: "running", tokenIn: 0, tokenOut: 0 });
    expect(await fixture.markSessionTurnRunning({ id: turnId, runnerPid: 2147483647, runnerLogPath: resolve(e2eDataDir, "missing-runner.ndjson") })).toBe(true);
  } finally { await fixture.close(); }
  await interruptTerminalStreams(page);
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByText(/Prompt runner 2147483647 stopped before completion/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  const snapshot = await checkedJson(await request.get(`${apiBaseUrl}/api/workspace/snapshot`));
  expect(snapshot.activeSession.turns.find((turn: any) => turn.id === turnId)).toMatchObject({ status: "todo", pendingReason: "stopped" });
  const events = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=0&view=client`));
  expect(events.events.some((event: any) => event.turnId === turnId && event.type === "runner.pending")).toBe(true);
});
