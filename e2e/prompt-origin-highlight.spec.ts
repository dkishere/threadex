import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/authenticated-test";
import { promptOriginScenario } from "./support/scenarios.js";

const { workspaceId, session, source } = promptOriginScenario;

const prompts = {
  user: "Typed by the user",
  dispatch: "Dispatched from a Decision",
  message: "Sent from another session"
};

async function expectHighlights(page: Page, block: (turn: keyof typeof prompts) => Locator) {
  await expect(block("user")).toBeVisible();
  await expect(block("user")).not.toHaveAttribute("data-threadex-origin");
  await expect(block("user").locator(".prompt-turn-origin")).toHaveCount(0);
  expect(await block("user").evaluate(element => getComputedStyle(element).boxShadow)).not.toContain("inset");

  await expect(block("dispatch")).toHaveAttribute("data-threadex-origin", "decision-dispatch");
  const dispatch = block("dispatch").locator(".prompt-turn-origin");
  await expect(dispatch.locator(".prompt-turn-origin-kind")).toHaveText("Dispatch");
  // The executor stays the primary actor; the differing owner is named as the dispatcher.
  await expect(dispatch.locator(".prompt-turn-origin-name")).toHaveText("Executor Actor");
  await expect(dispatch.locator(".prompt-turn-origin-name")).toBeVisible();
  await expect(dispatch).toHaveAttribute("aria-label", "Prompt sent by actor Executor Actor (decision-dispatch), dispatched by e2e-owner");

  await expect(block("message")).toHaveAttribute("data-threadex-origin", "session-tool");
  const message = block("message").locator("button.prompt-turn-origin");
  await expect(message.locator(".prompt-turn-origin-kind")).toHaveText("Session msg");
  await expect(message.locator(".prompt-turn-origin-name")).toHaveText("Sender Actor");
  await expect(message.locator(".prompt-turn-origin-name")).toBeVisible();
  expect(await block("message").evaluate(element => getComputedStyle(element).boxShadow)).toContain("inset");
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 400, height: 844 }]) {
  test(`highlights Threadex-delivered prompts and leaves typed prompts plain at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/?workspaceId=${workspaceId}&sessionId=${session.id}`);
    const timeline = (turn: keyof typeof prompts) => page.locator(".agent-turn-prompt", { hasText: prompts[turn] });
    await expectHighlights(page, timeline);
    if (viewport.width > 480) await expectHighlights(page, turn => page.locator(`.prompt-turn-card[data-turn-id="${session.id}-${turn}"]`));

    await page.screenshot({ path: test.info().outputPath(`prompt-origin-${viewport.width}.png`), fullPage: true });
    await timeline("message").locator("button.prompt-turn-origin").click();
    await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(source.id);
  });
}
