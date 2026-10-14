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

test("Side chat room: added actors replace the default, all answer, @mentions narrow, and replies name another actor", async ({ page, request }) => {
  const session = scenarioSessions.switchBeta;
  await selectSession(request, session.id);
  await page.addInitScript(() => localStorage.removeItem(`threadex.sideChatActors:${new URLSearchParams(location.search).get("sessionId")}`));
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { revision: 1, actors: [
    { id: "critic", name: "Critic", model: "gpt-5.5", effort: "high", rolePrompt: "Challenge it", isDefault: false },
    { id: "builder", name: "Builder", model: "gpt-5.5", effort: "low", rolePrompt: "", isDefault: false }
  ] } }));
  await page.route("**/api/sessions/*/side-chats", route => route.fulfill({ json: { sideChats: [] } }));
  const asks: { question: string; actor?: { name: string }; roundId?: string; replyToId?: string; participants?: string[] }[] = [];
  await page.route("**/api/session-inspector/ask", route => {
    const body = route.request().postDataJSON();
    asks.push(body);
    const { actor } = body;
    return route.fulfill({ json: { sideChat: { id: `answer-${asks.length}`, sessionId: session.id, question: body.question, roundId: body.roundId,
      replyToId: body.replyToId ?? null, actor: actor ? { id: actor.id, name: actor.name, model: actor.model, effort: actor.effort } : null,
      answer: `${actor?.name ?? "Default"} answer ${asks.length}`, model: actor?.model ?? "fixture", created: new Date().toISOString() } } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await page.getByRole("tab", { name: "Side chat", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Read-only side chat" });
  await expect(panel.getByRole("complementary", { name: "Side chat model gears" })).toBeVisible();
  await panel.getByRole("combobox", { name: "Add actor" }).selectOption("critic");
  await panel.getByRole("combobox", { name: "Add actor" }).selectOption("builder");
  await expect(panel.getByRole("complementary", { name: "Side chat model gears" })).toHaveCount(0);
  const composerBox = await panel.locator(".side-chat-composer").boundingBox();
  const toolbarBox = await panel.locator(".side-chat-composer .composer-bar").boundingBox();
  expect(Math.abs(toolbarBox!.x - composerBox!.x), "without the gearbox the toolbar fills the composer width").toBeLessThan(1);

  await panel.getByRole("textbox").fill("Ship it?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(panel).toContainText("Critic answer");
  await expect(panel).toContainText("Builder answer");
  expect(asks.map(ask => ask.actor?.name).sort()).toEqual(["Builder", "Critic"]);
  expect(new Set(asks.map(ask => ask.roundId)).size).toBe(1);
  expect(asks[0].participants).toEqual(["Critic", "Builder"]);

  const composer = panel.getByRole("textbox");
  await composer.pressSequentially("Only you @Bu");
  const mentions = panel.getByRole("listbox", { name: "Mention an actor" });
  await expect(mentions.getByRole("option")).toHaveCount(1);
  await expect(mentions).toContainText("@Builder");
  await composer.press("Enter");
  await expect(composer).toContainText("@Builder");
  await composer.press("Enter");
  await expect(panel).toContainText("Builder answer 3");
  expect(asks).toHaveLength(3);
  expect(asks[2].actor?.name).toBe("Builder");

  await panel.getByRole("combobox", { name: "Ask another actor to reply to Builder" }).last().selectOption({ label: "Critic" });
  await expect(panel).toContainText("Critic answer 4");
  expect(asks[3]).toMatchObject({ actor: { name: "Critic" }, replyToId: "answer-3" });
  await expect(panel).toContainText("↩ Builder");
});

test("side-chat history endpoint returns only history and distinguishes missing sessions", async ({ request }) => {
  const response = await request.get(`${apiBaseUrl}/api/sessions/${scenarioSessions.switchAlpha.id}/side-chats`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ sideChats: [], sideChatPage: { limit: 100, offset: 0, total: 0, hasMore: false } });
  expect((await request.get(`${apiBaseUrl}/api/sessions/missing-history-session/side-chats`)).status()).toBe(404);
});
