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
  } finally {
    await browser.close();
  }
});
