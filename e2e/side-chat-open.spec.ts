import { expect, test, type Page } from "@playwright/test";

const longSideChat = (sessionId: string) => Array.from({ length: 30 }, (_, index) => ({
  id: `${sessionId}-${index}`, sessionId, question: `${sessionId} question ${index}`, model: "gpt-6", roundId: `${sessionId}-round-${index}`,
  actor: null, created: new Date(2026, 0, 1, 0, index).toISOString(), answer: `${sessionId} answer ${index}`
}));

async function mockSideChats(page: Page) {
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { actors: [] } }));
  await page.route("**/api/sessions/*/side-chats", route => {
    const sessionId = route.request().url().split("/api/sessions/")[1].split("/")[0];
    // Delay so the panel finishes loading while still hidden, like a background-mounted tab.
    return new Promise(resolve => setTimeout(resolve, 300)).then(() => route.fulfill({ json: { sideChats: longSideChat(sessionId), jobs: [] } }));
  });
}

async function expectScrolledToBottom(page: Page) {
  await expect.poll(() => page.locator(".side-chat-messages").evaluate(element =>
    element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
}

test("opening the side chat tab lands at the bottom, also when it loaded while hidden", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
});

test("reopening and switching sessions do not reuse the previous scroll position", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await page.locator(".side-chat-messages").evaluate(element => { element.scrollTop = 0; });
  await page.getByRole("button", { name: "Turns tab" }).click();
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expectScrolledToBottom(page);
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.getByText("side-b answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
});

test("scrolling up after opening is not pulled back to the bottom", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
  await page.locator(".side-chat-messages").hover();
  await page.mouse.wheel(0, -600);
  const top = await page.locator(".side-chat-messages").evaluate(element => element.scrollTop);
  await page.waitForTimeout(500);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollTop)).toBeLessThan(top + 50);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
});
