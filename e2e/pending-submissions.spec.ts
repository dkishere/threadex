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
