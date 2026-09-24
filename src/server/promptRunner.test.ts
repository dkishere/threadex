import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CONTEXT_FORK_USER_SUFFIX } from "../contextFork";
import { WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS } from "./workspaceManagerRouting";
import {
  CONTINUE_TODO_PLAN_USER_SUFFIX,
  FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS,
  FORCE_TODO_PLAN_USER_SUFFIX
} from "./todoInstructions";

const projectRoot = resolve(import.meta.dirname, "../..");
const runnerPath = resolve(import.meta.dirname, "promptRunner.ts");

test("prompt runner serializes burst callbacks so terminal updates are not stranded", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-callback-burst-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const pendingLogPath = resolve(root, "pending.ndjson");
  const appServerExitMarkerPath = resolve(root, "app-server-exited");
  const receivedEvents: string[] = [];
  let appServerExitedBeforeTurnCompletedCallback = false;
  let appServerExitedBeforeResult = false;
  let callbackQueue = Promise.resolve();

  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST" || !body) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({}));
      return;
    }
    const update = JSON.parse(body);
    const current = callbackQueue.then(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      if (update.event === "codex" && update.data?.method === "turn/completed") {
        appServerExitedBeforeTurnCompletedCallback = existsSync(appServerExitMarkerPath);
      }
      if (update.event === "result") {
        appServerExitedBeforeResult = existsSync(appServerExitMarkerPath);
      }
      receivedEvents.push(update.event);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    callbackQueue = current.catch(() => undefined);
    await current;
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const close = () => {
  writeFileSync(process.env.APP_SERVER_EXIT_MARKER_PATH, "exited");
  process.exit(0);
};
process.on("SIGTERM", close);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    for (let index = 0; index < 50; index += 1) {
      send({ method: "item/agentMessage/delta", params: { itemId: "answer-1", delta: "x" } });
    }
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "complete" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
}).on("close", close);
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "test callback burst",
    serverUrl: `http://127.0.0.1:${address.port}`,
    logPath,
    pendingLogPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      APP_SERVER_EXIT_MARKER_PATH: appServerExitMarkerPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  assert.equal(exitCode, 0, stderr);
  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.some((entry) => entry.event === "runner.callback_error"), false);
  assert.equal(existsSync(pendingLogPath), false);
  assert.ok(receivedEvents.includes("result"));
  assert.equal(appServerExitedBeforeTurnCompletedCallback, true);
  assert.equal(appServerExitedBeforeResult, true);
  assert.equal(receivedEvents.at(-1), "done");
});

test("prompt runner uses attached source metadata before Browser Bridge", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-browser-context-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const contextPath = resolve(root, "browser-bridge-context.json");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(contextPath, JSON.stringify({
    kind: "browser-bridge-context",
    tabId: 42,
    url: "http://localhost:8082/assessment",
    selector: "button[aria-label='Set human attention score to 3']",
    "react-components": [{ name: "AttentionScoreControl", sourceRef: 0 }],
    "react-source-locations": [{
      fileName: "/workspace/src/AttentionScoreControl.tsx",
      lineNumber: 27,
      columnNumber: 9
    }],
    "extension-context-key": "codex-browser-bridge:context:42:test"
  }), "utf8");
  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "Refine the selected score indicator",
    attachments: [{
      id: "browser-context-1",
      name: "browser-bridge-context-42.json",
      mimeType: "application/json",
      size: readFileSync(contextPath).byteLength,
      path: contextPath
    }],
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  try {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_PATH: fakeCodexPath, CAPTURED_TURN_PATH: capturedTurnPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0, stderr);

    const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
    const prompt = turn.input[0].text;
    assert.match(prompt, /\[Browser Bridge context\]/);
    assert.match(prompt, /inspect that source directly before calling Browser Bridge/i);
    assert.match(prompt, /do not inspect the live tab merely to rediscover information already present/i);
    assert.doesNotMatch(prompt, /inspect the supplied tab.+before a broad source search/i);
    assert.match(prompt, /"tabId":42/);
    assert.match(prompt, /Set human attention score to 3/);
    assert.match(prompt, /AttentionScoreControl\.tsx/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("prompt runner waits for completion after a retryable app-server error", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-retryable-error-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({
      method: "error",
      params: {
        error: { message: "Reconnecting... 2/5" },
        willRetry: true,
        threadId: "thread-1",
        turnId: "app-turn-1"
      }
    });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "fork created" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "fork the latest turn",
    contextForkRequest: true,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_PATH: fakeCodexPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

  assert.equal(exitCode, 0, stderr);
  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.event === "codex" && entry.data?.method === "error"));
  assert.equal(entries.some((entry) => entry.event === "error"), false);
  assert.equal(entries.find((entry) => entry.event === "result")?.data?.reply, "fork created");
  assert.equal(entries.at(-1)?.event, "done");
});

test("prompt runner truncates a runaway command output stream without stopping the turn", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-command-output-limit-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const spawnShimPath = resolve(root, "spawn-shim.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");

  try {
    writeFileSync(spawnShimPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  return command === process.env.CODEX_PATH
    ? originalSpawn(process.execPath, [command, ...args], options)
    : originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/started", params: { item: { id: "command-1", type: "commandExecution", command: "rg recursive-log", status: "inProgress" } } });
    send({ method: "item/commandExecution/outputDelta", params: { itemId: "command-1", delta: "12345678" } });
    send({ method: "item/commandExecution/outputDelta", params: { itemId: "command-1", delta: "abcdefgh" } });
    send({ method: "item/commandExecution/outputDelta", params: { itemId: "command-1", delta: "discard-me" } });
    send({ method: "item/completed", params: { item: { id: "command-1", type: "commandExecution", command: "rg recursive-log", aggregatedOutput: "12345678abcd", exitCode: 0, status: "completed" } } });
    send({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: "finished after truncated output" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed", items: [{ id: "message-1", type: "agentMessage", text: "finished after truncated output" }] } } });
  }
});

`, "utf8");
    chmodSync(fakeCodexPath, 0o755);

    writeFileSync(jobPath, JSON.stringify({
      sessionId: "session-1",
      turnId: "turn-1",
      message: "test runaway command output",
      logPath,
      codexHome: resolve(root, "codex-home"),
      cwd: projectRoot
    }), "utf8");

    const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(spawnShimPath).href, runnerPath, jobPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        RUNNER_COMMAND_OUTPUT_CAPTURE_LIMIT_CHARS: "12"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

    assert.equal(exitCode, 0, `${stderr}\n${readFileSync(logPath, "utf8")}`);
    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.some((entry) => entry.event === "error"), false);
    const truncatedItem = entries.find((entry) =>
      entry.event === "item" &&
      entry.data?.itemType === "command_execution" &&
      entry.data?.outputTruncated === true &&
      /truncated further command output after 12 characters/i.test(entry.data?.aggregatedOutput ?? "")
    );
    assert.ok(truncatedItem);
    assert.equal(JSON.stringify(entries).includes("discard-me"), false);
    assert.equal(entries.find((entry) => entry.event === "result")?.data?.reply, "finished after truncated output");
    assert.equal(entries.at(-1)?.event, "done");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("prompt runner injects force-plan metadata into model input without changing the stored prompt", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-todo-language-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedArgsPath = resolve(root, "captured-args.json");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURED_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(process.env.CAPTURED_THREAD_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "完成" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "請建立 todo plan，todo language 要跟返用戶 prompt",
    forcePlan: true,
    developerInstructions: FORCE_TODO_PLAN_DEVELOPER_INSTRUCTIONS,
    executionMode: "default",
    approvalPolicy: "on-request",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_ARGS_PATH: capturedArgsPath,
      CAPTURED_THREAD_PATH: capturedThreadPath,
      CAPTURED_TURN_PATH: capturedTurnPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  const args = JSON.parse(readFileSync(capturedArgsPath, "utf8"));
  assert.ok(args.includes("app-server"));
  assert.ok(args.includes(`mcp_servers.session_inspector.command=${JSON.stringify(process.execPath)}`));
  assert.ok(args.includes(`mcp_servers.session_inspector.args=[${JSON.stringify(resolve(projectRoot, "node_modules/tsx/dist/cli.mjs"))}, ${JSON.stringify(resolve(projectRoot, "src/server/sessionInspectorMcp.ts"))}]`));
  assert.ok(args.includes("mcp_servers.session_inspector.tools.todo_set_plan.approval_mode=\"approve\""));
  assert.ok(args.includes("mcp_servers.session_inspector.tools.todo_request_clarification.approval_mode=\"approve\""));
  assert.ok(args.includes("mcp_servers.session_inspector.env.TMPDIR=\"/private/tmp\""));
  assert.ok(args.includes("mcp_servers.session_inspector.env.THREADEX_TODO_AGENT_ROLE=\"planner\""));
  assert.match(thread.developerInstructions, /commentary and progress updates as plain natural-language prose only/i);
  assert.match(thread.developerInstructions, /Never wrap commentary in JSON/i);
  assert.match(thread.developerInstructions, /Threadex session ownership/i);
  assert.match(thread.developerInstructions, /Context Fork\/New task is explicit delegation/i);
  assert.match(thread.developerInstructions, /A parent remains an active working session after creating a fork/);
  assert.match(thread.developerInstructions, /Execute subsequent user requests in the receiving parent session/);
  assert.match(thread.developerInstructions, /that dependency alone does not authorize delegation/);
  assert.match(thread.developerInstructions, /Context preservation/i);
  assert.match(thread.developerInstructions, /substantive final response remains important/i);
  assert.match(thread.developerInstructions, /never run recursive file or text searches from a filesystem root, workspace root, or broad parent directory/i);
  assert.match(thread.developerInstructions, /Never broadly search Threadex runtime data/i);
  assert.match(thread.developerInstructions, /Code-file edit tracking/i);
  assert.match(thread.developerInstructions, /explicit prior permission for the specific alternative method and file scope/i);
  assert.match(thread.developerInstructions, /never silently fall back/i);
  assert.equal(thread.approvalPolicy, "never");
  assert.equal(thread.approvalsReviewer, "user");
  assert.equal(
    thread.config.mcp_servers.session_inspector.tools.todo_set_plan.approval_mode,
    "approve"
  );
  assert.equal(
    thread.config.mcp_servers.session_inspector.tools.todo_request_clarification.approval_mode,
    "approve"
  );
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  assert.equal(turn.input[0].type, "text");
  assert.equal(
    turn.input[0].text,
    `請建立 todo plan，todo language 要跟返用戶 prompt\n\n${FORCE_TODO_PLAN_USER_SUFFIX}`
  );
  assert.match(turn.input[0].text, /Required for this turn: conduct one focused grill-me round/);
  assert.match(turn.input[0].text, /Do not use `update_plan`/);
  assert.match(turn.input[0].text, /operational metadata/);
  assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).message, "請建立 todo plan，todo language 要跟返用戶 prompt");
  assert.match(turn.settings.developer_instructions, /original user's actual task request/);
  assert.doesNotMatch(turn.settings.developer_instructions, /compact status headline/);
  assert.match(turn.settings.developer_instructions, /appended English force-plan suffix/);
  assert.match(turn.settings.developer_instructions, /mcp__session_inspector__todo_request_clarification/);
  assert.match(turn.settings.developer_instructions, /todo_set_plan plans/);
  assert.match(turn.settings.developer_instructions, /item title\/details/);
  assert.match(turn.settings.developer_instructions, /activeStatus/);
  assert.match(turn.settings.developer_instructions, /todo_add_message/);
  assert.match(turn.settings.developer_instructions, /todo_add_comment status\/blocker\/note bodies/);
  assert.match(turn.settings.developer_instructions, /nested split items/);
  assert.match(turn.settings.developer_instructions, /todo_create_task/);
  assert.match(turn.settings.developer_instructions, /TODO MCP PLAN COMPLETION AND MUTATION GATE/);
  assert.equal(
    turn.settings.developer_instructions.match(/\[TODO MCP PLAN COMPLETION AND MUTATION GATE/g)?.length,
    1
  );
  assert.match(turn.settings.developer_instructions, /MUST conduct exactly one focused grill-me round/);
  assert.match(turn.settings.developer_instructions, /chronological, not a final-state check/);
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(turn.approvalPolicy, "never");
});

test("prompt runner enables current-session recovery for an ordinary resumed thread", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-resume-recovery-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedArgsPath = resolve(root, "captured-args.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURED_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/resume") send({ id: request.id, result: { thread: { id: request.params.threadId } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({
    sessionId: "local_session-1",
    turnId: "turn-1",
    threadId: "thread-1",
    message: "what about that earlier result?",
    serverUrl: "http://127.0.0.1:8787",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_ARGS_PATH: capturedArgsPath,
      CAPTURED_TURN_PATH: capturedTurnPath,
      SESSION_INSPECTOR_MCP_MODE: "auto"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  assert.equal(exitCode, 0, stderr);

  const args = JSON.parse(readFileSync(capturedArgsPath, "utf8")) as string[];
  assert.ok(args.some((arg) => arg.includes("mcp_servers.session_inspector.command")));
  assert.ok(args.includes('mcp_servers.session_inspector.env.THREADEX_CONTINUITY_ONLY="1"'));
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  assert.match(turn.settings.developer_instructions, /call recover_current_session/i);
  assert.match(turn.settings.developer_instructions, /complete user prompts and final assistant responses/i);
  assert.doesNotMatch(turn.settings.developer_instructions, /For Todo MCP planning/);
  assert.doesNotMatch(turn.settings.developer_instructions, /Use list_processes/);
});

test("prompt runner treats force-plan requests as existing-plan follow-ups when todo items already exist", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-todo-existing-plan-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedArgsPath = resolve(root, "captured-args.json");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");
  const controlPosts: Array<Record<string, unknown>> = [];

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURED_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(process.env.CAPTURED_THREAD_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "Existing plan paused" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/sessions/session-1/todos") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        items: [{ id: "todo-1", title: "Existing plan item" }],
        control: { paused: false, pauseReason: null, pausedBy: null }
      }));
      return;
    }
    const requestChunks: Buffer[] = [];
    for await (const chunk of request) {
      // Consume callback bodies so the runner can reuse the connection.
      requestChunks.push(Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(requestChunks).toString("utf8");
    if (request.method === "POST" && request.url === "/api/sessions/session-1/todos/control") {
      controlPosts.push(JSON.parse(bodyText) as Record<string, unknown>);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        items: [{ id: "todo-1", title: "Existing plan item" }],
        control: { paused: true, pauseReason: "Initial Todo MCP plan created for review. Execution has not started.", pausedBy: "agent" }
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "跟進 Todo MCP plan",
    forcePlan: true,
    executionMode: "default",
    approvalPolicy: "on-request",
    serverUrl: `http://127.0.0.1:${address.port}`,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  let stderr = "";
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_ARGS_PATH: capturedArgsPath,
      CAPTURED_THREAD_PATH: capturedThreadPath,
      CAPTURED_TURN_PATH: capturedTurnPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
    });
  } finally {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  const args = JSON.parse(readFileSync(capturedArgsPath, "utf8"));
  assert.ok(args.includes("mcp_servers.session_inspector.env.THREADEX_TODO_AGENT_ROLE=\"default\""));
  assert.equal(args.some((arg: string) => arg.includes("tools.todo_set_plan.approval_mode")), false);
  assert.deepEqual(controlPosts, [{
    paused: true,
    pauseReason: "Initial Todo MCP plan created for review. Execution has not started.",
    actor: "agent"
  }]);

  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  assert.equal(thread.approvalPolicy, "never");
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  assert.equal(turn.input[0].text, "跟進 Todo MCP plan");
  assert.match(turn.settings.developer_instructions, /Todo MCP plan already exists/);
  assert.match(turn.settings.developer_instructions, /Do not call todo_set_plan/);
  assert.doesNotMatch(turn.settings.developer_instructions, /TODO MCP PLAN COMPLETION AND MUTATION GATE/);
  assert.doesNotMatch(turn.settings.developer_instructions, /first task-related action MUST/);
});

test("prompt runner retries then rejects force-plan turns that omit the initial grill-me call", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-todo-gate-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const turnStartsPath = resolve(root, "turn-starts.txt");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turnNumber = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    turnNumber += 1;
    appendFileSync(process.env.TURN_STARTS_PATH, JSON.stringify(request.params.input[0].text) + "\\n");
    const turnId = "app-turn-" + turnNumber;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({ method: "item/completed", params: { item: { id: "answer-" + turnNumber, type: "agentMessage", text: "No MCP plan" } } });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume callback bodies so the runner can reuse the connection.
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(request.method === "GET" ? JSON.stringify({ items: [] }) : JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "建立 Todo MCP plan",
    forcePlan: true,
    executionMode: "default",
    approvalPolicy: "on-request",
    serverUrl: `http://127.0.0.1:${address.port}`,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_PATH: fakeCodexPath, TURN_STARTS_PATH: turnStartsPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  assert.equal(exitCode, 1, stderr);
  const turnInputs = readFileSync(turnStartsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(turnInputs.length, 2);
  assert.equal(turnInputs[0], `建立 Todo MCP plan\n\n${FORCE_TODO_PLAN_USER_SUFFIX}`);
  assert.match(turnInputs[1], /^The required initial Todo MCP grill-me round is still missing for this turn\./);
  assert.equal(turnInputs[1].includes(FORCE_TODO_PLAN_USER_SUFFIX), false);
  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.some((entry) => entry.event === "result"), false);
  assert.equal(entries.some((entry) => entry.event === "error" && /without recording the required initial grill-me clarification successfully/.test(entry.data?.message)), true);
});

test("prompt runner turns grill-me answers into a Todo MCP plan", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-todo-gate-created-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const turnStartsPath = resolve(root, "turn-starts.txt");
  let todoFetches = 0;
  const controlPosts: Array<Record<string, unknown>> = [];

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    appendFileSync(process.env.TURN_STARTS_PATH, JSON.stringify(request.params.input[0].text) + "\\n");
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "Plan created" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  const server = createServer(async (request, response) => {
    const requestChunks: Buffer[] = [];
    for await (const chunk of request) {
      // Consume callback bodies so the runner can reuse the connection.
      requestChunks.push(Buffer.from(chunk));
    }
    const bodyText = Buffer.concat(requestChunks).toString("utf8");
    if (request.method === "GET" && request.url === "/api/sessions/session-1/todos") {
      todoFetches += 1;
      const items = todoFetches === 1 ? [] : [{ id: "todo-1", title: "Created plan item" }];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        items,
        control: todoFetches === 1
          ? {
              paused: true,
              pauseReason: "Todo MCP plan needs clarification before it can be created.",
              pausedBy: "agent",
              context: JSON.stringify({ clarificationQuestions: ["Which outcome matters most?"] }),
              updated: "2026-08-17T10:00:00.000Z"
            }
          : { paused: false, pauseReason: null, pausedBy: null, updated: "2026-08-17T10:01:00.000Z" }
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/sessions/session-1/todos/control") {
      controlPosts.push(JSON.parse(bodyText) as Record<string, unknown>);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        items: [{ id: "todo-1", title: "Created plan item" }],
        control: { paused: true, pauseReason: "Initial Todo MCP plan created for review. Execution has not started.", pausedBy: "agent" }
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "建立 Todo MCP plan",
    forcePlan: true,
    todoPlanClarificationPending: true,
    executionMode: "default",
    approvalPolicy: "on-request",
    serverUrl: `http://127.0.0.1:${address.port}`,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_PATH: fakeCodexPath, TURN_STARTS_PATH: turnStartsPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  assert.equal(exitCode, 0, stderr);
  const turnInputs = readFileSync(turnStartsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(turnInputs.length, 1);
  assert.equal(turnInputs[0], `建立 Todo MCP plan\n\n${CONTINUE_TODO_PLAN_USER_SUFFIX}`);
  assert.deepEqual(controlPosts, [{
    paused: true,
    pauseReason: "Initial Todo MCP plan created for review. Execution has not started.",
    actor: "agent"
  }]);
  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.some((entry) => entry.event === "error"), false);
  assert.equal(entries.some((entry) => entry.event === "result"), true);
  assert.equal(entries.some((entry) => entry.event === "todo.force_plan_paused"), true);
});

test("prompt runner clarifies context-fork create_task MCP tool name", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-context-fork-tool-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(process.env.CAPTURED_THREAD_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "created" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "開 child task",
    contextForkRequest: true,
    approvalPolicy: "on-request",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const forkSpawnShimPath = resolve(root, "fork-spawn-shim.mjs");
  writeFileSync(forkSpawnShimPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  return command === process.env.CODEX_PATH
    ? originalSpawn(process.execPath, [command, ...args], options)
    : originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(forkSpawnShimPath).href, runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_THREAD_PATH: capturedThreadPath,
      CAPTURED_TURN_PATH: capturedTurnPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  assert.equal(thread.config.mcp_servers.session_inspector.tools.create_task.approval_mode, "approve");
  assert.match(thread.developerInstructions, /Never wrap commentary in JSON/i);
  assert.match(thread.developerInstructions, /Context Fork\/New task is explicit delegation/i);
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  assert.equal(turn.input[0].text, `開 child task\n\n${CONTEXT_FORK_USER_SUFFIX}`);
  assert.match(turn.settings.developer_instructions, /mcp__session_inspector__create_task/);
  assert.doesNotMatch(turn.settings.developer_instructions, /mcp__session_inspectorcreate_task/);
  assert.doesNotMatch(turn.settings.developer_instructions, /Use get_session with sessionId or threadId/);
  assert.doesNotMatch(turn.settings.developer_instructions, /For Todo MCP planning/);
  assert.doesNotMatch(turn.settings.developer_instructions, /Use list_processes for a compact view/);
  assert.equal(turn.sandboxPolicy.type, thread.sandbox === "workspace-write" ? "workspaceWrite" : thread.sandbox === "danger-full-access" ? "dangerFullAccess" : "readOnly");
  assert.equal(turn.approvalPolicy, thread.approvalPolicy);
});

test("prompt runner retries an ignored context fork and verifies that a child session was created", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-context-fork-gate-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const turnStartsPath = resolve(root, "turn-starts.ndjson");
  let childFetchCount = 0;

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/sessions/session-1/children") {
      childFetchCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        sessionId: "session-1",
        children: childFetchCount >= 3 ? [{ id: "local_child-1" }] : []
      }));
      return;
    }
    for await (const _chunk of request) {
      // Drain runner callback bodies before acknowledging them.
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
let turnCount = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    turnCount += 1;
    appendFileSync(process.env.TURN_STARTS_PATH, JSON.stringify(request.params.input[0].text) + "\\n");
    const turnId = "app-turn-" + turnCount;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({ method: "item/completed", params: { item: { id: "answer-" + turnCount, type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "開 child task",
    contextForkRequest: true,
    serverUrl: `http://127.0.0.1:${address.port}`,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_PATH: fakeCodexPath, TURN_STARTS_PATH: turnStartsPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  assert.equal(exitCode, 0, stderr);
  assert.equal(childFetchCount, 3);
  const turnInputs = readFileSync(turnStartsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(turnInputs.length, 2);
  assert.equal(turnInputs[0], `開 child task\n\n${CONTEXT_FORK_USER_SUFFIX}`);
  assert.match(turnInputs[1], /required Threadex child task is still missing/i);
  assert.match(turnInputs[1], /mcp__session_inspector__create_task exactly once/);
  assert.match(turnInputs[1], /Do not call spawn_agent/);
  assert.ok(turnInputs[1].includes(CONTEXT_FORK_USER_SUFFIX));
  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries.some((entry) => entry.event === "error"), false);
  assert.equal(entries.some((entry) => entry.event === "result"), true);
  assert.deepEqual(
    entries.find((entry) => entry.event === "context_fork.child_created")?.data?.childSessionIds,
    ["local_child-1"]
  );
});

for (const duringStartup of [false, true]) {
test(`prompt runner forwards control messages to Codex turn/steer${duringStartup ? " during startup" : ""}`, async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-steer-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const controlPath = resolve(root, "controls.ndjson");
  const controlResultDir = resolve(root, "results");
  const capturedSteerPath = resolve(root, "captured-steer.json");
  const capturedArgsPath = resolve(root, "captured-args.json");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");
  const capturedGoalPath = resolve(root, "captured-goal.json");
  const commandId = "steer-command-1";
  let releaseSteerCallback!: () => void;
  let releaseCompletionCallback!: () => void;
  const steerCallbackGate = new Promise<void>((resolveGate) => { releaseSteerCallback = resolveGate; });
  const completionCallbackGate = new Promise<void>((resolveGate) => { releaseCompletionCallback = resolveGate; });
  let completionCallbackWaiting = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const update = body ? JSON.parse(body) : {};
    if (update.event === "developer_instructions" && update.data?.target === "steer") await steerCallbackGate;
    if (update.event === "codex" && update.data?.method === "turn/completed") {
      completionCallbackWaiting = true;
      await completionCallbackGate;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(() => {
    releaseSteerCallback();
    releaseCompletionCallback();
    server.closeAllConnections();
    server.close();
  });
  const controlMessage = `${JSON.stringify({
    id: commandId,
    message: "focus on the server path",
    developerInstructions: "Force plan steps for this steer.",
    attachments: []
  })}\n`;
  if (duringStartup) appendFileSync(controlPath, controlMessage);
  const spawnShimPath = resolve(root, "spawn-shim.mjs");
  writeFileSync(spawnShimPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  return command === process.env.CODEX_PATH
    ? originalSpawn(process.execPath, [command, ...args], options)
    : originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const capturedPath = process.env.CAPTURED_STEER_PATH;
const capturedArgsPath = process.env.CAPTURED_ARGS_PATH;
const capturedThreadPath = process.env.CAPTURED_THREAD_PATH;
const capturedTurnPath = process.env.CAPTURED_TURN_PATH;
const capturedGoalPath = process.env.CAPTURED_GOAL_PATH;
writeFileSync(capturedArgsPath, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(capturedThreadPath, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/set") {
    writeFileSync(capturedGoalPath, JSON.stringify(request.params));
    send({ id: request.id, result: { goal: request.params } });
  }
  if (request.method === "turn/start") {
    writeFileSync(capturedTurnPath, JSON.stringify(request.params));
    setTimeout(() => send({ id: request.id, result: { turn: { id: "app-turn-1" } } }), ${duringStartup ? 400 : 0});
  }
  if (request.method === "turn/steer") {
    writeFileSync(capturedPath, JSON.stringify(request.params));
    send({ id: request.id, result: { turnId: "app-turn-1" } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "initial prompt",
    startupSnapshot: "[STARTUP]\npwd: /tmp/workspace\n[END STARTUP]",
    contextParentSessionId: "local_parent-1",
    executionMode: "goal",
    serverUrl: `http://127.0.0.1:${address.port}`,
    approvalPolicy: "granular",
    skills: [{ name: "test-skill", path: "/skills/test-skill/SKILL.md" }],
    logPath,
    controlPath,
    controlResultDir,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(spawnShimPath).href, runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_STEER_PATH: capturedSteerPath,
      CAPTURED_ARGS_PATH: capturedArgsPath,
      CAPTURED_THREAD_PATH: capturedThreadPath,
      CAPTURED_TURN_PATH: capturedTurnPath,
      CAPTURED_GOAL_PATH: capturedGoalPath,
      SESSION_INSPECTOR_MCP_MODE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  await waitFor(
    () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("Codex session ready"),
    5_000,
    () => stderr
  );
  if (!duringStartup) appendFileSync(controlPath, controlMessage);

  const resultPath = resolve(controlResultDir, `${commandId}.json`);
  await waitFor(() => existsSync(resultPath));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.deepEqual(result, {
    ok: true,
    commandId,
    turnId: "turn-1",
    appTurnId: "app-turn-1"
  });

  // A held developer-instructions callback must not block delivery or its ack.
  releaseSteerCallback();
  await waitFor(() => completionCallbackWaiting);
  const lateCommandId = "steer-after-completion";
  appendFileSync(controlPath, `${JSON.stringify({ id: lateCommandId, message: "late correction" })}\n`);
  const lateResultPath = resolve(controlResultDir, `${lateCommandId}.json`);
  await waitFor(() => existsSync(lateResultPath));
  const lateResult = JSON.parse(readFileSync(lateResultPath, "utf8"));
  assert.equal(lateResult.ok, false);
  assert.match(lateResult.error, /already finished/);
  // This reply must arrive while completion persistence is still blocked.
  const exit = new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });
  releaseCompletionCallback();

  await exit;

  const steer = JSON.parse(readFileSync(capturedSteerPath, "utf8"));
  assert.equal(steer.threadId, "thread-1");
  assert.equal(steer.expectedTurnId, "app-turn-1");
  assert.deepEqual(steer.input, [{ type: "text", text: "focus on the server path", text_elements: [] }]);
  assert.equal(steer.settings.developer_instructions, "Force plan steps for this steer.");

  const goal = JSON.parse(readFileSync(capturedGoalPath, "utf8"));
  assert.deepEqual(goal, { threadId: "thread-1", objective: "initial prompt", status: "active" });
  const args = JSON.parse(readFileSync(capturedArgsPath, "utf8"));
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.ok(!args.includes('approval_policy="granular"'));
  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.approvalsReviewer, "auto_review");
  assert.match(thread.developerInstructions, /Never wrap commentary in JSON/i);
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  assert.equal(turn.approvalPolicy, "on-request");
  assert.match(turn.settings.developer_instructions, /\[STARTUP\]/);
  assert.match(turn.settings.developer_instructions, /parent Threadex session local_parent-1/);
  assert.deepEqual(turn.input, [
    {
      type: "text",
      text: "initial prompt",
      text_elements: []
    },
    { type: "skill", name: "test-skill", path: "/skills/test-skill/SKILL.md" }
  ]);
  const logText = readFileSync(logPath, "utf8");
  const developerEvents = logText.trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "developer_instructions");
  assert.equal(developerEvents.filter((entry) => entry.data.target === "turn").length, 1);
  assert.equal(developerEvents.filter((entry) => entry.data.target === "steer").length, 1);
  assert.match(logText, /\[STARTUP\]/);
});
}

test("goal mode writes overlong objectives to temp file context", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-long-goal-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedGoalPath = resolve(root, "captured-goal.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");
  const longGoal = [
    "Long child handoff goal.",
    "x".repeat(4200),
    "Verify the final result."
  ].join("\n");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/set") {
    writeFileSync(process.env.CAPTURED_GOAL_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { goal: request.params } });
  }
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "done" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: longGoal,
    executionMode: "goal",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_GOAL_PATH: capturedGoalPath,
      CAPTURED_TURN_PATH: capturedTurnPath,
      SESSION_INSPECTOR_MCP_MODE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const goal = JSON.parse(readFileSync(capturedGoalPath, "utf8"));
  assert.equal(goal.threadId, "thread-1");
  assert.equal(goal.status, "active");
  assert.match(goal.objective, /full goal objective is \d+ characters and was written to /);
  assert.doesNotMatch(goal.objective, /x{100}/);

  const goalFilePath = goal.objective
    .split("\n")[0]
    .replace(/^The full goal objective is \d+ characters and was written to /, "")
    .replace(/\.$/, "");
  assert.ok(existsSync(goalFilePath));
  assert.match(readFileSync(goalFilePath, "utf8"), /x{100}/);

  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  const text = turn.input[0].text;
  assert.doesNotMatch(text, /\[SERVER-PROVIDED LONG GOAL OBJECTIVE\]/);
  assert.match(text, new RegExp(goalFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /x{100}/);
  assert.match(turn.settings.developer_instructions, /\[SERVER-PROVIDED LONG GOAL OBJECTIVE\]/);
  assert.match(turn.settings.developer_instructions, new RegExp(goalFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(turn.settings.developer_instructions, /x{100}/);
});

test("auto model continues the same request in a stronger second phase", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-auto-model-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedTurnsPath = resolve(root, "captured-turns.ndjson");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const mockFetchPath = resolve(root, "mock-fetch.mjs");
  const serverUrl = "http://threadex.test";
  writeFileSync(mockFetchPath, `
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if ((init.method ?? "GET") === "GET" && url.endsWith("/api/session-auto-model/session-1")) {
    return new Response(JSON.stringify({
      sessionId: "session-1",
      enabled: true,
      model: "gpt-5.6-sol",
      effort: "xhigh",
      revision: 1,
      updated: new Date().toISOString()
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
};
`, "utf8");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    writeFileSync(process.env.CAPTURED_THREAD_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    turn += 1;
    appendFileSync(process.env.CAPTURED_TURNS_PATH, JSON.stringify(request.params) + "\\n");
    send({ id: request.id, result: { turn: { id: "app-turn-" + turn } } });
    send({ method: "item/completed", params: { item: { id: "answer-" + turn, type: "agentMessage", text: "phase " + turn } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-" + turn, status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "make the architecture decision",
    model: "gpt-5.6-luna",
    modelReasoningEffort: "high",
    autoModelEnabled: true,
    autoModelRevision: 0,
    autoModelPromptFullVersion: true,
    serverUrl,
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", mockFetchPath, "--import", "tsx", runnerPath, jobPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        CAPTURED_THREAD_PATH: capturedThreadPath,
        CAPTURED_TURNS_PATH: capturedTurnsPath,
        SESSION_INSPECTOR_MCP_MODE: "off"
      },
      stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const turns = readFileSync(capturedTurnsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  assert.equal(
    thread.config.mcp_servers.session_inspector.tools.upgrade_model.approval_mode,
    "approve"
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].model, "gpt-5.6-luna");
  assert.equal(turns[0].effort, "high");
  assert.equal(turns[0].input[0].text, "make the architecture decision");
  assert.match(turns[0].settings.developer_instructions, /\[AUTO MODEL\]/);
  assert.match(turns[0].settings.developer_instructions, /Available upgrades are gpt-5\.6-luna/);
  assert.match(turns[0].settings.developer_instructions, /session_inspector\.upgrade_model/);
  assert.equal(turns[1].model, "gpt-5.6-sol");
  assert.equal(turns[1].effort, "xhigh");
  assert.equal(turns[1].input[0].text, "make the architecture decision");
  assert.match(turns[1].settings.developer_instructions, /AUTO MODEL CONTINUATION/);
  assert.match(turns[1].settings.developer_instructions, /Current setting: gpt-5\.6-sol \/ xhigh/);
  assert.doesNotMatch(turns[1].settings.developer_instructions, /Available upgrades are gpt-5\.6-luna/);
  assert.match(readFileSync(logPath, "utf8"), /auto_model\.phase_transition/);
});

test("runner callbacks persist file changes before the terminal result", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-callback-order-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const mockFetchPath = resolve(root, "mock-fetch.mjs");
  const callbackLogPath = resolve(root, "callbacks.ndjson");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");

  writeFileSync(mockFetchPath, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (_input, init = {}) => {
  const entry = JSON.parse(String(init.body));
  if (entry.event === "item") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  appendFileSync(process.env.CALLBACK_LOG_PATH, JSON.stringify({
    jsonlIndex: entry.jsonlIndex,
    event: entry.event,
    itemType: entry.data?.itemType,
    authoritative: entry.data?.authoritative,
    changedPaths: entry.data?.changes?.map((change) => change.path),
    method: entry.data?.method
  }) + "\\n");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
`, "utf8");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: {
      id: "change-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "src/client/App.tsx", kind: "update" }]
    } } });
    send({ method: "item/completed", params: { item: {
      id: "answer-1",
      type: "agentMessage",
      text: "done"
    } } });
    send({ method: "turn/diff/updated", params: {
      threadId: "thread-1",
      turnId: "app-turn-1",
      diff: [
        "diff --git a/src/net-a.ts b/src/net-a.ts",
        "--- a/src/net-a.ts",
        "+++ b/src/net-a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/net-b.ts b/src/net-b.ts",
        "--- a/src/net-b.ts",
        "+++ b/src/net-b.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new"
      ].join("\\n")
    } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "app-turn-1", item: {
      id: "failed-edit", type: "fileChange", status: "failed",
      changes: [{ path: "denied.ts", kind: "update" }]
    } } });
    send({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "app-turn-1", diff: "" } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "edit the client",
    executionMode: "default",
    serverUrl: "http://threadex.test",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", mockFetchPath, "--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CALLBACK_LOG_PATH: callbackLogPath,
      SESSION_INSPECTOR_MCP_MODE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const callbacks = readFileSync(callbackLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const fileChangeIndex = callbacks.findIndex((callback) => callback.event === "item" && callback.itemType === "file_change");
  const authoritativeIndex = callbacks.findIndex((callback) => callback.event === "item" && callback.authoritative === true);
  const turnCompletedIndex = callbacks.findIndex(
    (callback) => callback.event === "codex" && callback.method === "turn/completed"
  );
  const resultIndex = callbacks.findIndex((callback) => callback.event === "result");
  assert.ok(fileChangeIndex >= 0);
  assert.ok(authoritativeIndex > fileChangeIndex);
  assert.deepEqual(callbacks[authoritativeIndex].changedPaths, ["src/net-a.ts", "src/net-b.ts"]);
  assert.equal(callbacks.filter((callback) => callback.authoritative === true).length, 1);
  assert.ok(turnCompletedIndex > fileChangeIndex);
  assert.ok(turnCompletedIndex > authoritativeIndex);
  assert.ok(resultIndex > fileChangeIndex);
});

test("prompt runner attributes multiplexed child items without mutating root turn state", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-child-attribution-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    send({ id: request.id, result: { thread: { id: "root-thread" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "root-turn" } } });
    send({ method: "turn/started", params: {
      threadId: "root-thread",
      turn: { id: "root-turn", status: "inProgress", items: [] }
    } });
    send({ method: "thread/started", params: {
      thread: { id: "child-thread", parentThreadId: "root-thread" }
    } });
    send({ method: "turn/started", params: {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "inProgress", items: [] }
    } });
    send({ method: "item/started", params: {
      threadId: "child-thread",
      turnId: "child-turn",
      item: { id: "shared-item", type: "agentMessage", text: "child:" }
    } });
    send({ method: "item/started", params: {
      threadId: "root-thread",
      turnId: "root-turn",
      item: { id: "shared-item", type: "agentMessage", text: "root:" }
    } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "child-thread", turnId: "child-turn", itemId: "shared-item", delta: "delta"
    } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: "root-thread", turnId: "root-turn", itemId: "shared-item", delta: "delta"
    } });
    send({ method: "item/completed", params: {
      threadId: "child-thread",
      turnId: "child-turn",
      item: { id: "child-answer", type: "agentMessage", text: "child final" }
    } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId: "child-thread", turnId: "child-turn",
      tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } }
    } });
    send({ method: "error", params: {
      threadId: "child-thread", turnId: "child-turn", willRetry: false,
      error: { message: "child-only failure" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "completed", items: [
        { id: "child-answer", type: "agentMessage", text: "child final" }
      ] }
    } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId: "root-thread", turnId: "root-turn",
      tokenUsage: { last: { inputTokens: 12, outputTokens: 4 } }
    } });
    send({ method: "item/completed", params: {
      threadId: "root-thread",
      turnId: "root-turn",
      item: { id: "root-answer", type: "agentMessage", text: "root final" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "root-thread",
      turn: { id: "root-turn", status: "completed", items: [
        { id: "root-answer", type: "agentMessage", text: "root final" }
      ] }
    } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "manager-turn",
    message: "delegate some work",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_PATH: fakeCodexPath, SESSION_INSPECTOR_MCP_MODE: "off" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  assert.equal(exitCode, 0, stderr);

  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const nativeTurnLinks = entries
    .filter((entry) => entry.event === "runner.native_turn_link")
    .map((entry) => entry.data);
  assert.deepEqual(nativeTurnLinks.map((link) => ({
    sessionId: link?.sessionId,
    turnId: link?.turnId,
    threadId: link?.threadId,
    nativeTurnId: link?.nativeTurnId
  })), [{
    sessionId: "session-1",
    turnId: "manager-turn",
    threadId: "root-thread",
    nativeTurnId: "root-turn"
  }]);
  const result = entries.find((entry) => entry.event === "result")?.data;
  assert.deepEqual({
    threadId: result?.threadId,
    appTurnId: result?.appTurnId,
    reply: result?.reply,
    tokenIn: result?.tokenIn,
    tokenOut: result?.tokenOut
  }, {
    threadId: "root-thread",
    appTurnId: "root-turn",
    reply: "root final",
    tokenIn: 12,
    tokenOut: 4
  });
  assert.equal(entries.some((entry) => entry.event === "error"), false);

  const updatedItems = entries
    .filter((entry) => entry.event === "item" && entry.data?.id === "shared-item" && entry.data?.eventType === "item.updated")
    .map((entry) => entry.data);
  assert.deepEqual(updatedItems.map((item) => ({
    threadId: item.originThreadId,
    turnId: item.originTurnId,
    text: item.text
  })), [
    { threadId: "child-thread", turnId: "child-turn", text: "child:delta" },
    { threadId: "root-thread", turnId: "root-turn", text: "root:delta" }
  ]);
  const childAnswer = entries.find((entry) => entry.event === "item" && entry.data?.id === "child-answer")?.data;
  assert.equal(childAnswer?.originThreadId, "child-thread");
  assert.equal(childAnswer?.originTurnId, "child-turn");
});

test("prompt runner wraps plain agent commentary before Luna replaces its headline", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-commentary-headline-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const detail = "我而家會追查 runner callback ordering，確認 commentary headline 點樣寫入 log。";
  const enrichedShort = "追查 commentary headline 寫入次序";

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: {
      id: "commentary-1",
      type: "agentMessage",
      phase: "commentary",
      text: ${JSON.stringify(detail)}
    } } });
    send({ method: "item/completed", params: { item: {
      id: "answer-1",
      type: "agentMessage",
      text: "done"
    } } });
    send({ method: "turn/completed", params: { turn: {
      id: "app-turn-1",
      status: "completed",
      items: [{ id: "answer-1", type: "agentMessage", text: "done" }]
    } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "trace commentary headline events",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      SESSION_COMMENTARY_HEADLINE_PROVIDER: "mock",
      SESSION_COMMENTARY_HEADLINE_MOCK_RESPONSE: JSON.stringify({
        extracts: [{ type: "action", shortMsg: enrichedShort }]
      }),
      SESSION_INSPECTOR_MCP_MODE: "off"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  assert.equal(exitCode, 0, stderr);

  const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const commentaryEntries = entries.filter((entry) =>
    entry.event === "item" &&
    entry.data?.id === "commentary-1" &&
    entry.data?.eventType === "item.completed"
  );
  assert.equal(commentaryEntries.length, 2);
  assert.equal(commentaryEntries[0].data.comment?.extracts?.[0]?.type, "action");
  assert.notEqual(commentaryEntries[0].data.comment?.extracts?.[0]?.shortMsg, enrichedShort);
  assert.equal(commentaryEntries[1].data.comment?.extracts?.[0]?.shortMsg, enrichedShort);
  assert.equal(commentaryEntries.every((entry) => entry.data.text === detail), true);
  assert.equal(commentaryEntries.every((entry) => entry.data.comment?.detail === detail), true);

  const initialIndex = entries.indexOf(commentaryEntries[0]);
  const enrichedIndex = entries.indexOf(commentaryEntries[1]);
  const resultIndex = entries.findIndex((entry) => entry.event === "result");
  assert.ok(initialIndex >= 0);
  assert.ok(enrichedIndex > initialIndex);
  assert.ok(resultIndex > enrichedIndex);
});

test("prompt runner lets a final answer resolve an issue raised in commentary", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-final-answer-issue-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const issue = "每個 turn 的累計 token usage 不能直接相加。";

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let isolated = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    isolated = request.params?.ephemeral === true;
    send({ id: request.id, result: { thread: { id: isolated ? "headline-thread" : "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    if (isolated) {
      const input = JSON.parse(request.params.input[0].text);
      const response = input.currentUpdate.includes("發現總數")
        ? {
            extracts: [{ type: "trouble", shortMsg: "發現累計 token 不能逐 turn 相加" }],
            issues: [${JSON.stringify(issue)}],
            solutions: []
          }
        : {
            extracts: [{ type: "answer", shortMsg: "改用最後一個累計 snapshot" }],
            issues: [],
            solutions: [{ issueKey: 1, solution: "改用 thread 的最後一個 cumulative token snapshot，避免重複計入早前 turn。" }]
          };
      send({ id: request.id, result: { turn: { id: "headline-turn" } } });
      send({ method: "item/completed", params: { threadId: "headline-thread", item: {
        id: "headline-answer", type: "agentMessage", text: JSON.stringify(response)
      } } });
      send({ method: "turn/completed", params: { threadId: "headline-thread", turn: {
        id: "headline-turn", status: "completed"
      } } });
      return;
    }
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: {
      id: "commentary-1",
      type: "agentMessage",
      phase: "commentary",
      text: "我發現總數係 cumulative token usage，逐 turn 相加會重複計入。"
    } } });
    send({ method: "item/completed", params: { item: {
      id: "answer-1",
      type: "agentMessage",
      phase: "final_answer",
      text: "我會改用最後一個 thread-cumulative snapshot，所以前面 turn 的用量不會再重複相加。"
    } } });
    send({ method: "turn/completed", params: { turn: {
      id: "app-turn-1",
      status: "completed",
      items: [{ id: "answer-1", type: "agentMessage", phase: "final_answer", text: "done" }]
    } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "calculate token usage",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  try {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        OPENAI_API_KEY: "test-key",
        SESSION_COMMENTARY_HEADLINE_PROVIDER: "agent",
        SESSION_INSPECTOR_MCP_MODE: "off"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0, stderr);

    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const finalAnswerEntries = entries.filter((entry) =>
      entry.event === "item" &&
      entry.data?.id === "answer-1" &&
      entry.data?.eventType === "item.completed"
    );
    assert.equal(finalAnswerEntries.length, 2);
    assert.equal(finalAnswerEntries[0].data.comment, undefined);
    assert.deepEqual(finalAnswerEntries[1].data.comment?.solutions, [{
      issueKey: 1,
      solution: "改用 thread 的最後一個 cumulative token snapshot，避免重複計入早前 turn。"
    }]);
    assert.equal(finalAnswerEntries[1].data.comment?.extracts?.[0]?.type, "answer");

    const resultIndex = entries.findIndex((entry) => entry.event === "result");
    assert.ok(resultIndex > entries.indexOf(finalAnswerEntries[1]));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("prompt runner injects an unresolved summariser issue and records a commentary blocker", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-issue-injection-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturePath = resolve(root, "injected.json");
  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let isolated = false;
let injections = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize" || request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "thread/start") {
    isolated = request.params?.ephemeral === true;
    send({ id: request.id, result: { thread: { id: isolated ? "headline" : "root" } } });
  }
  if (request.method === "turn/start") {
    if (isolated) {
      const input = JSON.parse(request.params.input[0].text);
      const blocked = input.currentUpdate.includes("BLOCKER");
      const response = { extracts: [], issues: blocked ? [] : ["Deployment credentials missing"], solutions: [],
        blockers: blocked ? [{ issueKey: 1, blocker: "Owner must supply deployment credentials" }] : [] };
      send({ id: request.id, result: { turn: { id: "summary" } } });
      send({ method: "item/completed", params: { threadId: "headline", item: { id: "summary-answer", type: "agentMessage", text: JSON.stringify(response) } } });
      send({ method: "turn/completed", params: { threadId: "headline", turn: { id: "summary", status: "completed" } } });
    } else {
      send({ id: request.id, result: { turn: { id: "active-turn" } } });
      send({ method: "turn/started", params: { threadId: "root", turn: { id: "active-turn" } } });
      send({ method: "item/completed", params: { threadId: "root", turnId: "active-turn", item: { id: "issue", type: "agentMessage", phase: "commentary", text: "Deployment credentials are missing." } } });
    }
  }
  if (request.method === "thread/inject_items") {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ injections: ++injections, params: request.params }));
    send({ id: request.id, result: {} });
    send({ method: "item/completed", params: { threadId: "root", turnId: "active-turn", item: { id: "blocker", type: "agentMessage", phase: "commentary", text: "BLOCKER: The owner must supply deployment credentials before deployment can proceed." } } });
    setTimeout(() => send({ method: "turn/completed", params: { threadId: "root", turn: { id: "active-turn", status: "completed" } } }), 600);
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({ sessionId: "session", turnId: "turn", message: "Deploy", logPath,
    codexHome: resolve(root, "codex-home"), cwd: projectRoot }), "utf8");
  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot, env: { ...process.env, CODEX_PATH: fakeCodexPath, OPENAI_API_KEY: "test-key",
      SESSION_COMMENTARY_HEADLINE_PROVIDER: "agent", SESSION_INSPECTOR_MCP_MODE: "off" }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    assert.equal(await new Promise((done) => child.once("exit", done)), 0, stderr);
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.injections, 1);
    assert.equal(captured.params.threadId, "root");
    assert.match(captured.params.items[0].content[0].text, /Deployment credentials missing/);
    const events = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.data?.comment?.blockers?.[0]?.blocker === "Owner must supply deployment credentials"));
    assert.equal(events.some((event) => event.event === "commentary.issues.inject_error"), false);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt runner preserves a revoked-refresh-token turn as auth-pending", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-auth-pending-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-auth" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-auth" } } });
    send({ method: "turn/completed", params: { threadId: "thread-auth", turn: {
      id: "app-turn-auth",
      status: "failed",
      error: { message: "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again." }
    } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-auth",
    turnId: "turn-auth",
    message: "go",
    accountId: "account-old",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  try {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_PATH: fakeCodexPath, SESSION_INSPECTOR_MCP_MODE: "off" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0, stderr);

    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const pending = entries.find((entry) => entry.event === "pending");
    assert.equal(pending?.data?.reason, "auth");
    assert.equal(pending?.data?.needsLogin, true);
    assert.match(pending?.data?.message ?? "", /original prompt is saved/i);
    assert.equal(entries.some((entry) => entry.event === "error"), false);
    assert.equal(entries.at(-1)?.event, "done");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("prompt runner starts a recovered thread and injects persisted context when resume fails", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-context-recovery-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/resume") send({ id: request.id, error: { message: "No rollout found for thread id thread-old" } });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-recovered" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-recovered" } } });
    send({ method: "item/completed", params: { threadId: "thread-recovered", item: { id: "answer", type: "agentMessage", text: "continued" } } });
    send({ method: "turn/completed", params: { threadId: "thread-recovered", turn: { id: "app-turn-recovered", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-recovery",
    turnId: "turn-retry",
    message: "go",
    threadId: "thread-old",
    recoveryContext: {
      reason: "account_changed",
      sourceThreadId: "thread-old",
      handoff: "[Threadex deterministic session recovery]\\nOriginal objective and completed decisions"
    },
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  try {
    const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_PATH: fakeCodexPath,
        CAPTURED_TURN_PATH: capturedTurnPath,
        SESSION_INSPECTOR_MCP_MODE: "off"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0, stderr);

    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const recovery = entries.find((entry) => entry.event === "context_recovery");
    assert.equal(recovery?.data?.sourceThreadId, "thread-old");
    assert.equal(recovery?.data?.threadId, "thread-recovered");
    const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
    assert.match(turn.input[0].text, /Original objective and completed decisions/);
    assert.match(turn.input[0].text, /Current user request:\ngo$/);
    assert.equal(entries.find((entry) => entry.event === "result")?.data?.reply, "continued");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, diagnostics: () => string = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for test condition. ${diagnostics()}`.trim());
}

for (const variant of ["ordinary", "manager-direct", "manager-resume", "manager-event", "manager-recovery"]) test(variant !== "ordinary"
  ? `workspace manager runner restricts execution and fixes Luna max for ${variant}`
  : "lightweight runner enables outcome tools without planner mutation or grill gates", async () => {
  const workspaceManagerRole = variant !== "ordinary";
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-todo-language-"));
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  const capturedArgsPath = resolve(root, "captured-args.json");
  const capturedThreadPath = resolve(root, "captured-thread.json");
  const capturedTurnPath = resolve(root, "captured-turn.json");

  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURED_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/resume" && process.env.FAIL_RESUME === "1") {
    send({ id: request.id, error: { code: -32000, message: "no rollout found for thread id thread-old" } });
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    writeFileSync(process.env.CAPTURED_THREAD_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { thread: { id: "thread-1" } } });
  }
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    writeFileSync(process.env.CAPTURED_TURN_PATH, JSON.stringify(request.params));
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/completed", params: { item: { id: "answer-1", type: "agentMessage", text: "完成" } } });
    send({ method: "turn/completed", params: { turn: { id: "app-turn-1", status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(jobPath, JSON.stringify({
    sessionId: "session-1",
    turnId: "turn-1",
    message: "請建立 todo plan，todo language 要跟返用戶 prompt",
    lightweightTodo: !workspaceManagerRole,
    workspaceManager: workspaceManagerRole,
    model: "gpt-6-astra",
    modelReasoningEffort: "high",
    autoModelEnabled: workspaceManagerRole,
    ...(["manager-resume", "manager-event", "manager-recovery"].includes(variant) ? { threadId: "thread-old" } : {}),
    ...(variant === "manager-recovery" ? { recoveryContext: {
      reason: "thread_resume_failed", sourceThreadId: "thread-old", handoff: "Existing manager objectives and decisions."
    } } : {}),
    ...(variant === "manager-event" ? { turnId: "manager_activity_test", message: "Workspace activity notification. A task finished." } : {}),
    executionMode: "default",
    approvalPolicy: "on-request",
    logPath,
    codexHome: resolve(root, "codex-home"),
    cwd: projectRoot
  }), "utf8");

  const child = spawn(process.execPath, ["--import", "tsx", runnerPath, jobPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_PATH: fakeCodexPath,
      CAPTURED_ARGS_PATH: capturedArgsPath,
      CAPTURED_THREAD_PATH: capturedThreadPath,
      CAPTURED_TURN_PATH: capturedTurnPath,
      FAIL_RESUME: variant === "manager-recovery" ? "1" : "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("exit", (code) => code === 0 ? resolveExit() : rejectExit(new Error(`runner exited ${code}: ${stderr}`)));
  });

  const thread = JSON.parse(readFileSync(capturedThreadPath, "utf8"));
  const turn = JSON.parse(readFileSync(capturedTurnPath, "utf8"));
  const config = thread.config.mcp_servers.session_inspector;
  if (workspaceManagerRole) {
    assert.equal(thread.threadId, ["manager-resume", "manager-event"].includes(variant) ? "thread-old" : undefined);
    for (const instructions of [thread.developerInstructions, turn.settings.developer_instructions]) {
      assert.ok(instructions.includes(WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS), `${variant} must install the current routing policy`);
    }
    assert.equal(config.env.THREADEX_WORKSPACE_MANAGER, "1");
    assert.equal(config.env.THREADEX_CONTINUITY_ONLY, "0");
    assert.equal(config.env.THREADEX_AUTO_MODEL, "0");
    assert.equal(thread.model, "gpt-6-luna");
    assert.equal(turn.model, "gpt-6-luna");
    assert.equal(turn.effort, "max");
    assert.equal(thread.sandbox, "read-only");
    assert.equal(turn.sandboxPolicy.type, "readOnly");
    assert.equal(thread.config.features.shell_tool, false);
    assert.equal(thread.config.features.multi_agent, false);
    assert.equal(config.tools.workspace_create_task.approval_mode, "approve");
    assert.equal(config.tools.workspace_fork_task.approval_mode, "approve");
    assert.equal(config.tools.workspace_stop_task.approval_mode, "approve");
    assert.match(turn.settings.developer_instructions, /dedicated manager/);
    assert.match(turn.settings.developer_instructions, /ordinary session history is your memory/);
    assert.doesNotMatch(turn.settings.developer_instructions, /MUST use these tools instead of update_plan/);
    return;
  }
  assert.equal(config.env.THREADEX_LIGHTWEIGHT_TODO, "1");
  assert.doesNotMatch(thread.developerInstructions, /Workspace manager task routing policy/);
  assert.doesNotMatch(turn.settings.developer_instructions, /Workspace manager task routing policy/);
  assert.equal(turn.model, "gpt-6-astra");
  assert.equal(turn.effort, "high");
  assert.equal(config.env.THREADEX_TODO_AGENT_ROLE, "default");
  assert.equal(config.env.THREADEX_CONTINUITY_ONLY, "0");
  assert.ok(config.tools.outcome_plan_set);
  assert.equal(config.tools.todo_set_plan, undefined);
  assert.match(turn.settings.developer_instructions, /Lightweight Todo harness is active/);
  assert.doesNotMatch(turn.settings.developer_instructions, /MUST conduct exactly one|Create the Todo MCP plan and execute it in a later turn/);
  assert.notEqual(turn.settings.sandbox_policy?.type, "read-only");
});

test("prompt runner keeps a long context compaction alive until it completes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "prompt-runner-compaction-"));
  const spawnShimPath = resolve(root, "spawn-shim.mjs");
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const jobPath = resolve(root, "job.json");
  const logPath = resolve(root, "runner.ndjson");
  try {
    writeFileSync(spawnShimPath, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  return command === process.env.CODEX_PATH
    ? originalSpawn(process.execPath, [command, ...args], options)
    : originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`, "utf8");
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-1" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "app-turn-1" } } });
    send({ method: "item/started", params: { threadId: "thread-1", item: { id: "compact-1", type: "contextCompaction" } } });
    setTimeout(() => {
      send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "compact-1", type: "contextCompaction" } } });
      send({ method: "item/completed", params: { threadId: "thread-1", item: { id: "answer-1", type: "agentMessage", text: "done" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "app-turn-1", status: "completed" } } });
    }, 1300);
  }
});
`, "utf8");
    chmodSync(fakeCodexPath, 0o755);
    writeFileSync(jobPath, JSON.stringify({
      sessionId: "session-1",
      turnId: "turn-1",
      message: "continue",
      logPath,
      codexHome: resolve(root, "codex-home"),
      cwd: projectRoot
    }), "utf8");

    const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(spawnShimPath).href, runnerPath, jobPath], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_PATH: fakeCodexPath, RUNNER_COMPACTION_HEARTBEAT_MS: "1000" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    assert.equal(exitCode, 0, `${stderr}\n${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}`);
    const entries = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const heartbeatIndex = entries.findIndex((entry) => entry.event === "runner.compaction_heartbeat");
    const completedIndex = entries.findIndex((entry) => entry.event === "item" && entry.data?.itemType === "context_compaction" && entry.data?.eventType === "item.completed");
    assert.ok(heartbeatIndex > 0, "compaction should refresh runner liveness");
    assert.ok(completedIndex > heartbeatIndex, "heartbeat should stop when compaction completes");
    assert.equal(entries.slice(completedIndex + 1).some((entry) => entry.event === "runner.compaction_heartbeat"), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
