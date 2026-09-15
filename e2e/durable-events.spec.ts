import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  appendMockRunnerSequence,
  interruptTerminalStreams,
  postJson,
  runnerUpdate,
  selectSession,
  startMockRunner
} from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

type TerminalCase = {
  session: { id: string; title: string };
  turnId: string;
  event: "result" | "pending" | "error" | "codex";
  data: unknown;
  expectedText: string;
  expectedTurnStatus?: "Todo";
};

async function openRunningSession(page: Page, request: APIRequestContext, terminalCase: TerminalCase) {
  await startMockRunner(request, {
    sessionId: terminalCase.session.id,
    turnId: terminalCase.turnId,
    message: `Running prompt for ${terminalCase.session.title}`
  });
  await selectSession(request, terminalCase.session.id);
  await interruptTerminalStreams(page);
  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(terminalCase.session.title);
  await expect(page.locator(".runtime-pill")).toHaveText("Working");
  await expect(page.locator(".turn-status").filter({ hasText: "Running" })).toHaveCount(1);
}

for (const terminalCase of [
  {
    session: scenarioSessions.result,
    turnId: "e2e-turn-result",
    event: "result",
    data: { reply: "Durable result reconciled", tokenIn: 12, tokenOut: 9 },
    expectedText: "Durable result reconciled"
  },
  {
    session: scenarioSessions.pending,
    turnId: "e2e-turn-pending",
    event: "pending",
    data: { message: "Saved for deterministic retry", queued: true },
    expectedText: "Saved for deterministic retry",
    expectedTurnStatus: "Todo"
  },
  {
    session: scenarioSessions.error,
    turnId: "e2e-turn-error",
    event: "error",
    data: { message: "mock runner failed after SSE interruption" },
    expectedText: "Codex error: mock runner failed after SSE interruption"
  },
  {
    session: scenarioSessions.codex,
    turnId: "e2e-turn-codex",
    event: "codex",
    data: { method: "turn/completed", params: { turn: { id: "codex-turn", status: "completed", error: null } } },
    expectedText: "Turn completed without a final agent message."
  }
] satisfies TerminalCase[]) {
  test(`durable ${terminalCase.event} reconciles without terminal SSE`, async ({ page, request }) => {
    await openRunningSession(page, request, terminalCase);
    await runnerUpdate(request, {
      id: `${terminalCase.turnId}:terminal`,
      sessionId: terminalCase.session.id,
      turnId: terminalCase.turnId,
      event: terminalCase.event,
      data: terminalCase.data
    });

    await expect(page.getByText(terminalCase.expectedText, { exact: true })).toBeVisible();
    await expect(page.locator(".runtime-pill")).toHaveText("Ready");
    await expect(page.locator(".turn-status").filter({ hasText: "Running" })).toHaveCount(0);
    if (terminalCase.expectedTurnStatus) {
      await expect(page.locator(".turn-status").filter({ hasText: terminalCase.expectedTurnStatus })).toHaveCount(1);
    }
  });
}

test("a selected session attaches to a runner started outside the chat composer", async ({ page, request }) => {
  const session = scenarioSessions.bootstrap;
  const turnId = "e2e-turn-external-wake";
  const prompt = "Externally queued wake prompt";
  const reply = "External wake reply streamed without reload";
  await selectSession(request, session.id);

  let streamAttempts = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/api/runner/stream") streamAttempts += 1;
  });

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  const { logPath } = await startMockRunner(request, { sessionId: session.id, turnId, message: prompt });

  await expect(page.getByLabel("User prompts").getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.locator(".runtime-pill")).toHaveText("Working");
  await expect.poll(() => streamAttempts).toBeGreaterThan(0);

  appendMockRunnerSequence({ logPath, sessionId: session.id, turnId, reply });

  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect(page.locator(".runtime-pill")).toHaveText("Ready");
});

test("a durable terminal event clears running state and advances a locally queued prompt", async ({ page, request }) => {
  const session = scenarioSessions.queue;
  const turnId = "e2e-turn-local-queue";
  await startMockRunner(request, { sessionId: session.id, turnId, message: "First running prompt" });
  await selectSession(request, session.id);
  await interruptTerminalStreams(page);

  let queuedChatBody: Record<string, unknown> | null = null;
  await page.route("**/api/chat", async (route) => {
    queuedChatBody = route.request().postDataJSON();
    const queuedTurnId = String(queuedChatBody?.turnId);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: session\ndata: ${JSON.stringify({ sessionId: session.id, turnId: queuedTurnId, message: "Mock queued runner" })}\n\n`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: session.id,
          turnId: queuedTurnId,
          threadId: `thread-${session.id}`,
          elapsedMs: 125,
          reply: "Queued prompt reached the runner boundary"
        })}\n\n`,
        "event: done\ndata: {\"ok\":true}\n\n"
      ].join("")
    });
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("Run after the durable completion");
  await page.getByRole("button", { name: "Queue", exact: true }).last().click();
  await expect(page.locator(".queued-prompt")).toContainText("Run after the durable completion");

  await runnerUpdate(request, {
    id: `${turnId}:result`,
    sessionId: session.id,
    turnId,
    event: "result",
    data: { reply: "First turn completed durably", tokenIn: 4, tokenOut: 6 }
  });

  await expect.poll(() => queuedChatBody?.message).toBe("Run after the durable completion");
  await expect(page.getByText("Queued prompt reached the runner boundary", { exact: true })).toBeVisible();
  await expect(page.locator(".queued-prompt")).toHaveCount(0);
});

test("a steer racing with turn completion stays queued in the selected session", async ({ page, request }) => {
  const session = scenarioSessions.queue;
  const turnId = "e2e-turn-stale-steer";
  await startMockRunner(request, { sessionId: session.id, turnId, message: "Runner finishing during steer" });
  await selectSession(request, session.id);
  await interruptTerminalStreams(page);
  await page.route("**/api/runner/steer", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Agent is not running." }) })
  );

  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this late steer in context");
  await page.getByRole("button", { name: "Queue", exact: true }).last().click();
  await page.getByRole("button", { name: "Steer next" }).click();

  await expect(page.getByText("Agent finished; steer queued as the next prompt.", { exact: true })).toBeVisible();
  await expect(page.locator('.queued-prompt[data-kind="steer"]')).toContainText("Keep this late steer in context");
});

test("reload restores the locally selected session when the active pointer was cleared", async ({ page, request }) => {
  const session = scenarioSessions.result;
  await selectSession(request, session.id);
  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("codex-session-manager.current-session"))).toContain(session.id);

  await postJson(request, "/api/sessions/switch", {});
  await page.reload();

  await expect(page.locator(".content-header h1")).toHaveText(session.title);
  await expect.poll(async () => {
    const snapshot = await request.get("http://127.0.0.1:8791/api/workspace/snapshot");
    return (await snapshot.json()).activeSessionId;
  }).toBe(session.id);
});
