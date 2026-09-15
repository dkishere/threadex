import { expect, test } from "@playwright/test";
import {
  apiBaseUrl,
  appendMockRunnerSequence,
  checkedJson,
  requestApproval,
  resolveApproval,
  runnerUpdate,
  selectSession,
  startMockRunner
} from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

const cursorStorageKey = "codex-session-manager.event-cursor";

test("returns status monitoring for inactive workspaces", async ({ request }) => {
  const approvalId = "e2e-background-approval";
  await requestApproval(request, {
    approvalId,
    sessionId: "e2e-background-session",
    turnId: "e2e-background-turn"
  });

  const askingPayload = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=0`));
  expect(askingPayload.statusMonitor).toEqual([{
    id: "e2e-background",
    name: "Background Monitor",
    active_sessions: [
      {
        id: "e2e-background-session",
        name: "Background Active Session",
        asking_approvals: [{
          approvalId,
          sessionId: "e2e-background-session",
          turnId: "e2e-background-turn",
          requestId: 41,
          method: "item/commandExecution/requestApproval",
          params: {
            command: "npm run build",
            cwd: "/workspace",
            availableDecisions: ["accept", "decline"]
          },
          createdAt: expect.any(String)
        }]
      }
    ]
  }]);

  await resolveApproval(request, {
    approvalId,
    sessionId: "e2e-background-session",
    turnId: "e2e-background-turn"
  });
  const todoPayload = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=0`));
  expect(todoPayload.statusMonitor[0]).toEqual({
    id: "e2e-background",
    name: "Background Monitor",
    active_sessions: [
      {
        id: "e2e-background-session",
        name: "Background Active Session",
        asking_approvals: []
      }
    ]
  });
});

test("deduplicates eventIds, advances the cursor, and re-bootstraps after a stale cursor", async ({ page, request }) => {
  const session = scenarioSessions.events;
  const turnId = `${session.id}-baseline`;
  await selectSession(request, session.id);

  let snapshotCount = 0;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/workspace/snapshot" && response.ok()) snapshotCount += 1;
  });
  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  const initialCursor = await page.evaluate((key) => Number(localStorage.getItem(key)), cursorStorageKey);

  const duplicateId = "e2e-duplicate-event-id";
  const duplicateUpdate = {
    id: duplicateId,
    sessionId: session.id,
    turnId,
    event: "heartbeat",
    data: { source: "deduplication-case" }
  };
  await runnerUpdate(request, duplicateUpdate);
  await runnerUpdate(request, duplicateUpdate);

  const dedupPayload = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=${initialCursor}`));
  expect(dedupPayload.events.filter((event: { eventId: string }) => event.eventId === duplicateId)).toHaveLength(1);
  await expect
    .poll(() => page.evaluate((key) => Number(localStorage.getItem(key)), cursorStorageKey))
    .toBeGreaterThan(initialCursor);
  const progressedCursor = await page.evaluate((key) => Number(localStorage.getItem(key)), cursorStorageKey);

  await page.route("**/api/events?*", async (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") ?? progressedCursor);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [], nextPos: after, resetRequired: false })
    });
  });

  for (let index = 0; index < 12; index += 1) {
    await runnerUpdate(request, {
      id: `e2e-ring-overflow-${index}`,
      sessionId: session.id,
      turnId,
      event: "heartbeat",
      data: { index }
    });
  }

  const stalePayload = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=${progressedCursor}`));
  expect(stalePayload).toMatchObject({ events: [], resetRequired: true });
  const snapshotsBeforeRelease = snapshotCount;
  await page.unroute("**/api/events?*");

  await expect.poll(() => snapshotCount).toBeGreaterThan(snapshotsBeforeRelease);
  await expect
    .poll(() => page.evaluate((key) => Number(localStorage.getItem(key)), cursorStorageKey))
    .toBeGreaterThan(progressedCursor);
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
});

test("reconnects and replays a realistic mock runner JSONL sequence", async ({ page, request }) => {
  const session = scenarioSessions.replay;
  const turnId = "e2e-turn-runner-replay";
  const { logPath } = await startMockRunner(request, {
    sessionId: session.id,
    turnId,
    message: "Replay the mock runner log"
  });
  await selectSession(request, session.id);

  let streamAttempts = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/api/runner/stream") streamAttempts += 1;
  });
  await page.route("**/api/runner/stream", (route) => route.abort("connectionfailed"), { times: 1 });

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  await expect.poll(() => streamAttempts).toBeGreaterThanOrEqual(2);
  appendMockRunnerSequence({
    logPath,
    sessionId: session.id,
    turnId,
    reply: "Replayed answer from mock log"
  });

  await expect(page.getByText("Replayed answer from mock log", { exact: true })).toBeVisible();
  await expect(page.locator(".runtime-pill")).toHaveText("Ready");
  await expect(page.locator(".turn-status").filter({ hasText: "Running" })).toHaveCount(0);
});
