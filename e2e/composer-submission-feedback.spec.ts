import { expect } from "@playwright/test";
import { test } from "./support/authenticated-test";
import { scenarioSessions } from "./support/scenarios.js";

for (const method of ["click", "Enter"] as const) {
  test(`${method} shows a local-save failure and lets the retained draft retry`, async ({ page }) => {
    await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchAlpha.id}`);
    const composer = page.locator("form.composer");
    const editor = composer.getByRole("textbox", { name: "Message", exact: true });
    await editor.fill("Keep this draft until delivery succeeds");
    await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("threadex.pending-submission.v1:")) {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
      (window as any).restoreSubmissionStorage = () => { Storage.prototype.setItem = original; };
    });
    let chatRequests = 0;
    await page.route("**/api/chat", async route => {
      chatRequests++;
      const { sessionId, turnId } = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "text/event-stream", body:
        `event: result\ndata: ${JSON.stringify({ sessionId, turnId, reply: "Submission received", elapsedMs: 1 })}\n\nevent: done\ndata: {"ok":true}\n\n` });
    });
    const send = () => method === "Enter" ? editor.press("Enter") : composer.getByRole("button", { name: "Send", exact: true }).click();
    await send();
    await expect(composer.getByRole("alert")).toContainText("Prompt not sent: unable to save locally");
    await expect(editor).toHaveText("Keep this draft until delivery succeeds");
    expect(chatRequests).toBe(0);
    await send();
    await expect(composer.getByRole("alert")).toBeVisible();
    expect(chatRequests).toBe(0);
    await page.evaluate(() => (window as any).restoreSubmissionStorage());
    await send();
    await expect.poll(() => chatRequests).toBe(1);
    await expect(composer.getByRole("alert")).toHaveCount(0);
    await expect(editor).not.toContainText("Keep this draft until delivery succeeds");
  });
}
