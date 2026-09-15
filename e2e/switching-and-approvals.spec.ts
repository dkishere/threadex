import { expect, test } from "@playwright/test";
import {
  interruptTerminalStreams,
  requestApproval,
  resolveApproval,
  runnerUpdate,
  selectSession,
  startMockRunner
} from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

test("concurrent runners keep background and approval state while switch responses replace the selected snapshot", async ({
  page,
  request
}) => {
  const alpha = scenarioSessions.switchAlpha;
  const beta = scenarioSessions.switchBeta;
  const alphaTurnId = "e2e-turn-switch-alpha";
  const betaTurnId = "e2e-turn-switch-beta";
  const approvalId = "e2e-approval-switch-alpha";

  await startMockRunner(request, { sessionId: alpha.id, turnId: alphaTurnId, message: "Alpha mock runner prompt" });
  await startMockRunner(request, { sessionId: beta.id, turnId: betaTurnId, message: "Beta mock runner prompt" });
  await requestApproval(request, { approvalId, sessionId: alpha.id, turnId: alphaTurnId });
  await selectSession(request, alpha.id);
  await interruptTerminalStreams(page);

  const switchRequests: string[] = [];
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/api/sessions/switch") {
      switchRequests.push(browserRequest.postData() ?? "");
    }
  });

  try {
    await page.goto("/");
    await expect(page.locator(".content-header h1")).toHaveText(alpha.title);
    await expect(page.getByLabel("User prompts").getByText("Alpha mock runner prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Beta mock runner prompt", { exact: true })).toHaveCount(0);
    await expect(page.locator(".runtime-pill")).toHaveText("Working");
    await expect(page.getByRole("heading", { name: "Approval required" })).toBeVisible();

    const alphaRow = page.locator(".session-row", { hasText: alpha.title });
    const betaRow = page.locator(".session-row", { hasText: beta.title });
    await expect(alphaRow.locator(".session-status-indicator")).toHaveAttribute("data-status", "awaiting_approval");
    await expect(betaRow.locator(".session-status-indicator")).toHaveAttribute("data-status", "running");

    const betaSwitchResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/sessions/switch" && response.request().method() === "POST"
    );
    // The approval dialog intentionally remains open while a different session
    // is selected. Dispatch the row's React click handler through the DOM so
    // the persistent dialog does not absorb the pointer event.
    await betaRow.dispatchEvent("click");
    const betaSwitchPayload = await (await betaSwitchResponsePromise).json();
    expect(betaSwitchPayload.session.id).toBe(beta.id);
    expect(betaSwitchPayload.turns.every((turn: { sessionId: string }) => turn.sessionId === beta.id)).toBe(true);
    await expect(page.locator(".content-header h1")).toHaveText(beta.title);
    await expect(page.getByLabel("User prompts").getByText("Beta mock runner prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Alpha mock runner prompt", { exact: true })).toHaveCount(0);
    await expect(page.locator(".runtime-pill")).toHaveText("Working");
    await expect(page.getByRole("heading", { name: "Approval required" })).toBeVisible();
    await expect(page.locator(".session-row", { hasText: alpha.title }).locator(".session-status-indicator")).toHaveAttribute(
      "data-status",
      "awaiting_approval"
    );

    const alphaSwitchResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/sessions/switch" && response.request().method() === "POST"
    );
    await page.locator(".session-row", { hasText: alpha.title }).dispatchEvent("click");
    const alphaSwitchPayload = await (await alphaSwitchResponsePromise).json();
    expect(alphaSwitchPayload.session.id).toBe(alpha.id);
    expect(alphaSwitchPayload.turns.every((turn: { sessionId: string }) => turn.sessionId === alpha.id)).toBe(true);
    await expect(page.locator(".content-header h1")).toHaveText(alpha.title);
    await expect(page.getByLabel("User prompts").getByText("Alpha mock runner prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Beta mock runner prompt", { exact: true })).toHaveCount(0);

    const idle = scenarioSessions.result;
    const idleSwitchResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/sessions/switch" && response.request().method() === "POST"
    );
    await page.locator(".session-row", { hasText: idle.title }).dispatchEvent("click");
    const idleSwitchPayload = await (await idleSwitchResponsePromise).json();
    expect(idleSwitchPayload.session.id).toBe(idle.id);
    expect(idleSwitchPayload.turns.every((turn: { sessionId: string }) => turn.sessionId === idle.id)).toBe(true);
    await expect(page.locator(".content-header h1")).toHaveText(idle.title);
    await expect(page.getByText(`Snapshot response for ${idle.title}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Alpha mock runner prompt", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Beta mock runner prompt", { exact: true })).toHaveCount(0);
    await expect(page.locator(".runtime-pill")).toHaveText("2 background");
    await expect(page.getByRole("heading", { name: "Approval required" })).toBeVisible();
    await expect(page.locator(".session-row", { hasText: alpha.title }).locator(".session-status-indicator")).toHaveAttribute(
      "data-status",
      "awaiting_approval"
    );
    await expect(page.locator(".session-row", { hasText: beta.title }).locator(".session-status-indicator")).toHaveAttribute(
      "data-status",
      "running"
    );

    await page.waitForTimeout(1_600);
    expect(switchRequests.map((body) => JSON.parse(body).sessionId)).toEqual([beta.id, alpha.id, idle.id]);
  } finally {
    await resolveApproval(request, { approvalId, sessionId: alpha.id, turnId: alphaTurnId }).catch(() => undefined);
    await Promise.all([
      runnerUpdate(request, {
        id: `${alphaTurnId}:cleanup-result`,
        sessionId: alpha.id,
        turnId: alphaTurnId,
        event: "result",
        data: { reply: "Alpha mock runner cleaned up" }
      }),
      runnerUpdate(request, {
        id: `${betaTurnId}:cleanup-result`,
        sessionId: beta.id,
        turnId: betaTurnId,
        event: "result",
        data: { reply: "Beta mock runner cleaned up" }
      })
    ]);
  }
});

test("composer prompt queues are preserved and isolated across session switches", async ({ page, request }) => {
  const alpha = scenarioSessions.switchAlpha;
  const beta = scenarioSessions.switchBeta;
  const alphaTurnId = "e2e-turn-queue-switch-alpha";
  const betaTurnId = "e2e-turn-queue-switch-beta";

  await startMockRunner(request, { sessionId: alpha.id, turnId: alphaTurnId, message: "Alpha queue owner" });
  await startMockRunner(request, { sessionId: beta.id, turnId: betaTurnId, message: "Beta queue owner" });
  await selectSession(request, alpha.id);
  await interruptTerminalStreams(page);

  try {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Message" }).fill("Keep this prompt with alpha");
    await page.getByRole("button", { name: "Queue", exact: true }).last().click();
    await expect(page.locator(".queued-prompt")).toContainText("Keep this prompt with alpha");

    await page.locator(".session-row", { hasText: beta.title }).dispatchEvent("click");
    await expect(page.locator(".content-header h1")).toHaveText(beta.title);
    await expect(page.locator(".queued-prompt")).toHaveCount(0);

    await page.getByRole("textbox", { name: "Message" }).fill("Keep this prompt with beta");
    await page.getByRole("button", { name: "Queue", exact: true }).last().click();
    await expect(page.locator(".queued-prompt")).toContainText("Keep this prompt with beta");

    await page.locator(".session-row", { hasText: alpha.title }).dispatchEvent("click");
    await expect(page.locator(".content-header h1")).toHaveText(alpha.title);
    await expect(page.locator(".queued-prompt")).toHaveCount(1);
    await expect(page.locator(".queued-prompt")).toContainText("Keep this prompt with alpha");
    await expect(page.getByText("Keep this prompt with beta", { exact: true })).toHaveCount(0);
  } finally {
    await Promise.all([
      runnerUpdate(request, {
        id: `${alphaTurnId}:cleanup-result`,
        sessionId: alpha.id,
        turnId: alphaTurnId,
        event: "result",
        data: { reply: "Alpha queue runner cleaned up" }
      }),
      runnerUpdate(request, {
        id: `${betaTurnId}:cleanup-result`,
        sessionId: beta.id,
        turnId: betaTurnId,
        event: "result",
        data: { reply: "Beta queue runner cleaned up" }
      })
    ]);
  }
});
