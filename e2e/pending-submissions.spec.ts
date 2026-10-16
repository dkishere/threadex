import { expect, test } from "./support/authenticated-test";
import { selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";

test("saved input loads without a panel and submission disables input until acknowledgement", async ({ page, request }) => {
  const session = scenarioSessions.bootstrap;
  await selectSession(request, session.id);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(sessionId => {
    localStorage.setItem("threadex.pending-submission.v1:unconfirmed", JSON.stringify({
      id: "unconfirmed", turnId: "unconfirmed", sessionId, workspaceId: "default", kind: "prompt",
      createdAt: "2026-09-23T12:00:00Z", message: "Previously saved input", attachments: [], settings: { queued: true }
    }));
  }, session.id);
  let release!: () => void;
  const ackGate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/chat", async route => {
    const body = route.request().postDataJSON();
    await ackGate;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body:
      `event: session\ndata: ${JSON.stringify({ sessionId: body.sessionId, turnId: body.turnId, message: "Prompt runner started" })}\n\n` +
      `event: result\ndata: ${JSON.stringify({ sessionId: body.sessionId, turnId: body.turnId, reply: "Acknowledged" })}\n\n` +
      'event: done\ndata: {"ok":true}\n\n'
    });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByText(`Snapshot response for ${session.title}`, { exact: true })).toBeVisible();
  const editor = page.locator('.composer-inline-editor[aria-label="Message"]:visible');
  await editor.fill("Persist before sending");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(editor).toHaveAttribute("aria-disabled", "true");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  const sending = page.getByRole("button", { name: "Sending", exact: true });
  await expect(sending).toBeDisabled();
  await expect(sending.locator(".spin")).toBeVisible();
  await expect(page.locator(".pending-submissions")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("threadex.pending-submission.v1:")).length)).toBe(2);
  release();
  await expect(editor).toHaveAttribute("aria-disabled", "false");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("threadex.pending-submission.v1:")).length)).toBe(1);
  expect(pageErrors).toEqual([]);
});

test("unconfirmed queue prompts can retry or cancel while another turn is running", async ({ page, request }) => {
  const session = scenarioSessions.queue;
  await selectSession(request, session.id);
  const prefix = "threadex.pending-submission.v1:";
  await page.addInitScript(({ sessionId, prefix }) => {
    if (sessionStorage.getItem("unconfirmed-prompts-seeded")) return;
    sessionStorage.setItem("unconfirmed-prompts-seeded", "true");
    for (const id of ["retry-queue", "cancel-queue"]) {
      localStorage.setItem(prefix + id, JSON.stringify({
        id, turnId: id, sessionId, workspaceId: "default", kind: "prompt",
        createdAt: "2026-10-15T08:50:28Z", message: `Saved prompt ${id}`, attachments: [],
        settings: { queued: true, model: "claude-opus-5-5", modelReasoningEffort: "high", approvalPolicy: "granular" }
      }));
    }
  }, { sessionId: session.id, prefix });
  // A running snapshot reproduces the disabled recovery card without starting an agent.
  for (const pattern of ["**/api/workspace/snapshot*", `**/api/sessions/${session.id}/snapshot*`]) {
    await page.route(pattern, async route => {
      const response = await route.fetch();
      const payload = await response.json();
      const snapshot = payload.activeSession ?? payload;
      if (snapshot.session?.id === session.id) {
        snapshot.turns[0].status = "running";
        snapshot.turns[0].runnerStarted = "2026-10-15T08:40:00Z";
      }
      await route.fulfill({ response, json: payload });
    });
  }
  let queueRequests = 0;
  let chatRequests = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/chat") chatRequests++; });
  await page.route("**/api/pending-turns", async route => {
    queueRequests++;
    const body = route.request().postDataJSON();
    expect(body.turnId).toBe("retry-queue");
    expect(body.message).toBe("Saved prompt retry-queue");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.modelReasoningEffort).toBe("high");
    expect(body.approvalPolicy).toBe("granular");
    await route.fulfill({ status: queueRequests === 1 ? 503 : 200, json: queueRequests === 1
      ? { error: "Queue temporarily unavailable" } : { ok: true, duplicate: true, turn: { id: body.turnId, status: "todo" } } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const panel = page.getByRole("region", { name: "Unconfirmed prompts" });
  await expect(panel).toContainText("Retry to queue after the current turn.");
  const editor = page.locator('.composer-inline-editor[aria-label="Message"]:visible');
  await editor.fill("Keep my current draft");
  const cancelled = panel.locator("li", { hasText: "Saved prompt cancel-queue" });
  await cancelled.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(cancelled).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), prefix + "cancel-queue")).toBeNull();
  expect(queueRequests).toBe(0);
  const retry = panel.getByRole("button", { name: "Retry saved prompt" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(panel.getByRole("alert")).toHaveText("Queue temporarily unavailable");
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(panel).toHaveCount(0);
  expect(queueRequests).toBe(2);
  expect(chatRequests).toBe(0);
  await expect(editor).toHaveText("Keep my current draft");
  expect(await page.evaluate(key => localStorage.getItem(key), prefix + "retry-queue")).toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeEnabled();
  await expect(panel).toHaveCount(0);
  await expect(editor).toHaveText("Keep my current draft");
});
