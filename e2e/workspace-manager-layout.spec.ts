import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, checkedJson } from "./support/mock-runner";

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
