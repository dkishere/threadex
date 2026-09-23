import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

test("image previews survive Markdown and workspace context updates", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { MarkdownContent, MarkdownWorkspaceContext } from "./MarkdownContent";
        const root = createRoot(document.getElementById("root"));
        window.renderPreview = (markdown) => root.render(
          <MarkdownWorkspaceContext.Provider value={{sessionId: "preview-test", workspaceId: "default"}}>
            <MarkdownContent>{markdown}</MarkdownContent>
          </MarkdownWorkspaceContext.Provider>
        );`,
      resolveDir: import.meta.dirname,
      loader: "tsx"
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    external: ["mermaid", "monaco-editor"],
    loader: { ".css": "empty" }
  });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("**/api/workspaces/file?**", (route) => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" />'
    }));
    await page.route("http://preview.test/", (route) => route.fulfill({
      contentType: "text/html", body: '<div id="root"></div>'
    }));
    await page.goto("http://preview.test/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const render = async (markdown: string) => {
      await page.evaluate((text) => (window as any).renderPreview(text), markdown);
      await page.locator(".markdown-content").waitFor();
    };
    for (const markdown of ["![sample](C:/images/sample.png)", "[sample](C:/images/sample.png)"]) {
      await render(markdown);
      await page.locator(".markdown-content img").click();
      await page.getByRole("dialog").waitFor();
      await render(markdown); // A fresh context value also forces a render.
      await render(markdown + "\n\nStreaming update");
      await page.getByText("Streaming update", { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
    }
    await page.evaluate(() => {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = matchMedia(query);
        Object.defineProperty(result, "matches", { value: true });
        return result;
      };
    });
    await page.route("**/api/workspaces/html/**", (route) => route.fulfill({
      contentType: "application/json", body: JSON.stringify({ url: "/api/workspaces/html-content/test/report.html" })
    }));
    await page.route("**/api/workspaces/html-content/**", (route) => route.fulfill({
      contentType: "text/html", body: "<h1>Report preview</h1>"
    }));
    await render("[report](C:/images/report.html)");
    await page.getByRole("link", { name: "Open HTML preview in new tab" }).click();
    await page.frameLocator('iframe[title="HTML preview"]').getByText("Report preview").waitFor();
    assert.equal(page.url(), "http://preview.test/");
    assert.equal(browser.contexts()[0].pages().length, 1);
    const refreshed = page.waitForRequest("**/api/workspaces/html-content/test/report.html");
    await page.getByRole("button", { name: "Refresh preview" }).click();
    await refreshed;
    await page.frameLocator('iframe[title="HTML preview"]').getByText("Report preview").waitFor();
    assert.equal(page.url(), "http://preview.test/");
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("link", { name: "report", exact: true }).count(), 1);
    await page.context().route("https://external.test/**", (route) => route.fulfill({
      contentType: "text/html", body: "<h1>External website</h1>"
    }));
    await render("[External site](https://external.test/report)");
    await page.getByRole("link", { name: "External site", exact: true }).click();
    await page.frameLocator('iframe[title="https://external.test/report"]').getByText("External website").waitFor();
    assert.equal(page.url(), "http://preview.test/");
    assert.equal(browser.contexts()[0].pages().length, 1);
    assert.equal(await page.getByRole("link", { name: "Open in browser" }).getAttribute("href"), "https://external.test/report");
    await render("[External site](https://external.test/report)\n\nStreaming update");
    assert.equal(await page.getByRole("dialog").count(), 1);
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.evaluate(() => { window.matchMedia = () => ({ matches: false }) as MediaQueryList; });
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "External site", exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), "https://external.test/report");
    assert.equal(await page.getByRole("dialog").count(), 0);
    await popup.close();
  } finally {
    await browser.close();
  }
});
