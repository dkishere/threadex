import { expect, test, type Page } from "@playwright/test";

const longSideChat = (sessionId: string) => Array.from({ length: 30 }, (_, index) => ({
  id: `${sessionId}-${index}`, sessionId, question: `${sessionId} question ${index}`, model: "gpt-6", roundId: `${sessionId}-round-${index}`,
  actor: null, created: new Date(2026, 0, 1, 0, index).toISOString(), answer: `${sessionId} answer ${index}`
}));

async function mockSideChats(page: Page) {
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { actors: [] } }));
  await page.route("**/api/sessions/*/side-chats", route => {
    const sessionId = route.request().url().split("/api/sessions/")[1].split("/")[0];
    // Delay so the panel finishes loading while still hidden, like a background-mounted tab.
    return new Promise(resolve => setTimeout(resolve, 300)).then(() => route.fulfill({ json: { sideChats: longSideChat(sessionId), jobs: [] } }));
  });
}

async function expectScrolledToBottom(page: Page) {
  await expect.poll(() => page.locator(".side-chat-messages").evaluate(element =>
    element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
}

test("opening the side chat tab lands at the bottom, also when it loaded while hidden", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
});

test("reopening and switching sessions do not reuse the previous scroll position", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await page.locator(".side-chat-messages").evaluate(element => { element.scrollTop = 0; });
  await page.getByRole("button", { name: "Turns tab" }).click();
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expectScrolledToBottom(page);
  await page.getByRole("button", { name: "Switch session" }).click();
  await expect(page.getByText("side-b answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
});

test("scrolling up after opening is not pulled back to the bottom", async ({ page }) => {
  await mockSideChats(page);
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  await expect(page.getByText("side-a answer 29")).toBeVisible();
  await expectScrolledToBottom(page);
  await page.locator(".side-chat-messages").hover();
  await page.mouse.wheel(0, -600);
  const top = await page.locator(".side-chat-messages").evaluate(element => element.scrollTop);
  await page.waitForTimeout(500);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollTop)).toBeLessThan(top + 50);
  expect(await page.locator(".side-chat-messages").evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
});

test("annotation questions render as collapsed reference cards instead of the injected prompt", async ({ page }) => {
  const sessionId = "side-a";
  const annotationPrompt = [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response or workspace file and may include a user comment. Use every selection and its source as context, and address every comment in your response.",
    "<response-annotations>",
    JSON.stringify([{ text: "selected excerpt ".repeat(40), annotation: "my comment", source: { type: "response", sessionUrl: "threadex://workspace/thread", turnNumber: 2 } }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "please explain the excerpt"
  ].join("\n");
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { actors: [] } }));
  await page.route("**/api/sessions/*/side-chats", route => route.fulfill({ json: { sideChats: [{
    id: `${sessionId}-annotated`, sessionId, question: annotationPrompt, model: "gpt-6", roundId: `${sessionId}-annotated-round`,
    actor: null, created: new Date(2026, 0, 1).toISOString(), answer: "annotated answer"
  }], jobs: [] } }));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  const question = page.locator(".side-chat-question");
  await expect(question.getByText("please explain the excerpt")).toBeVisible();
  await expect(question.getByText("Each item contains text selected")).toHaveCount(0);
  await expect(question.getByText("<response-annotations>")).toHaveCount(0);
  await expect(question.locator(".response-annotation-label")).toHaveText("Quoted response · Turn 2");
  await expect(question.locator(".response-annotation-comment")).toHaveText("my comment");
  const excerpt = question.locator("details.response-annotation-excerpt");
  await expect(excerpt).not.toHaveAttribute("open", "");
  await excerpt.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(excerpt).toHaveAttribute("open", "");
});

test("side chat accumulates multiple annotations, removes one and sends the rest together", async ({ page }) => {
  let submitted: any;
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { actors: [] } }));
  await page.route("**/api/session-inspector/ask", async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { jobId: "side_chat_job" } });
  });
  await page.route("**/api/sessions/*/side-chats", route => route.fulfill({ json: { sideChats: [], jobs: [] } }));
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/e2e/support/side-chat-open.html");
  await page.getByRole("button", { name: "Side chat tab" }).click();
  for (let index = 0; index < 3; index++) await page.getByRole("button", { name: "Add annotation" }).click();
  const chips = page.locator(".composer-response-quote");
  await expect(chips).toHaveCount(3);
  await chips.nth(1).getByRole("button", { name: "Remove annotation" }).click();
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("excerpt 1");
  await expect(chips.nth(1)).toContainText("excerpt 3");
  await page.getByRole("textbox").fill("compare these");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submitted?.question).toContain("compare these");
  expect(submitted.question).toContain("excerpt 1");
  expect(submitted.question).toContain("excerpt 3");
  expect(submitted.question).not.toContain("excerpt 2");
  await expect(chips).toHaveCount(0);
  const question = page.locator(".side-chat-question");
  await expect(question.locator(".response-annotation-attachment")).toHaveCount(2);
  await expect(question.getByText("compare these")).toBeVisible();
});
