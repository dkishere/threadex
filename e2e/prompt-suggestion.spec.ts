import { expect } from "@playwright/test";
import { test } from "./support/authenticated-test";
import { scenarioSessions } from "./support/scenarios.js";

test("a native prompt suggestion under the conclusion fills the draft or sends directly", async ({ page }) => {
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchAlpha.id}`);
  const composer = page.locator("form.composer");
  const editor = composer.getByRole("textbox", { name: "Message", exact: true });
  const messages: string[] = [];
  await page.route("**/api/chat", async route => {
    const { sessionId, turnId, message } = route.request().postDataJSON();
    messages.push(message);
    const promptSuggestion = messages.length === 1 ? "Now add tests" : undefined;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body:
      `event: result\ndata: ${JSON.stringify({ sessionId, turnId, reply: `Reply ${messages.length}`, elapsedMs: 1, promptSuggestion })}\n\nevent: done\ndata: {"ok":true}\n\n` });
  });

  await editor.fill("Plan the change");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  const suggestion = page.getByRole("group", { name: "Suggested next prompt" });
  await expect(suggestion).toContainText("Now add tests");
  await expect(page.locator(".turn-conclusion + .turn-prompt-suggestion")).toHaveCount(1);

  await editor.fill("Keep my draft");
  await suggestion.getByRole("button", { name: "Edit suggested prompt" }).click();
  await expect(editor).toContainText("Keep my draft");
  await expect(editor).toContainText("Now add tests");
  expect(messages).toHaveLength(1);

  await suggestion.getByRole("button", { name: "Send suggested prompt" }).click();
  await expect.poll(() => messages).toEqual(["Plan the change", "Now add tests"]);
  await expect(editor).toContainText("Keep my draft");
  // The newer turn has no suggestion, so the old one is no longer offered.
  await expect(page.getByRole("group", { name: "Suggested next prompt" })).toHaveCount(0);
});
