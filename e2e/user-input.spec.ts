import { expect, test } from "@playwright/test";
import { apiBaseUrl, postJson, runnerUpdate, selectSession, startMockRunner } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";

test("questions survive reload, validate answers, retry and submit without blocking the page", async ({ page, request }, testInfo) => {
  const sessionId = scenarioSessions.switchAlpha.id;
  const turnId = "e2e-user-input";
  const approvalId = "e2e-question";
  await startMockRunner(request, { sessionId, turnId, message: "Question UI test" });
  const question = { approvalId, sessionId, turnId, requestId: "question-501", method: "item/tool/requestUserInput", params: { isBlocking: false, questions: [
    { id: "scope", header: "Scope", question: "Which scope should I use?", isOther: true, options: [{ label: "UI (Recommended)", description: "Build the question card" }, { label: "Both", description: "Include runner support" }] },
    { id: "notes", header: "Notes", question: "Anything else?" }
  ] } };
  await postJson(request, "/api/approvals/request", question);
  await runnerUpdate(request, { id: "question-event", sessionId, turnId, event: "approval.requested", data: question });
  await selectSession(request, sessionId);
  await page.goto("/");
  const sessionRow = page.locator(".session-list-item", { hasText: scenarioSessions.switchAlpha.title });
  await sessionRow.hover();
  const card = page.getByRole("dialog", { name: "Session action requested" });
  await expect(card.getByText("Agent is continuing")).toBeVisible();
  await expect(page.getByRole("main").getByText("Your input", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Approval required" })).toHaveCount(0);
  await page.reload();
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
  await runnerUpdate(request, { id: "question-resolved", sessionId, turnId, event: "approval.resolved", data: { ...question, decision } });
  await expect(card).toHaveCount(0);
});
