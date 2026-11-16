import type { Locator } from "@playwright/test";
import { expect, test } from "./support/authenticated-test";
import { transcriptHistoryScenario } from "./support/scenarios.js";

const { workspaceId, session } = transcriptHistoryScenario;
const sessionUrl = `/?workspaceId=${workspaceId}&sessionId=${session.id}`;
// Each timeline prompt also has a hidden copy, so match the rendered one.
const prompt = (messages: Locator, index: number) => messages.getByText(`History prompt ${index}`, { exact: true }).filter({ visible: true });

for (const viewport of [{ width: 1280, height: 900 }, { width: 400, height: 844 }]) {
  test(`load earlier prepends turns without moving the reader at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(sessionUrl);
    const messages = page.locator(".messages:not(.side-chat-messages)");
    const history = page.getByRole("region", { name: "Conversation history" });
    const loadEarlier = history.getByRole("button", { name: "Load 3 earlier turns" });
    await expect(prompt(messages, 53)).toBeVisible();
    await expect(prompt(messages, 3)).toHaveCount(0);
    await expect(page.locator("nav.transcript-history-navigation")).toHaveCount(0);
    await expect(loadEarlier).toHaveText("Load earlier");
    await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);

    // A real wheel scroll counts as reader interaction and ends the open-at-bottom behaviour.
    await messages.hover();
    await page.mouse.wheel(0, -100_000);
    await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(0);
    const oldestLoaded = prompt(messages, 4);
    const before = await oldestLoaded.evaluate(element => element.getBoundingClientRect().top);
    await loadEarlier.focus();
    await page.keyboard.press("Enter");

    await expect(prompt(messages, 1)).toBeAttached();
    await expect(prompt(messages, 53)).toBeAttached();
    expect(Math.abs(await oldestLoaded.evaluate(element => element.getBoundingClientRect().top) - before)).toBeLessThan(2);
    await expect(history.getByRole("button")).toHaveCount(0);
    await expect(history.getByRole("status")).toHaveText("Loaded 3 earlier turns. Start of conversation.");
  });
}

test("a turn deep link loads earlier turns through the latest and keeps the linked turn in view", async ({ page }) => {
  await page.goto(`${sessionUrl}&turnId=${session.id}-turn-2`);
  const messages = page.locator(".messages:not(.side-chat-messages)");
  await expect(prompt(messages, 2)).toBeInViewport();
  await expect(prompt(messages, 53)).toBeAttached();
  await expect(prompt(messages, 1)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Conversation history" }).getByRole("button", { name: "Load 1 earlier turn" })).toBeVisible();
});
