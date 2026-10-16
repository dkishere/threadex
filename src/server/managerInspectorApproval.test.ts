import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

test("Manager runner approves Codex shell-string CLI and carries its identity through to HTTP", { timeout: 15000 }, async () => {
  const root = mkdtempSync(resolve(tmpdir(), "manager-inspector-approval-"));
  const project = resolve(import.meta.dirname, "../..");
  const cli = resolve(project, "scripts/session-inspector.mjs");
  const fake = resolve(root, "codex.mjs"), job = resolve(root, "job.json"), result = resolve(root, "result.json");
  const actions: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/workspace-manager/manager-test/action") {
      actions.push(JSON.parse(body));
      response.end(JSON.stringify({ verified: true }));
    } else response.end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-test" } } });
  if (request.method === "thread/goal/clear") send({ id: request.id, result: {} });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "turn-test" } } });
    const inner = process.execPath + " " + ${JSON.stringify(cli)} + " workspace_status '{}'";
    send({ id: "cli-approval", method: "item/commandExecution/requestApproval", params: {
      command: '/bin/zsh -lc "' + inner + '"', cwd: ${JSON.stringify(project)},
      threadId: "thread-test", turnId: "turn-test", itemId: "cli"
    } });
  }
  if (request.id === "cli-approval") {
    const decision = request.result?.decision;
    const run = decision === "accept" ? spawnSync(process.execPath, [${JSON.stringify(cli)}, "workspace_status", "{}"], { encoding: "utf8", env: process.env }) : null;
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({ decision, status: run?.status, stdout: run?.stdout, stderr: run?.stderr }));
    send({ method: "item/completed", params: { item: { id: "answer", type: "agentMessage", text: "verified" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-test", status: "completed" } } });
  }
});
`);
  chmodSync(fake, 0o755);
  writeFileSync(job, JSON.stringify({ sessionId: "manager-test", turnId: "manager-turn", workspaceManager: true,
    message: "Check workspace status", cwd: project, logPath: resolve(root, "runner.ndjson"),
    codexHome: resolve(root, "home"), serverUrl: `http://127.0.0.1:${address.port}`, approvalPolicy: "on-request" }));
  const child = spawn(process.execPath, ["--import", "tsx", resolve(project, "src/server/promptRunner.ts"), job], {
    cwd: project, env: { ...process.env, CODEX_PATH: fake }, stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    assert.equal(code, 0, stderr);
    const outcome = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(outcome.decision, "accept");
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), { verified: true });
    assert.deepEqual(actions, [{ action: "status", managerTurnId: "manager-turn" }]);
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
