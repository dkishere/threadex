import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("a long turn skips old cards and mounts hidden output only on expansion", async ({ page }) => {
  await page.goto("/e2e/support/timeline-rendering.html");
  const comments = page.locator(".structured-comment");
  await expect(comments).toHaveCount(150);
  await expect(page.locator(".structured-comment-detail")).toHaveCount(0);
  await expect(page.locator(".command-output")).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const fixture = (window as any).timelineFixture;
    fixture.resetReads();
    const link = document.querySelector(".message-text a");
    for (let index = 0; index < 30; index++) {
      await new Promise(requestAnimationFrame);
      fixture.append();
    }
    return { reads: fixture.reads(), stableLink: link === document.querySelector(".message-text a") };
  });
  expect(result.reads).toBe(0);
  expect(result.stableLink).toBe(true);
  await comments.first().locator("summary").first().click();
  await expect(comments.first().locator(".structured-comment-detail")).toContainText("Detail 0");
  await expect(comments.first().locator(".command-output")).toHaveCount(0);
  await comments.first().locator(".command-row").click();
  await expect(comments.first().locator(".command-output")).toContainText("Output 0");
  await page.evaluate(() => (window as any).timelineFixture.updateCommand());
  await expect(comments.first().locator(".command-output")).toHaveText("Updated command output");
  await expect(comments.first()).toHaveAttribute("open", "");
  await page.evaluate(() => (window as any).timelineFixture.finish());
  await expect(comments.first()).toHaveAttribute("open", "");
  await expect(comments.first().locator(".command-card")).toHaveAttribute("open", "");
  await expect(comments.first().locator(".command-output")).toHaveText("Updated command output");
});

test("a short final answer remains responsive within a long turn", async ({ page }) => {
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/e2e/support/timeline-rendering.html?final");
  await expect(page.locator(".message-text table")).toHaveCount(1);
  const result = await page.evaluate(async () => {
    const fixture = (window as any).timelineFixture;
    const chars = fixture.textLength();
    fixture.resetReads();
    const durations: number[] = [];
    for (let index = 0; index < 30; index++) {
      await new Promise(requestAnimationFrame);
      durations.push(fixture.append("字"));
    }
    const reads = fixture.reads();
    const firstCard = document.querySelector(".structured-comment");
    const completionMs = fixture.finish();
    return { chars, reads, preservedCard: firstCard === document.querySelector(".structured-comment"), medianMs: [...durations].sort((a, b) => a - b)[15], maxMs: Math.max(...durations), completionMs };
  });
  expect(result.chars).toBeLessThan(1400);
  expect(result.reads).toBe(0);
  expect(result.preservedCard).toBe(true);
  await expect(page.locator(".turn-conclusion")).toContainText("字".repeat(30));
  await expect(page.locator(".turn-conclusion code.language-ts")).toHaveText("const n = 1;\n");
  await page.evaluate(() => (window as any).timelineFixture.resetReads());
  await page.getByRole("textbox", { name: "Typing probe" }).pressSequentially("typing after final", { delay: 20 });
  await expect(page.getByRole("textbox", { name: "Typing probe" })).toHaveValue("typing after final");
  expect(await page.evaluate(() => (window as any).timelineFixture.reads())).toBe(0);
  console.log("Short final answer + 150 history cards, 4x CPU slowdown:", result);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});

test("streaming defers the transcript cache and pagehide flushes the latest text", async ({ page }) => {
  await page.goto("/e2e/support/timeline-rendering.html?persistence");
  await expect(page.locator(".structured-comment")).toHaveCount(150);
  const writes = await page.evaluate(() => {
    const fixture = (window as any).timelineFixture;
    fixture.resetWrites();
    for (let index = 0; index < 30; index++) fixture.append("字");
    return fixture.writes();
  });
  expect(writes).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).timelineFixture.writes())).toBe(1);
  const saved = await page.evaluate(() => {
    (window as any).timelineFixture.append("latest");
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(localStorage.getItem("timeline-fixture")!).messages[0].content;
  });
  expect(saved).toMatch(/字{30}latest$/);
});
