import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson, e2eDataDir } from "./support/mock-runner";
import { SessionStore } from "../src/server/sessionStore";
import { resolve } from "node:path";

test("manager loads history only in requested chunks, preserves scroll, retries errors and reopens with a recent page", async ({ page }) => {
  const manager = await checkedJson(await page.request.post(`${apiBaseUrl}/api/workspace-manager`, {
    data: { workspaceId: "default", notificationsEnabled: false }
  }));
  const store = new SessionStore(resolve(e2eDataDir, "session-manager.duckdb"));
  try {
    await store.ready();
    for (let index = 1; index <= 120; index++) {
      await store.recordSessionTurn({ id: `history-${String(index).padStart(3, "0")}`, sessionId: manager.sessionId,
        userInput: `History request ${index}`, agentResponse: `History reply ${index}`, status: "done", tokenIn: 0, tokenOut: 0 });
    }
  } finally { await store.close(); }
  const earlierRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (new URL(request.url()).searchParams.has("beforeTurnId")) earlierRequests.push(request.url());
  });
  await page.goto(`/?workspaceId=default&sessionId=${manager.sessionId}&view=workspace-chat`);
  const messages = page.locator('.chat[data-workspace-manager="true"] .messages');
  const replies = messages.locator(".message.assistant");
  const loadEarlier = messages.getByRole("button", { name: "Load earlier messages", exact: true });
  await expect(replies).toHaveCount(50);
  await expect(replies.first()).toHaveAttribute("data-turn-id", "history-071");
  await messages.evaluate(element => { element.scrollTop = 0; });
  await expect(loadEarlier).toBeVisible();
  expect(earlierRequests).toHaveLength(0);

  const olderRoute = `**/api/sessions/${manager.sessionId}/snapshot?view=workspace-chat&beforeTurnId=*`;
  await page.route(olderRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Retry fixture" }) }), { times: 1 });
  await loadEarlier.click();
  await expect(messages.getByRole("alert")).toContainText("Retry fixture");
  await expect(replies).toHaveCount(50);
  await expect(loadEarlier).toBeEnabled();
  const anchor = messages.locator('.message.user[data-turn-id="history-071"]');
  const beforeTop = await anchor.evaluate(element => element.getBoundingClientRect().top);
  await loadEarlier.click();
  await expect(replies).toHaveCount(100);
  const afterTop = await anchor.evaluate(element => element.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThan(2);
  expect(earlierRequests).toHaveLength(2);
  await loadEarlier.click();
  await expect(replies).toHaveCount(120);
  await expect(loadEarlier).toHaveCount(0);
  expect(earlierRequests).toHaveLength(3);

  await page.reload();
  await expect(replies).toHaveCount(50);
  expect(earlierRequests).toHaveLength(3);
  await page.getByRole("link", { name: "Open raw manager session" }).click();
  await expect(page.locator('.chat:not([data-workspace-manager]) .message.assistant')).toHaveCount(120);
  await page.getByRole("link", { name: "Back to Manager" }).click();
  await expect(replies).toHaveCount(50);
  expect(earlierRequests).toHaveLength(3);
  expect(errors).toEqual([]);
});

test("manager keeps a long draft and attachment inside the viewport with reachable controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const manager = await checkedJson(await page.request.post(`${apiBaseUrl}/api/workspace-manager`, {
    data: { workspaceId: "default", notificationsEnabled: false }
  }));
  await page.setViewportSize({ width: 390, height: 320 });
  await page.goto(`/?workspaceId=default&sessionId=${manager.sessionId}&view=workspace-chat`);
  const chat = page.locator('.chat[data-workspace-manager="true"]');
  const composer = chat.locator(":scope > .composer");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".composer-editor")).toHaveAttribute("contenteditable", "true");
  await composer.locator(".composer-editor").fill(Array.from({ length: 40 }, (_, i) => `Long manager draft line ${i + 1}`).join("\n"));
  await composer.locator('input[type="file"]').setInputFiles({
    name: "layout-check.txt", mimeType: "text/plain", buffer: Buffer.from("Layout fixture; do not send.")
  });
  await expect(composer.getByText("layout-check.txt", { exact: true })).toBeVisible();

  for (const viewport of [{ width: 390, height: 320 }, { width: 768, height: 600 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => composer.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const buttons = [element.querySelector(".composer-upload"), element.querySelector(".send-button")];
      return bounds.bottom <= innerHeight + 1 && bounds.right <= innerWidth + 1 && bounds.left >= 0 &&
        buttons.every(button => {
          if (!button) return false;
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.top >= bounds.top && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1 &&
            (hit === button || button.contains(hit));
        });
    })).toBe(true);
    const middle = page.getByRole("button", { name: "Toggle middle panel", exact: true });
    if (await middle.getAttribute("aria-expanded") === "false") await middle.click();
    await expect(chat.locator(".workspace-manager-dashboard")).toBeVisible();
    const dashboard = await chat.locator(".workspace-manager-dashboard").boundingBox();
    expect(dashboard!.x + dashboard!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(dashboard!.y + dashboard!.height).toBeLessThanOrEqual(viewport.height + 1);
    await middle.click();
    await expect(composer).toBeVisible();
  }
  await page.reload();
  await expect(composer).toBeVisible();
  expect(errors).toEqual([]);
});

test("manager opens its hidden session as raw history and links back without changing ordinary session navigation", async ({ page }) => {
  const manager = await checkedJson(await page.request.post(`${apiBaseUrl}/api/workspace-manager`, {
    data: { workspaceId: "default", notificationsEnabled: false }
  }));
  await page.goto(`/?workspaceId=default&sessionId=${manager.sessionId}&view=workspace-chat`);
  await expect(page.locator('.chat[data-workspace-manager="true"]')).toBeVisible();
  await expect(page.locator(`.session-row[data-session-id="${manager.sessionId}"]`)).toHaveCount(0);

  const raw = page.getByRole("link", { name: "Open raw manager session" });
  await expect(raw).toHaveAttribute("href", `/?workspaceId=default&sessionId=${manager.sessionId}`);
  await raw.click();
  await expect(page.locator('.chat[data-workspace-manager="true"]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${manager.sessionId}`);
  await expect(page.locator(`.session-row[data-session-id="${manager.sessionId}"]`)).toHaveCount(0);

  const back = page.getByRole("link", { name: "Back to Manager" });
  await expect(back).toHaveAttribute("href", `/?workspaceId=default&sessionId=${manager.sessionId}&view=workspace-chat`);
  await back.click();
  await expect(page.locator('.chat[data-workspace-manager="true"]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${manager.sessionId}&view=workspace-chat`);

  const ordinary = page.locator(".session-row").first();
  const ordinaryId = await ordinary.getAttribute("data-session-id");
  expect(ordinaryId).toBeTruthy();
  await ordinary.click();
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${ordinaryId}`);
});
