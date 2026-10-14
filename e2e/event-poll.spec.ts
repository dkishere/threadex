import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson, e2eDataDir, interruptTerminalStreams, runnerLogPath, runnerUpdate, selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";
import { SessionStore } from "../src/server/sessionStore";
import { WaitEventService } from "../src/server/waitEvent";
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
  expect(compact.waitEvents).toEqual(full.waitEvents);
  expect(compact.waitSubscriptions).toEqual(full.waitSubscriptions);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 10);
  const unchanged = await checkedJson(await request.get(`${apiBaseUrl}/api/events?after=${compact.nextPos}&view=client&stateVersion=${compact.stateVersion}`));
  expect(unchanged.events).toEqual([]);
  expect(unchanged).not.toHaveProperty("statusMonitor");
  expect(unchanged).not.toHaveProperty("processMonitors");
  expect(unchanged).not.toHaveProperty("grillSummaries");
  expect(unchanged).not.toHaveProperty("waitEvents");
  expect(unchanged).not.toHaveProperty("waitSubscriptions");
  expect(unchanged.stateVersion).toBe(compact.stateVersion);
  expect(JSON.stringify(unchanged).length).toBeLessThan(300);
});

test("pending waits follow creation, dispatch and completion without reloading the workspace", async ({ page, request }) => {
  const session = scenarioSessions.events;
  await selectSession(request, session.id);
  const fixture = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>(resolve => { releaseDispatch = resolve; });
  const service = new WaitEventService(fixture, { onDispatch: async subscription => {
    if (subscription.id === "e2e-pending-first") await dispatchGate;
  } });
  let dispatch: Promise<unknown> | undefined;
  try {
    await fixture.ready();
    const first = await service.ensureEvent({ workspaceId: "default", topic: "process.exited", subjectKey: "e2e-pending-first-event" });
    await service.subscribe({ id: "e2e-pending-first", eventId: first.id, workspaceId: "default", sessionId: session.id, actionType: "notify" });
    await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
    await page.getByRole("button", { name: "Pending waits (1)", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Pending waits", exact: true });
    const firstRow = dialog.getByRole("row").filter({ hasText: first.subjectKey });
    await expect(firstRow.locator("[data-status]")).toHaveText("waiting");

    const second = await service.ensureEvent({ workspaceId: "default", topic: "process.exited", subjectKey: "e2e-pending-second-event" });
    await service.subscribe({ id: "e2e-pending-second", eventId: second.id, workspaceId: "default", sessionId: session.id, actionType: "notify" });
    const secondRow = dialog.getByRole("row").filter({ hasText: second.subjectKey });
    await expect(secondRow).toBeVisible();
    await expect(dialog.getByText("2 active subscriptions", { exact: true })).toBeVisible();

    dispatch = service.fire(first.id);
    await expect(firstRow.locator("[data-status]")).toHaveText("dispatching");
    releaseDispatch();
    await dispatch;
    await expect(firstRow).toHaveCount(0);
    await expect(secondRow).toBeVisible();
    await expect(page.getByRole("button", { name: "Pending waits (1)", exact: true })).toBeVisible();

    await service.fire(second.id);
    await expect(dialog.getByText("No pending waits.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("0 active subscriptions", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pending waits", exact: true })).toBeVisible();
  } finally {
    releaseDispatch();
    await dispatch;
    service.stop();
    await fixture.close();
  }
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
  let heldPolls = 0;
  const isHeldPoll = (url: string) => url.includes("/api/events?") && new URL(url).searchParams.has("wait");
  page.on("request", request => { if (isHeldPoll(request.url())) heldPolls++; });
  page.on("requestfinished", request => { if (isHeldPoll(request.url())) heldPolls--; });
  page.on("requestfailed", request => { if (isHeldPoll(request.url())) heldPolls--; });
  page.on("response", async response => {
    if (!response.url().includes("/api/events?")) return;
    const body = await response.json().catch(() => ({}));
    if (body.events?.some((event: any) => event.eventId === "compact-result-recovery" && event.payload === null)) compactResult = true;
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
  // Publish while a held poll has captured the cursor: it must wake and
  // deliver the event before a concurrent full snapshot could recover it.
  await expect.poll(() => heldPolls).toBeGreaterThan(0);
  await runnerUpdate(request, { id: "compact-result-recovery", sessionId: session.id, turnId, event: "result", data: { reply: "Full answer recovered from the saved turn", tokenIn: 2, tokenOut: 3 } });
  await expect(page.getByText("Full answer recovered from the saved turn", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
  await expect.poll(() => compactResult).toBe(true);
});

test("browser holds versioned idle polls without clearing loaded monitor state", async ({ page, request }) => {
  test.slow();
  await selectSession(request, scenarioSessions.switchBeta.id);
  const requests: URL[] = [];
  const polls: any[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/events?")) requests.push(new URL(request.url()));
  });
  page.on("response", async response => {
    if (!response.url().includes("/api/events?")) return;
    const body = await response.json().catch(() => null);
    if (body) polls.push(body);
  });
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`);
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[0].searchParams.get("stateVersion")).toBeNull();
  expect(requests[1].searchParams.get("stateVersion")).toBe(polls[0].stateVersion);
  expect(requests[1].searchParams.get("wait")).toBe("20000");
  // Nothing changes while idle, so the server holds the poll until it expires.
  await page.waitForTimeout(1_000);
  expect(polls).toHaveLength(1);
  await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  expect(polls[1].events).toEqual([]);
  expect(polls[1]).not.toHaveProperty("processMonitors");
});

test("a lost event poll reconnects with a short poll before holding again", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.switchBeta.id);
  const waits: Array<string | null> = [];
  let failNext = true;
  await page.route("**/api/events?**", async route => {
    waits.push(new URL(route.request().url()).searchParams.get("wait"));
    if (failNext) {
      failNext = false;
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`);
  // A reconnect waits one short-poll interval, then the restore snapshot.
  await expect.poll(() => waits.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  // Held, then the restore uses a short poll instead of waiting out a held one.
  expect(waits.slice(0, 3)).toEqual(["20000", null, "20000"]);
});

test("only one tab per browser holds an event poll open", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.switchBeta.id);
  const url = `/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`;
  const holder = await page.context().newPage();
  const tabs = { holder, other: page };
  const held = { holder: 0, other: 0 };
  const shortPolls = { holder: 0, other: 0 };
  let maxHeld = 0;
  const isEventPoll = (url: string) => url.includes("/api/events?");
  const isHeld = (url: string) => isEventPoll(url) && new URL(url).searchParams.has("wait");
  for (const name of ["holder", "other"] as const) {
    tabs[name].on("request", request => {
      if (!isEventPoll(request.url())) return;
      if (!isHeld(request.url())) { shortPolls[name]++; return; }
      held[name]++;
      maxHeld = Math.max(maxHeld, held.holder + held.other);
    });
    const finished = (request: { url(): string }) => { if (isHeld(request.url())) held[name]--; };
    tabs[name].on("requestfinished", finished);
    tabs[name].on("requestfailed", finished);
  }
  try {
    await holder.goto(url);
    await expect.poll(() => held.holder).toBe(1);
    await page.goto(url);
    // The other tab keeps the short-poll interval while the holder holds.
    await expect.poll(() => shortPolls.other, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(held.other).toBe(0);
    expect(maxHeld).toBe(1);
    // Closing the holder releases its lease to the remaining tab.
    await holder.close();
    held.holder = 0;
    await expect.poll(() => held.other).toBe(1);
    expect(maxHeld).toBe(1);
  } finally {
    if (!holder.isClosed()) await holder.close();
  }
});
