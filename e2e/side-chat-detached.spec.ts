import { expect, test } from "@playwright/test";

test("side chat reconnects after a failed poll and page reload without submitting twice", async ({ page }) => {
  let submitted: any;
  let sends = 0;
  let offline = false;
  let completed = false;
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { actors: [] } }));
  await page.route("**/api/session-inspector/ask", async route => {
    submitted = route.request().postDataJSON(); sends++;
    await route.fulfill({ status: 202, json: { jobId: "side_chat_job" } });
  });
  await page.route("**/api/sessions/side-test/side-chats", async route => {
    if (offline) { await route.abort("connectionrefused"); return; }
    const message = { id: "side_chat_job", sessionId: "side-test", question: submitted?.question,
      model: submitted?.model, roundId: submitted?.roundId, actor: null, created: new Date().toISOString(), answer: "Saved while disconnected" };
    await route.fulfill({ json: { sideChats: completed ? [message] : [], jobs: submitted && !completed ? [{
      ...message, effort: submitted.modelReasoningEffort, status: "running"
    }] : [] } });
  });
  await page.goto("/e2e/support/side-chat.html");
  await page.getByRole("textbox").fill("Keep working through a restart");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(submitted.async).toBe(true);
  expect(submitted.requestId).toBeTruthy();
  offline = true;
  await expect(page.getByText("Failed to fetch")).toBeVisible();
  offline = false;
  await page.reload();
  await expect(page.getByText("Keep working through a restart")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  completed = true;
  await expect(page.getByText("Saved while disconnected")).toBeVisible();
  await expect(page.getByText("Thinking…")).toHaveCount(0);
  expect(sends).toBe(1);
});
