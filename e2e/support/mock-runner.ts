import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const apiBaseUrl = "http://127.0.0.1:8791";
export const e2eDataDir = resolve(import.meta.dirname, "../../.e2e-data");

type RunnerUpdate = {
  id: string;
  sessionId: string;
  turnId: string;
  event: string;
  data?: unknown;
  runnerPid?: number;
  logPath?: string;
  jsonlIndex?: number;
};

export async function postJson(request: APIRequestContext, path: string, body: unknown) {
  const response = await request.post(`${apiBaseUrl}${path}`, { data: body });
  return checkedJson(response);
}

export async function checkedJson(response: APIResponse) {
  if (!response.ok()) {
    throw new Error(`${response.request().method()} ${response.url()} returned ${response.status()}: ${await response.text()}`);
  }
  return response.json();
}

export async function selectSession(request: APIRequestContext, sessionId: string) {
  return postJson(request, "/api/sessions/switch", { sessionId });
}

export function runnerLogPath(turnId: string) {
  return resolve(e2eDataDir, "runner-logs", `${turnId}.ndjson`);
}

export async function startMockRunner(
  request: APIRequestContext,
  input: { sessionId: string; turnId: string; message: string; logPath?: string }
) {
  const logPath = input.logPath ?? runnerLogPath(input.turnId);
  mkdirSync(resolve(e2eDataDir, "runner-logs"), { recursive: true });
  writeFileSync(logPath, "", "utf8");
  await postJson(request, "/api/pending-turns", {
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: input.message
  });
  await runnerUpdate(request, {
    id: `${input.turnId}:runner-started`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    event: "runner.started",
    runnerPid: process.pid,
    logPath,
    data: { pid: process.pid, logPath }
  });
  return { logPath };
}

export async function runnerUpdate(request: APIRequestContext, update: RunnerUpdate) {
  return postJson(request, "/api/runner/update", {
    ts: new Date().toISOString(),
    ...update
  });
}

export async function interruptTerminalStreams(page: Page) {
  await page.route("**/api/runner/stream", (route) => route.abort("connectionfailed"));
}

export function appendMockRunnerSequence(input: {
  logPath: string;
  sessionId: string;
  turnId: string;
  reply: string;
}) {
  const timestamp = new Date().toISOString();
  const entries = [
    {
      id: `${input.turnId}:log-session`,
      ts: timestamp,
      jsonlIndex: 0,
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: "session",
      data: {
        sessionId: input.sessionId,
        threadId: `thread-${input.sessionId}`,
        turnId: input.turnId,
        message: "Reconnected to mock prompt runner"
      }
    },
    {
      id: `${input.turnId}:log-codex-item`,
      ts: timestamp,
      jsonlIndex: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: "item",
      data: {
        id: `${input.turnId}:agent-message`,
        itemType: "agent_message",
        text: input.reply,
        eventType: "item.completed"
      }
    },
    {
      id: `${input.turnId}:log-result`,
      ts: timestamp,
      jsonlIndex: 2,
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: "result",
      data: {
        sessionId: input.sessionId,
        turnId: input.turnId,
        threadId: `thread-${input.sessionId}`,
        elapsedMs: 125,
        reply: input.reply,
        tokenIn: 31,
        tokenOut: 17
      }
    },
    {
      id: `${input.turnId}:log-done`,
      ts: timestamp,
      jsonlIndex: 3,
      sessionId: input.sessionId,
      turnId: input.turnId,
      event: "done",
      data: { ok: true }
    }
  ];
  appendFileSync(input.logPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export async function requestApproval(
  request: APIRequestContext,
  input: { approvalId: string; sessionId: string; turnId: string }
) {
  const approval = {
    ...input,
    requestId: 41,
    method: "item/commandExecution/requestApproval",
    params: {
      command: "npm run build",
      cwd: "/workspace",
      availableDecisions: ["accept", "decline"]
    }
  };
  await postJson(request, "/api/approvals/request", approval);
  await runnerUpdate(request, {
    id: `${input.approvalId}:requested`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    event: "approval.requested",
    data: approval
  });
}

export async function resolveApproval(
  request: APIRequestContext,
  input: { approvalId: string; sessionId: string; turnId: string }
) {
  await postJson(request, `/api/approvals/${encodeURIComponent(input.approvalId)}/decision`, { decision: "accept" });
  await runnerUpdate(request, {
    id: `${input.approvalId}:resolved`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    event: "approval.resolved",
    data: { ...input, decision: "accept" }
  });
}
