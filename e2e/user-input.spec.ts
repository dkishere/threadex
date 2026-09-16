import { expect, test } from "@playwright/test";
import { apiBaseUrl, postJson, runnerUpdate, selectSession, startMockRunner } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";

for (const width of [1280, 600]) {
test(`questions survive reload, validate answers, retry and submit at ${width}px`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const security = await (await page.request.get("/api/security/status")).json();
  const login = await page.request.post(`/api/security/${security.configured ? "login" : "password"}`, { data: { password: "Threadex-e2e-questions-2026" } });
  expect(login.ok()).toBeTruthy();
  const sessionId = scenarioSessions.switchAlpha.id;
  const turnId = `e2e-user-input-${width}`;
  const approvalId = `e2e-question-${width}`;
  await startMockRunner(request, { sessionId, turnId, message: "Question UI test" });
  const question = { approvalId, sessionId, turnId, requestId: "question-501", method: "item/tool/requestUserInput", params: { isBlocking: false, questions: [
    { id: "scope", header: "Scope", question: "Which scope should I use?", isOther: true, options: [{ label: "UI (Recommended)", description: "Build the question card" }, { label: "Both", description: "Include runner support" }] },
    { id: "notes", header: "Notes", question: "Anything else?" }
  ] } };
  await postJson(request, "/api/approvals/request", question);
  await runnerUpdate(request, { id: `question-event-${width}`, sessionId, turnId, event: "approval.requested", data: question });
  await selectSession(request, scenarioSessions.switchBeta.id);
  await page.goto("/");
  if (width < 1080) await page.getByRole("button", { name: "Toggle sessions panel" }).click();
  const sessionRow = page.locator(".session-list-item", { hasText: scenarioSessions.switchAlpha.title });
  await sessionRow.hover();
  const card = page.getByRole("dialog", { name: "Session action requested" });
  await expect(card.getByText("Agent is continuing")).toBeVisible();
  const rowBounds = await sessionRow.boundingBox();
  const popoverBounds = await card.boundingBox();
  expect(rowBounds && popoverBounds && (popoverBounds.x >= rowBounds.x + rowBounds.width || popoverBounds.y >= rowBounds.y + rowBounds.height || popoverBounds.y + popoverBounds.height <= rowBounds.y)).toBeTruthy();
  await sessionRow.locator("button.session-row").click();
  await expect(sessionRow.locator("button.session-row")).toBeDisabled();
  const questionCards = page.locator(`.user-input-card[data-approval-id="${approvalId}"]`);
  await expect(questionCards).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Approval required" })).toHaveCount(0);
  await page.reload();
  if (width < 1080) await page.getByRole("button", { name: "Toggle sessions panel" }).click();
  await sessionRow.hover();
  await page.screenshot({ path: testInfo.outputPath("question-card.png") });
  await expect(card.getByRole("button", { name: "Send answers" })).toBeDisabled();
  await card.getByRole("radio", { name: "Write my own answer" }).check();
  await card.getByRole("textbox", { name: "Answer: Scope" }).fill("UI and keyboard navigation");
  await card.getByRole("textbox", { name: "Answer: Notes" }).fill("Keep the agent running");
  const path = `/api/approvals/${approvalId}/decision`;
  const invalid = await request.post(`${apiBaseUrl}${path}`, { data: { decision: "accept" } });
  expect(invalid.status()).toBe(400);
  await page.route(`**${path}`, (route) => route.fulfill({ status: 503, body: "unavailable" }), { times: 1 });
  await card.getByRole("button", { name: "Send answers" }).click();
  await expect(card.getByRole("alert")).toContainText("retry");
  const posted = page.waitForRequest((r) => r.url().endsWith(path) && r.method() === "POST");
  await card.getByRole("button", { name: "Send answers" }).click();
  const decision = (await posted).postDataJSON().decision;
  expect(decision).toEqual({ answers: { scope: { answers: ["UI and keyboard navigation"] }, notes: { answers: ["Keep the agent running"] } } });
  const waited = await postJson(request, `/api/approvals/${approvalId}/wait`, {});
  expect(waited.decision).toEqual(decision);
  await runnerUpdate(request, { id: `question-resolved-${width}`, sessionId, turnId, event: "approval.resolved", data: { ...question, decision } });
  await expect(card).toHaveCount(0);
  await expect(questionCards).toContainText("UI and keyboard navigation");
});
}
