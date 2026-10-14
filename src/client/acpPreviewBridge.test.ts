import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createAcpRouter, type AcpBackend } from "../server/acp";
import { createSecurity } from "../server/security";
import { addBddFeedback } from "../server/bddFeedback";

// WEB_BDD_BUILDER selects the maintained framework without coupling Threadex
// installations to a particular user's skill directory.
const builderPath = process.env.WEB_BDD_BUILDER;
test("BDD comments reach the source session through the sandbox, preserving context and retry identity", {
  skip: !builderPath, timeout: 30000
}, async () => {
  const { html, contract } = await (await import(pathToFileURL(builderPath!).href)).buildDemo();
  const bundle = await build({ stdin: { contents: `
    import { createLinkPreview } from './linkPreview';
    document.getElementById('open').onclick = () => {
      const preview = createLinkPreview('BDD review', true);
      preview.navigate('/demo'); preview.feedback({id:'session',cwd:'/project'});
    };`, resolveDir: import.meta.dirname, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser" });
  const turns = new Map<string, { sessionId: string; userInput: string; agentResponse: string; status: "todo" | "done"; runnerExitCode: number | null }>();
  const queued: string[] = [];
  const backend: AcpBackend = {
    async create() { throw new Error("Preview must not create a session"); },
    async session(id) { return id === "session" ? { id, cwd: "/project" } : null; },
    async turn(id) { return turns.get(id) ?? null; },
    async enqueue(sessionId, message, id) {
      queued.push(id); turns.set(id, { sessionId, userInput: message.trim(), agentResponse: "", status: "todo", runnerExitCode: null });
    },
    async cancel() { throw new Error("No cancellation requested"); }
  };
  const directory = mkdtempSync(join(tmpdir(), "threadex-acp-browser-"));
  const app = express();
  app.use("/api", createSecurity(join(directory, "security.json")));
  app.use(express.json()); app.use("/api/acp", createAcpRouter(backend));
  app.get("/", (_req, res) => res.type("html").send('<button id="open">Open review</button><script>' + bundle.outputFiles[0].text + '</script>'));
  app.get("/demo", (_req, res) => {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    res.type("html").send(addBddFeedback(html));
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const login = await fetch(base + "/api/security/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bdd-feedback-test-password" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const context = await browser.newContext();
    await context.addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: base }]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.setDefaultTimeout(5000);
    await page.goto(base);
    await page.getByRole("button", { name: "Open review" }).click();
    const frame = page.frameLocator('iframe[title="BDD review"]');
    await frame.locator("#page-title").filter({ hasText: contract.document.title }).waitFor();
    await frame.locator("#loaded-scenario").filter({ hasText: "fixture loaded" }).waitFor();
    await frame.getByRole("tab", { name: /Comments/ }).click();
    await frame.locator("#panel-comments").waitFor({ state: "visible" });
    assert.equal(await frame.locator("#tab-comments").getAttribute("aria-selected"), "true");
    assert.equal(await frame.locator("#notice").innerText().then(text => text.startsWith("Demo could not start")), false, JSON.stringify(pageErrors));
    await frame.locator("#add-comment").click();
    await frame.locator("#comment-anchor").selectOption("save-draft");
    await frame.locator("#comment-text").fill("Keep the selected evidence. 用户意见 <script> stays plain text.");
    await frame.locator("#save-comment").click();
    assert.equal(await frame.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
    assert.equal(queued.length, 0);
    await page.getByRole("button", { name: "Enable agent feedback" }).click();
    await frame.locator("#agent-status").filter({ hasText: "Connected to session" }).waitFor();
    await frame.getByRole("button", { name: "Send to agent", exact: true }).click();
    await frame.locator("[data-acp-comment] .comment-meta").filter({ hasText: "Agent: accepted" }).waitFor();
    assert.equal(queued.length, 1);
    const saved = turns.get(queued[0])!;
    const feedback = JSON.parse(saved.userInput.slice(saved.userInput.indexOf("\n\n") + 2));
    assert.equal(saved.sessionId, "session");
    assert.equal(feedback.comment.text, "Keep the selected evidence. 用户意见 <script> stays plain text.");
    assert.equal(feedback.comment.anchorId, "save-draft");
    assert.equal(feedback.scenario.id, feedback.comment.scenarioId);
    assert.equal(feedback.document.id, feedback.comment.documentId);
    assert.ok(feedback.comment.context.selector);
    assert.equal(await frame.locator("#notice").filter({ hasText: "User" }).count(), 0);

    // A different source window and a changed target cannot dispatch a prompt.
    await page.evaluate(() => window.postMessage({ channel: "threadex-acp-v1", message: {
      jsonrpc: "2.0", id: "spoof", method: "session/prompt", params: { sessionId: "other", prompt: [{ type: "text", text: "Injected" }] }
    } }, "*"));
    const child = page.frames().find(item => item.url().endsWith("/demo"))!;
    await child.evaluate(() => {
      (window as any).replies = [];
      window.addEventListener("message", event => (window as any).replies.push(event.data));
      window.parent.postMessage({ channel: "threadex-acp-v1", message: { jsonrpc: "2.0", id: "escape", method: "session/prompt", params: { sessionId: "other", prompt: [{ type: "text", text: "Injected" }] } } }, "*");
    });
    await child.waitForFunction(() => (window as any).replies.some((item: any) => item.message?.id === "escape" && item.message?.error?.code === -32602));
    assert.equal(queued.length, 1);

    await page.getByRole("button", { name: "Disconnect agent feedback" }).click();
    await frame.getByRole("button", { name: "Retry agent feedback" }).waitFor();
    await page.getByRole("button", { name: "Enable agent feedback" }).click();
    await frame.locator("#agent-status").filter({ hasText: "Connected to session" }).waitFor();
    await frame.getByRole("button", { name: "Retry agent feedback" }).click();
    await frame.locator("[data-acp-comment] .comment-meta").filter({ hasText: "Agent: accepted" }).waitFor();
    assert.equal(queued.length, 1, "Reconnect/retry must reuse the saved turn");
    Object.assign(saved, { status: "done", agentResponse: "Evidence selection preserved." });
    await frame.locator("#agent-status").filter({ hasText: "finished processing" }).waitFor();
    assert.equal(await frame.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Close preview", exact: true }).click();
    assert.equal(page.frames().length, 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});
