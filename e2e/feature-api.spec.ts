import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";
import { mockGrillSummaries } from "./support/grill";
import type { TurnGrill } from "../src/turnGrill";

test("Grill reads only known reviews and changed revisions, retrying on the shared heartbeat", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  await selectSession(request, session.id);
  let saved: TurnGrill | null = null;
  await mockGrillSummaries(page, session.id, () => saved);
  let reads = 0;
  let lists = 0;
  let failNext = false;
  page.on("request", request => { if (/\/grills$/.test(request.url())) lists++; });
  await page.route("**/api/sessions/*/turns/*/grill", async route => {
    reads++;
    if (failNext) { failNext = false; return route.fulfill({ status: 503, body: "Unavailable" }); }
    return route.fulfill({ json: { grill: saved } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByRole("button", { name: "Grill agent", exact: true })).toBeEnabled();
  expect(reads).toBe(0);
  expect(lists).toBe(0);
  saved = { revision: 1, status: "running", updated: "", error: null, issues: [], rounds: [] };
  const panel = page.getByRole("region", { name: "Grill review" });
  await expect(panel).toHaveAttribute("aria-busy", "true");
  expect(reads).toBe(1);
  // More than two of the old per-panel intervals must not fetch the same job.
  await page.waitForTimeout(4500);
  expect(reads).toBe(1);
  failNext = true;
  saved = { ...saved, revision: 2, status: "ready" };
  await expect(panel.getByRole("alert")).toContainText("Reconnecting");
  await expect(panel).toContainText("No material gaps found");
  expect(reads).toBe(3);
  expect(lists).toBe(0);
});

test("Ask history loads on first open, stays loaded across tabs, and appends the mutation response", async ({ page, request }) => {
  const session = scenarioSessions.switchBeta;
  await selectSession(request, session.id);
  let historyReads = 0;
  let inspectorReads = 0;
  let asks = 0;
  page.on("request", request => { if (request.url().includes("/api/session-inspector/session")) inspectorReads++; });
  await page.route("**/api/sessions/*/side-chats", route => {
    historyReads++;
    return route.fulfill({ json: { sideChats: [] } });
  });
  await page.route("**/api/session-inspector/ask", route => {
    asks++;
    return route.fulfill({ json: { sideChat: { id: "answer", sessionId: session.id, question: route.request().postDataJSON().question,
      answer: "Saved answer", model: "fixture", created: new Date().toISOString() } } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByRole("tab", { name: "Side chat", exact: true })).toBeVisible();
  expect(historyReads).toBe(0);
  await page.getByRole("tab", { name: "Side chat", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Read-only side chat" });
  await expect(panel).toContainText("Ask without changing the session");
  expect(historyReads).toBe(1);
  await panel.getByRole("textbox").fill("Explain the result");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel).toContainText("Saved answer");
  await page.getByRole("tab", { name: "Turns", exact: true }).click();
  await page.getByRole("tab", { name: "Side chat", exact: true }).click();
  await expect(panel).toContainText("Saved answer");
  expect(asks).toBe(1);
  expect(historyReads).toBe(1);
  expect(inspectorReads).toBe(0);
});

test("side-chat history endpoint returns only history and distinguishes missing sessions", async ({ request }) => {
  const response = await request.get(`${apiBaseUrl}/api/sessions/${scenarioSessions.switchAlpha.id}/side-chats`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ sideChats: [], sideChatPage: { limit: 100, offset: 0, total: 0, hasMore: false } });
  expect((await request.get(`${apiBaseUrl}/api/sessions/missing-history-session/side-chats`)).status()).toBe(404);
});
