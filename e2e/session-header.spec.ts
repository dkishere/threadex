import { expect, test } from "@playwright/test";

for (const width of [390, 900, 1440]) {
  for (const embedded of [false, true]) {
    test(`session title and owners fit at ${width}px, embedded=${embedded}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      let ownerCount = 2;
      await page.route("**/api/**", route => route.fulfill({ json: {
        revision: 1,
        actors: [{ id: "owner", name: "雷姆 · BDD驗證" }, { id: "guest", name: "Reviewer" }].slice(0, ownerCount),
        workItems: [{ executorActorId: "owner", taskSessionId: "header-session" }, { executorActorId: "guest", taskSessionId: "header-session", sessionScope: "turn" }].slice(0, ownerCount),
      } }));
      for (const title of ["Short title", "Use case 分 primary／secondary 層級及 fairshot-hub 分類 ".repeat(3)]) {
        await page.goto(`/e2e/support/session-header.html?title=${encodeURIComponent(title)}${embedded ? "&embedded=1" : ""}`);
        const badge = page.locator(".session-owner-badge");
        await expect(badge).toBeVisible();
        await expect(page.locator("h1")).toHaveText(title.trim());
        await expect(page.locator(".session-owner-name")).toBeVisible();
        const geometry = await page.evaluate(() => {
          const header = document.querySelector(".content-header")!.getBoundingClientRect();
          return [...document.querySelectorAll("h1, .session-owner-badge, .session-header-id, .content-header-actions")].every(element => {
            const rectangle = element.getBoundingClientRect();
            return rectangle.top >= header.top && rectangle.bottom <= header.bottom && rectangle.left >= header.left && rectangle.right <= header.right && rectangle.right <= innerWidth;
          });
        });
        expect(geometry).toBe(true);
        const headerWidth = (await page.locator(".content-header").boundingBox())!.width;
        if (headerWidth > 600) {
          // Wide header: title, owner badge and session id share one row instead of wrapping under the title.
          const rows = await page.evaluate(() => ["h1", ".session-owner-badge", ".session-header-id", ".content-header-actions"].map(selector => {
            const rectangle = document.querySelector(selector)!.getBoundingClientRect();
            return { top: rectangle.top, bottom: rectangle.bottom };
          }));
          const [titleRow, ...badgeRows] = rows;
          for (const badgeRow of badgeRows) expect(badgeRow.top).toBeLessThan(titleRow.bottom);
        }
        if (title === "Short title") await page.locator(".content-header").screenshot({ path: `/private/tmp/session-header-${width}-${embedded}.png` });
        await badge.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("menuitem").first()).toBeFocused();
        const menu = await page.getByRole("menu").boundingBox();
        expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
        await page.keyboard.press("Escape");
        await expect(badge).toBeFocused();
        await expect(page.getByRole("menu")).toHaveCount(0);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("menu")).toBeVisible();
        await page.getByRole("menuitem").last().click();
        await expect(page.locator("body")).toHaveAttribute("data-opened-actor", "guest");
      }
      ownerCount = 1;
      await page.reload();
      await expect(page.locator(".session-owner-badge")).toBeVisible();
      await expect(page.locator(".session-owner-more")).toHaveCount(0);
      await page.locator(".session-owner-badge").click();
      await expect(page.locator("body")).toHaveAttribute("data-opened-actor", "owner");
    });
  }
}

for (const panelWidth of [360, 480, 640, 900]) {
  test(`split panel uses its own ${panelWidth}px width on a wide viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/**", route => route.fulfill({ json: { revision: 1,
      actors: [{ id: "owner", name: "錦木千束 · 執行程序" }, { id: "guest", name: "Reviewer" }],
      workItems: [{ executorActorId: "owner", taskSessionId: "header-session" }, { executorActorId: "guest", taskSessionId: "header-session", sessionScope: "turn" }],
    } }));
    await page.goto(`/e2e/support/session-header.html?embedded=1&panelWidth=${panelWidth}&title=${encodeURIComponent("清理 process monitor 一次性殘留項目".repeat(5))}`);
    await expect(page.locator(".session-owner-more")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const rectangle = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return { header: rectangle(".content-header"), title: rectangle("h1"), owner: rectangle(".session-owner-badge"), id: rectangle(".session-header-id"), actions: rectangle(".content-header-actions"), titleOverflow: document.querySelector("h1")!.scrollWidth > document.querySelector("h1")!.clientWidth };
    });
    expect(geometry.header.width).toBeCloseTo(panelWidth);
    expect(geometry.title.height).toBeLessThan(25);
    expect(geometry.title.width).toBeGreaterThan(30);
    expect(geometry.titleOverflow).toBe(true);
    for (const rectangle of [geometry.owner, geometry.id]) {
      expect(rectangle.top).toBeLessThan(geometry.title.bottom);
      expect(rectangle.bottom).toBeGreaterThan(geometry.title.top);
    }
    expect(geometry.actions.right).toBeLessThanOrEqual(geometry.header.right);
    if (panelWidth > 600) expect(geometry.actions.top).toBeLessThan(geometry.title.bottom);
    else expect(geometry.actions.top).toBeGreaterThanOrEqual(geometry.owner.bottom);
  });
}
