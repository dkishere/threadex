import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { IntentApprovals } from "./intentApprovals";

const cliPath = resolve(import.meta.dirname, "../../scripts/session-inspector.mjs");

test("actor CLI binds actions to its current turn and blocks arbitrary task creation", async () => {
  let received: any;
  let capabilityHeader: unknown;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, body: JSON.parse(body) };
    capabilityHeader = req.headers["x-threadex-actor-capability"];
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_DOMAIN_ACTOR: "1",
    THREADEX_SESSION_ID: "actor-task", THREADEX_TURN_ID: "actor-turn", THREADEX_ACTOR_CAPABILITY: "public-cli-fixture" };
  try {
    const result = await runCli(["actor_tree_status", JSON.stringify({ sourceTurnId: "forged" })], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(capabilityHeader, "public-cli-fixture");
    assert.equal(result.stdout.includes("public-cli-fixture"), false);
    assert.deepEqual(received, { path: "/api/domain-actors/sessions/actor-task/action", body: {
      sourceTurnId: "actor-turn", action: "actor_tree_status"
    } });
    const denied = await runCli(["create_task", JSON.stringify({ prompt: "Unscoped work" })], env);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /not available/);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("hook-injected actor credentials travel only in headers and the removed terminal stays unavailable", async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body), capability: req.headers["x-threadex-actor-capability"], workItem: req.headers["x-threadex-actor-work-item"] });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_DOMAIN_ACTOR: "1",
    THREADEX_SESSION_ID: "host", THREADEX_TURN_ID: "current", THREADEX_ACTOR_CAPABILITY: "" };
  try {
    const terminal = await runCli(["terminal_broadcast", JSON.stringify({ requestId: "api", type: "api_ready", summary: "ready" })], env);
    assert.equal(terminal.code, 1); assert.match(terminal.stderr, /not available/);
    const child = await runCli(["actor_read_memory", JSON.stringify({ field: "rolePrompt", _actorCredential: "child-secret", _actorWorkItem: "child-work" })], env);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(calls[0], { path: "/api/domain-actors/sessions/host/action", capability: "child-secret", workItem: "child-work",
      body: { field: "rolePrompt", action: "actor_read_memory", sourceTurnId: "current" } });
    assert.doesNotMatch(child.stdout, /child-secret/);
    const main = await runCli(["actor_read_memory", JSON.stringify({ field: "rolePrompt", _actorCredential: "main-secret" })], env);
    assert.equal(main.code, 0, main.stderr);
    assert.equal(calls[1].capability, "main-secret"); assert.equal(calls[1].workItem, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("worker consultant commands bind the source session/turn and preserve both consultation triggers", async () => {
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, body: JSON.parse(body), capability: req.headers["x-threadex-actor-capability"] });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: "queued" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_DOMAIN_ACTOR: "1",
    THREADEX_SESSION_ID: "worker", THREADEX_TURN_ID: "current", THREADEX_ACTOR_CAPABILITY: "test-consultant-capability" };
  try {
    for (const [name, args] of [
      ["consultant_list", {}],
      ["consultant_ask", { requestId: "ask", consultantId: "critic", question: "Assess", trigger: "on_demand", sourceTurnId: "forged", sessionId: "other" }],
      ["consultant_round_table", { requestId: "round", consultantIds: ["critic", "researcher"], question: "Discuss", trigger: "user_requested" }],
      ["consultant_status", { requestId: "ask" }],
      ["consultant_cancel", { requestId: "round" }]
    ] as const) {
      const result = await runCli([name, JSON.stringify(args)], env);
      assert.equal(result.code, 0, result.stderr);
      const received = calls.at(-1);
      assert.equal(received.path, "/api/domain-actors/sessions/worker/action");
      assert.equal(received.body.sourceTurnId, "current"); assert.equal(received.body.action, name);
      assert.equal(received.capability, "test-consultant-capability");
    }
    assert.equal(calls[1].body.trigger, "on_demand"); assert.equal(calls[2].body.trigger, "user_requested");
    const denied = await runCli(["consultant_ask", JSON.stringify({ requestId: "r", consultantId: "critic", question: "Delegate" })],
      { ...env, THREADEX_DOMAIN_ACTOR: "0", THREADEX_ACTOR_CAPABILITY: "", THREADEX_TODO_AGENT_ROLE: "side_chat" });
    assert.equal(denied.code, 1); assert.match(denied.stderr, /not available/); assert.equal(calls.length, 5);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("subagent prompt recording binds the current host turn and preserves multiline text", async () => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, body: JSON.parse(body) };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const prompt = "檢查 src/main.ts\n保留 `pwd` 原文。";
  try {
    const result = await runCli(["record_subagent_prompt", JSON.stringify({
      threadId: "child", kind: "spawn", prompt, sessionId: "wrong", turnId: "wrong"
    })], { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "owner",
      THREADEX_TURN_ID: "turn", THREADEX_CONTINUITY_ONLY: "1", THREADEX_TODO_AGENT_ROLE: "default" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(received, { path: "/api/subagent-prompts", body: {
      threadId: "child", kind: "spawn", prompt, sessionId: "owner", turnId: "turn"
    } });
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("Manager connection failure reports its cause and exact escalation entrypoint", async () => {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise<void>(done => server.close(() => done()));
  const result = await runCli(["workspace_status"], {
    RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`,
    THREADEX_WORKSPACE_MANAGER: "1", THREADEX_SESSION_ID: "manager", THREADEX_TURN_ID: "turn"
  });
  assert.equal(result.code, 1);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error, "fetch failed");
  assert.equal(failure.code, "ECONNREFUSED");
  assert.ok(failure.hint.includes(process.execPath));
  assert.ok(failure.hint.includes(cliPath));
  assert.match(failure.hint, /sandbox_permissions=require_escalated/);
  assert.match(failure.hint, /npm wrappers are not automatically approved/);
});

test("a killed intention CLI reconnects to the same pending host request", { timeout: 15000 }, async (t) => {
  const ids: string[] = [];
  let requestedEvents = 0, firstPoll!: () => void;
  const polling = new Promise<void>(resolve => { firstPoll = resolve; });
  const service = new IntentApprovals({ active: async () => true, pending: () => undefined, deliver: async () => undefined,
    publish: async (_a, event) => { if (event === "approval.requested") requestedEvents++; } });
  const proposal = { title: "Deploy?", scope: "Staging", actions: ["Deploy abc"], exclusions: "Production", consequences: "Downtime" };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intent-approvals") {
      const data = JSON.parse(body), created = await service.request(data.sessionId, data.turnId, data.intent);
      ids.push(created.approvalId); res.end(JSON.stringify(created));
      if (ids.length === 2) await service.decide(created.approvalId, { outcome: "approved", actions: proposal.actions, constraints: "" });
    } else {
      firstPoll(); res.end(JSON.stringify(await service.result(req.url!.split("/")[3])));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const env = { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "owner", THREADEX_TURN_ID: "turn", THREADEX_MODEL: "gpt-6-luna" };
  const args = ["request_intent_approval", JSON.stringify(proposal)];
  const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, stdio: "ignore", signal: t.signal });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  try {
    await Promise.race([polling, exited.then(() => { throw new Error("Intention CLI exited before polling the host request"); })]);
    child.kill("SIGKILL"); await exited;
    const resumed = await runCli(args, env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).grantId, ids[0]);
    assert.equal(ids.length, 2); assert.equal(ids[1], ids[0]); assert.equal(requestedEvents, 1);
  } finally { child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("intention CLI binds the host turn, polls and returns the host decision", async () => {
  let polls = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/intent-approvals") {
      const data = JSON.parse(body);
      assert.equal(data.sessionId, "owner"); assert.equal(data.turnId, "active");
      assert.equal(data.intent.title, "Deploy?");
      res.end(JSON.stringify({ approvalId: "host-grant" }));
    } else {
      assert.equal(req.url, "/api/intent-approvals/host-grant/result");
      res.end(JSON.stringify(++polls === 1 ? { pending: true } : { decision: { outcome: "declined" } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const result = await runCli(["request_intent_approval", JSON.stringify({ title: "Deploy?", scope: "Staging A", actions: ["Deploy abc"], exclusions: "Production", consequences: "Downtime", sessionId: "forged", turnId: "forged" })], {
      RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "owner", THREADEX_TURN_ID: "active", THREADEX_MODEL: "gpt-6-luna"
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { decision: { outcome: "declined" } });
    assert.equal(polls, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}, stdin = "") {
  const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env,
    RUNNER_SERVER_URL: "", SESSION_INSPECTOR_SERVER_URL: "", THREADEX_TODO_AGENT_ROLE: "default",
    THREADEX_DOMAIN_ACTOR: "0", THREADEX_ACTOR_CAPABILITY: "",
    THREADEX_WORKSPACE_MANAGER: "0", THREADEX_MANAGER_CONCURRENT: "0", THREADEX_CONTINUITY_ONLY: "0", ...env },
    stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); });
  return { code, stdout, stderr };
}

test("CLI help works offline, errors are nonzero JSON, and stdin is data", async () => {
  const help = await runCli(["help", "recover"]);
  assert.equal(help.code, 0);
  assert.equal(JSON.parse(help.stdout).name, "recover_current_session");
  for (const args of [["get", "{"], ["get", "[]"], ["get", "{}"], ["unknown"]]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(typeof JSON.parse(result.stderr).error, "string");
  }
  let received: unknown;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "fixture conflict" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const result = await runCli(["search", "--stdin"], { RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}` }, '{"q":"$(not executed)"}');
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(result.stderr), { error: "fixture conflict" });
    assert.deepEqual(received, { q: "$(not executed)" });
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test("context-fork CLI loads source attachments via HTTP and preserves the source request and approval policy", async () => {
  let childBody: any;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/session-inspector/fork-source/source/turn-source") {
      response.end(JSON.stringify({ sessionId: "source", requestMetadata: { message: "Canonical user request", attachments: [{ name: "reference.png", mimeType: "image/png", path: "/tmp/reference.png" }] } }));
    } else if (request.url === "/api/session-tasks") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      childBody = JSON.parse(Buffer.concat(chunks).toString());
      response.end(JSON.stringify({ session: { id: "child" } }));
    } else { response.writeHead(404); response.end(JSON.stringify({ error: "Unexpected path" })); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const result = await runCli(["create_task", '{"prompt":"Prepared handoff"}'], {
      RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_CONTEXT_FORK_REQUEST: "1",
      THREADEX_CHILD_MANAGED_MODE: "1", THREADEX_CHILD_EXECUTION_MODE: "loop",
      THREADEX_SESSION_ID: "source", THREADEX_TURN_ID: "turn-source", THREADEX_APPROVAL_POLICY: "granular"
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(childBody.approvalPolicy, "granular");
    assert.equal(childBody.startImmediately, true);
    assert.equal(childBody.contextFork, true);
    assert.equal(childBody.managedMode, true);
    assert.equal(childBody.executionMode, "loop");
    assert.match(childBody.prompt, /Canonical user request/);
    assert.deepEqual(childBody.attachments, [{ name: "reference.png", type: "image/png", path: "/tmp/reference.png" }]);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

// Preserve the behavior assertions below while exercising a fresh real CLI
// process for every operation. No JSON-RPC transport remains.
function cliHarness(options: { env: NodeJS.ProcessEnv }) {
  return async (...call: any[]): Promise<any> => {
    const [method, params] = typeof call[0] === "number" ? call.slice(1) : call;
    if (method === "initialize") return { result: {} };
    const args = method === "tools/list" ? ["help", "--all"] : [params.name, JSON.stringify(params.arguments ?? {})];
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...options.env, RUNNER_SERVER_URL: options.env.SESSION_INSPECTOR_SERVER_URL ?? options.env.RUNNER_SERVER_URL ?? "http://127.0.0.1:1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); });
    if (code !== 0) return { result: { isError: true, content: [{ text: JSON.parse(stderr).error }] } };
    return { result: method === "tools/list" ? { tools: JSON.parse(stdout).commands } : { content: [{ text: stdout.trim() }] } };
  };
}

test("workspace manager exposes only scoped management tools and routes actions through its own session", { timeout: 15000 }, async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const rpc = cliHarness({ env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_WORKSPACE_MANAGER: "1", THREADEX_SESSION_ID: "tx_manager", THREADEX_TURN_ID: "turn-manager", THREADEX_CONTINUITY_ONLY: "1" } });
  try {
    await rpc("initialize");
    const exposed = (await rpc("tools/list")).result.tools.map((tool: any) => tool.name);
    assert.deepEqual(exposed, ["workspace_steer_task", "workspace_status", "workspace_search_tasks", "workspace_inspect_task", "workspace_create_task", "workspace_prompt_task", "workspace_fork_task", "workspace_stop_task", "workspace_continue_stronger"]);
    const forbidden = await rpc("tools/call", { name: "prompt_session", arguments: { sessionId: "another-workspace", message: "go" } });
    assert.equal(forbidden.result.isError, true);
    assert.equal(requests.length, 0);
    const allowed = await rpc("tools/call", { name: "workspace_prompt_task", arguments: { sessionId: "tx_task", message: "go", requestId: "same-action" } });
    assert.equal(allowed.result.isError, undefined);
    assert.deepEqual(requests, [{ url: "/api/workspace-manager/tx_manager/action", body: { action: "prompt", sessionId: "tx_task", message: "go", requestId: "same-action", managerTurnId: "turn-manager" } }]);
    const create = { title: "Child", message: "Independent task brief", cwd: "/tmp", requestId: "new-task", parentSessionId: "tx_parent" };
    assert.equal((await rpc("tools/call", { name: "workspace_create_task", arguments: create })).result.isError, undefined);
    assert.deepEqual(requests.at(-1), { url: "/api/workspace-manager/tx_manager/action", body: { action: "create", ...create, managerTurnId: "turn-manager" } });
    const inspect = { sessionId: "tx_task", turnId: "dispatched-turn" };
    assert.equal((await rpc("tools/call", { name: "workspace_inspect_task", arguments: inspect })).result.isError, undefined);
    assert.deepEqual(requests.at(-1), { url: "/api/workspace-manager/tx_manager/action", body: { action: "inspect", ...inspect, managerTurnId: "turn-manager" } });
  } finally {   await new Promise<void>(done => server.close(() => done())); }
});

test("agents can register commands without starting them and run by id", { timeout: 15_000 }, async () => {
  const requests: { url: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ monitor: { id: "saved-command" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const rpc = cliHarness({ env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_TODO_AGENT_ROLE: "worker", THREADEX_CONTINUITY_ONLY: "0" } });
  try {
    await rpc("initialize");
    const list = (await rpc("tools/list")).result.tools;
    const register = list.find((tool: any) => tool.name === "register_process_command");
    assert.ok(register);
    assert.equal(register.inputSchema.properties.pid, undefined);
    assert.ok(list.some((tool: any) => tool.name === "run_process_command"));
    const metrics = [{ name: "progress", command: "echo ready" }];
    const parameters = [{ name: "count", desc: "Count", type: "number", default: 3 }];
    assert.deepEqual(register.inputSchema.properties.parameters.items.required, ["name", "desc", "type", "default"]);
    const saved = await rpc("tools/call", { name: "register_process_command", arguments: { label: "Example", exe: "node", args: ["-e", "console.log('ok')"], metrics, parameters } });
    assert.equal(saved.result.isError, undefined);
    assert.equal(requests[0].url, "/api/process-monitors");
    assert.equal(requests[0].body.registerOnly, true);
    assert.deepEqual(requests[0].body.metrics, metrics);
    assert.deepEqual(requests[0].body.parameters, parameters);
    const run = await rpc("tools/call", { name: "run_process_command", arguments: { id: "saved-command", parameterValues: { count: 8 } } });
    assert.equal(run.result.isError, undefined);
    assert.equal(requests[1].url, "/api/process-monitors/saved-command/run");
    assert.deepEqual(requests[1].body.parameterValues, { count: 8 });
  } finally {
    
    
    await new Promise<void>((done) => server.close(() => done()));
  }
});

for (const count of ["1", undefined, "invalid", "NaN", "Infinity", "-1", "1.5"]) {
  test(`grill CLI exposes source lookup for totalTurns=${count}`, { timeout: 10_000 }, async () => {
    const env = { ...process.env, THREADEX_SESSION_ID: "single", THREADEX_GRILL_TURN_ID: "target", THREADEX_TODO_AGENT_ROLE: "turn_grill", THREADEX_GRILL_TOTAL_TURNS: count };
    if (count === undefined) delete env.THREADEX_GRILL_TOTAL_TURNS;
    const rpc = cliHarness({ env });
    try {
      await rpc("initialize");
      assert.deepEqual((await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["get_session"]);
    } finally {
      
      
    }
  });
}

test("grill inspector rejects cross-session and cross-turn reads while returning explicit target evidence", { timeout: 15_000 }, async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ session: { id: "source" }, turns: [{ id: "target", userInput: "Already authorized", agentResponse: "Saved", liveItems: ["large tool output"] }], turnPage: { hasMore: false } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const rpc = cliHarness({ env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "source", THREADEX_GRILL_TURN_ID: "target", THREADEX_TODO_AGENT_ROLE: "turn_grill", THREADEX_GRILL_TOTAL_TURNS: "3" } });
  try {
    await rpc("initialize");
    assert.deepEqual((await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["get_session"]);
    const crossSession = await rpc("tools/call", { name: "get_session", arguments: { sessionId: "other" } });
    assert.equal(crossSession.result.isError, true);
    assert.match(crossSession.result.content[0].text, /source session/);
    const crossTurn = await rpc("tools/call", { name: "get_session", arguments: { sessionId: "source", turnId: "other-turn" } });
    assert.equal(crossTurn.result.isError, true);
    assert.match(crossTurn.result.content[0].text, /target turn/);
    const call = () => rpc("tools/call", { name: "get_session", arguments: { sessionId: "source", turnId: "target", q: "authorization", turnLimit: 500, maxTextChars: 250000, includeEvents: true, includeLiveItems: true } });
    const first = await call();
    assert.equal(first.result.isError, undefined);
    const output = JSON.parse(first.result.content[0].text);
    assert.equal(output.turns[0].userInput, "Already authorized");
    assert.deepEqual(output.turns[0].liveItems, ["large tool output"]);
    await call();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].sessionId, "source");
    assert.equal(requests[0].turnId, "target");
    assert.equal(requests[0].turnLimit, 1);
    assert.equal(requests[0].turnOffset, 0);
    assert.equal(requests[0].maxTextChars, 250000);
    assert.equal(requests[0].includeEvents, false);
    assert.equal(requests[0].includeLiveItems, true);
    const write = await rpc("tools/call", { name: "prompt_session", arguments: { message: "write" } });
    assert.equal(write.result.isError, true);
  } finally {
    
    
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("todo planner exposes plan creation and clarification tools only", async () => {
  const rpc = cliHarness({ env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_TODO_AGENT_ROLE: "planner",
      THREADEX_TODO_REQUIRE_INITIAL_GRILL: "1"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string; inputSchema?: { required?: string[]; properties?: Record<string, unknown> } }> };
    assert.deepEqual(result.tools?.map((tool) => tool.name), ["todo_set_plan", "todo_request_clarification"]);
    assert.deepEqual(result.tools?.[0]?.inputSchema?.required, ["problem", "objective", "solution", "verification"]);
    assert.deepEqual(Object.keys(result.tools?.[0]?.inputSchema?.properties ?? {}), ["sessionId", "problem", "objective", "solution", "verification"]);

    const skippedGrillCall = await rpc(3, "tools/call", {
      name: "todo_set_plan",
      arguments: {
        problem: "Known problem",
        objective: "Known objective",
        solution: [{ title: "Implement" }],
        verification: [{ title: "Verify" }]
      }
    });
    const skippedGrillResult = skippedGrillCall.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(skippedGrillResult.isError, true);
    assert.match(skippedGrillResult.content?.[0]?.text ?? "", /requires an initial grill-me round/);

    const hiddenCall = await rpc(4, "tools/call", {
      name: "todo_update_item",
      arguments: { itemId: "todo-1", status: "done" }
    });
    const hiddenResult = hiddenCall.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(hiddenResult.isError, true);
    assert.match(hiddenResult.content?.[0]?.text ?? "", /not available to this planner agent/);
  } finally {
    
    
  }
});

test("side-chat role exposes stored-session reads only", async () => {
  const rpc = cliHarness({ env: {
      ...process.env,
      THREADEX_SESSION_ID: "session-1",
      THREADEX_TODO_AGENT_ROLE: "side_chat"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    assert.deepEqual(result.tools?.map((tool) => tool.name), ["get_session", "search_sessions"]);

    const hiddenCall = await rpc(3, "tools/call", {
      name: "prompt_session",
      arguments: { sessionId: "session-1", message: "mutate this session" }
    });
    const hiddenResult = hiddenCall.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(hiddenResult.isError, true);
    assert.match(hiddenResult.content?.[0]?.text ?? "", /not available to this side_chat agent/);
  } finally {
    
    
  }
});

for (const running of [false, true]) {
test(`interactive side chat ${running ? "queues" : "starts"} host work and rejects other sessions`, async () => {
  const received: Array<{ url?: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    received.push({ url: request.url, body: JSON.parse(text) });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/api/session-inspector/session"
      ? { session: { id: "host", workspaceId: "workspace" }, turns: running ? [{ id: "busy" }] : [] }
      : { ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const rpc = cliHarness({ env: { ...process.env, RUNNER_SERVER_URL: `http://127.0.0.1:${address.port}`,
    THREADEX_SESSION_ID: "host", THREADEX_TODO_AGENT_ROLE: "side_chat", THREADEX_SIDE_CHAT_HOST_PROMPT: "1",
    THREADEX_WORKSPACE_MANAGER: "0", THREADEX_CONTINUITY_ONLY: "0", THREADEX_LIGHTWEIGHT_TODO: "0",
    THREADEX_APPROVAL_POLICY: "granular" } });
  try {
    const listed = await rpc(1, "tools/list");
    assert.deepEqual((listed.result as any).tools.map((tool: any) => tool.name), ["get_session", "search_sessions", "prompt_session"]);
    const rejected = await rpc(2, "tools/call", { name: "prompt_session", arguments: { sessionId: "other", message: "Do it" } });
    assert.match(JSON.stringify(rejected), /only prompt its host session/);
    assert.equal(received.length, 0);
    const result = await rpc(3, "tools/call", { name: "prompt_session", arguments: {
      sessionId: "host", message: "Check the PR and report back", approvalPolicy: "never", queueIfRunning: false
    } });
    assert.equal((result.result as any).isError, undefined);
    assert.equal(received[1].url, running ? "/api/pending-turns" : "/api/chat");
    assert.deepEqual(received[1].body, { sessionId: "host", workspaceId: "workspace",
      message: "Check the PR and report back", approvalPolicy: "granular" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
}

test("recover_current_session reads completed turns from the managed session without an id", async () => {
  const received: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      : {};
    received.push({ url: request.url, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      session: { id: "local_current-1" },
      view: "turn_summary",
      turns: [{ id: "prior-turn", conclusion: "Important earlier correction" }]
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const rpc = cliHarness({ env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_current-1",
      THREADEX_CONTINUITY_ONLY: "1",
      THREADEX_TODO_AGENT_ROLE: "default"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const listedResult = listed.result as { tools?: Array<{ name?: string }> };
    assert.deepEqual(listedResult.tools?.map((tool) => tool.name), [
      "record_subagent_prompt",
      "recover_current_session",
      "get_session",
      "search_sessions"
    ]);

    const recovered = await rpc(3, "tools/call", {
      name: "recover_current_session",
      arguments: { q: "correction", turnLimit: 7, maxTextChars: 1234 }
    });
    assert.match(JSON.stringify(recovered), /Important earlier correction/);
    assert.deepEqual(received, [{
      url: "/api/session-inspector/session",
      body: {
        sessionId: "local_current-1",
        view: "turn_summary",
        status: "done",
        order: "desc",
        q: "correction",
        turnLimit: 7,
        turnOffset: 0,
        maxTextChars: 1234
      }
    }]);
  } finally {
    
    
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("todo_set_plan rejects malformed children before mutation and assigns unique persistent IDs", async () => {
  const postedItems: Array<Record<string, unknown>> = [];
  const postedControls: Array<Record<string, unknown>> = [];
  const requests: string[] = [];
  let control: Record<string, unknown> = {
    paused: false,
    pauseReason: null,
    pausedBy: null,
    context: "",
    updated: ""
  };
  const snapshot = () => ({
    sessionId: "local_parent-1",
    control,
    items: postedItems.map((item) => ({ ...item })),
    itemTree: []
  });
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/api/sessions/local_parent-1/todos") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (request.method === "POST" && request.url === "/api/sessions/local_parent-1/todos/items") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      postedItems.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (request.method === "POST" && request.url === "/api/sessions/local_parent-1/todos/control") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      postedControls.push(body);
      control = {
        paused: body.paused === true,
        pauseReason: typeof body.pauseReason === "string" ? body.pauseReason : null,
        pausedBy: body.actor ?? null,
        context: "",
        updated: "now"
      };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const rpc = cliHarness({ env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_TURN_ID: "turn-plan-1",
      THREADEX_TODO_AGENT_ROLE: "planner"
    } });

  try {
    await rpc(1, "initialize");
    const clarification = await rpc(2, "tools/call", {
      name: "todo_request_clarification",
      arguments: {
        problem: "The requested novel has no defined scope.",
        questions: ["Should the novel cover only the main story or optional content too?"]
      }
    });
    const clarificationResult = clarification.result as { isError?: boolean };
    assert.equal(clarificationResult.isError, undefined);
    assert.equal(postedItems.length, 0);
    assert.deepEqual(postedControls[0], {
      paused: true,
      pauseReason: "Todo CLI plan needs clarification before it can be created.",
      problem: "The requested novel has no defined scope.",
      objective: "",
      context: JSON.stringify({ clarificationQuestions: ["Should the novel cover only the main story or optional content too?"] }),
      actor: "agent"
    });
    const requestsAfterClarification = [...requests];

    const malformed = await rpc(3, "tools/call", {
      name: "todo_set_plan",
      arguments: {
        problem: "The project scope and location are not defined.",
        objective: "The project has an agreed scope and location.",
        solution: [{
          id: "pokemon-yellow-novel-project",
          title: "Pokemon Yellow novel project",
          children: ["scope-and-location"]
        }],
        verification: [{ title: "Confirm the agreed scope" }]
      }
    });
    const malformedResult = malformed.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(malformedResult.isError, true);
    assert.match(malformedResult.content?.[0]?.text ?? "", /solution\[0\]\.children\[0\] must be a full todo item object/);
    assert.match(malformedResult.content?.[0]?.text ?? "", /Valid example: \{"problem"/);
    assert.deepEqual(requests, requestsAfterClarification);
    assert.equal(postedItems.length, 0);

    const valid = await rpc(4, "tools/call", {
      name: "todo_set_plan",
      arguments: {
        problem: "The project scope and location are not defined.",
        objective: "The project has an agreed scope and location.",
        solution: [{
          id: "pokemon-yellow-novel-project",
          title: "Pokemon Yellow novel project",
          status: "active",
          children: [{
            id: "scope-and-location",
            title: "Define scope and location"
          }]
        }],
        verification: [{
          id: "verify-scope",
          title: "Confirm the agreed scope and location"
        }]
      }
    });
    const validResult = valid.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.equal(validResult.isError, undefined);
    assert.equal(postedItems.length, 3);
    assert.match(String(postedItems[0]?.id), /^todo_/);
    assert.notEqual(postedItems[0]?.id, "pokemon-yellow-novel-project");
    assert.equal(postedItems[0]?.parentId, null);
    assert.equal(postedItems[1]?.parentId, postedItems[0]?.id);
    assert.notEqual(postedItems[1]?.id, "scope-and-location");
    assert.equal(postedItems[0]?.section, "solution");
    assert.equal(postedItems[1]?.section, "solution");
    assert.equal(postedItems[2]?.section, "verification");
    assert.deepEqual(postedControls.at(-1), {
      paused: true,
      pauseReason: "Initial Todo CLI plan created for review. Execution has not started.",
      problem: "The project scope and location are not defined.",
      objective: "The project has an agreed scope and location.",
      context: "",
      actor: "agent"
    });
    const returned = JSON.parse(validResult.content?.[0]?.text ?? "{}") as {
      items?: unknown[];
      control?: { paused?: boolean; pauseReason?: string | null; pausedBy?: string | null };
    };
    assert.equal(returned.items?.length, 3);
    assert.equal(returned.control?.paused, true);
    assert.equal(returned.control?.pausedBy, "agent");
  } finally {
    
    
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("create_task posts a same-session child handoff to Threadex", async () => {
  let received: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/session-tasks");
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      sessionId: "local_child-1",
      parentSessionId: "local_parent-1",
      uri: "codex://threads/local_child-1?workspace=default"
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const rpc = cliHarness({ env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_THREAD_ID: "thread-parent-1",
      THREADEX_MODEL: "gpt-5.6-terra",
      THREADEX_MODEL_REASONING_EFFORT: "high",
      THREADEX_APPROVAL_POLICY: "auto",
      THREADEX_CHILD_EXECUTION_MODE: "goal",
      THREADEX_CHILD_SKILLS: JSON.stringify([{ name: "handoff-skill", path: "/skills/handoff/SKILL.md" }])
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    assert.ok(result.tools?.some((tool) => tool.name === "create_task"));
    assert.ok(result.tools?.some((tool) => tool.name === "todo_get_detail"));
    assert.ok(result.tools?.some((tool) => tool.name === "todo_set_context"));

    const called = await rpc(3, "tools/call", {
      name: "create_task",
      arguments: {
        prompt: "Self-contained Cantonese task handoff",
        title: "Child task",
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh"
      }
    });
    assert.equal(called.error, undefined);
    assert.deepEqual(received, {
      parentSessionId: "local_parent-1",
      sourceSessionId: "local_parent-1",
      prompt: "Self-contained Cantonese task handoff",
      title: "Child task",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "xhigh",
      approvalPolicy: "auto",
      executionMode: "goal",
      skills: [{ name: "handoff-skill", path: "/skills/handoff/SKILL.md" }]
    });

    const defaulted = await rpc(4, "tools/call", {
      name: "create_task",
      arguments: { prompt: "Use the current task settings" }
    });
    assert.equal(defaulted.error, undefined);
    assert.deepEqual(received, {
      parentSessionId: "local_parent-1",
      sourceSessionId: "local_parent-1",
      prompt: "Use the current task settings",
      model: "gpt-5.6-terra",
      modelReasoningEffort: "high",
      approvalPolicy: "auto",
      executionMode: "goal",
      skills: [{ name: "handoff-skill", path: "/skills/handoff/SKILL.md" }]
    });
  } finally {
    
    
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("wake prompts and event subscriptions inherit the manager approval policy", async () => {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      url: request.url ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    });
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const rpc = cliHarness({ env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_THREAD_ID: "thread-parent-1",
      THREADEX_APPROVAL_POLICY: "granular"
    } });

  try {
    await rpc(1, "initialize");
    await rpc(2, "tools/call", {
      name: "subscribe_wait_event",
      arguments: {
        eventId: "wait_event-1",
        sessionId: "local_parent-1",
        actionType: "enqueue_prompt",
        actionPayload: { message: "Continue after completion." }
      }
    });
    await rpc(3, "tools/call", {
      name: "monitor_process",
      arguments: {
        label: "background job",
        pid: 1234,
        removeOnExit: false,
        wakePrompt: "Inspect the completed job."
      }
    });
    await rpc(4, "tools/call", {
      name: "adopt_process_monitor",
      arguments: {
        id: "process_monitor-1",
        pid: 1234,
        exe: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000)"]
      }
    });
    await rpc(5, "tools/call", {
      name: "restart_process_monitor",
      arguments: { id: "process_monitor-1" }
    });

    assert.deepEqual(received, [
      {
        url: "/api/wait-subscriptions",
        body: {
          eventId: "wait_event-1",
          sessionId: "local_parent-1",
          actionType: "enqueue_prompt",
          actionPayload: {
            message: "Continue after completion.",
            approvalPolicy: "granular"
          }
        }
      },
      {
        url: "/api/process-monitors",
        body: {
          label: "background job",
          pid: 1234,
          removeOnExit: false,
          wakePrompt: "Inspect the completed job.",
          approvalPolicy: "granular",
          sessionId: "local_parent-1",
          threadId: "thread-parent-1"
        }
      },
      {
        url: "/api/process-monitors/process_monitor-1/adopt",
        body: {
          pid: 1234,
          exe: process.execPath,
          args: ["-e", "setTimeout(() => {}, 1000)"],
          approvalPolicy: "granular"
        }
      },
      {
        url: "/api/process-monitors/process_monitor-1/restart",
        body: { approvalPolicy: "granular" }
      }
    ]);
  } finally {
    
    
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("todo workers cannot create another task during ordinary follow-up turns", async () => {
  const rpc = cliHarness({ env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_worker-1",
      THREADEX_TODO_AGENT_ROLE: "worker",
      THREADEX_TODO_PARENT_SESSION_ID: "local_parent-1",
      THREADEX_TODO_ITEM_ID: "todo-assigned-1"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const names = result.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("todo_update_item"));
    assert.ok(names.includes("todo_add_message"));
    assert.ok(!names.includes("todo_create_task"));
    assert.ok(!names.includes("create_task"));
    assert.ok(!names.includes("todo_set_plan"));

    const blocked = await rpc(3, "tools/call", {
      name: "todo_create_task",
      arguments: { itemId: "todo-assigned-1", prompt: "Continue this follow-up elsewhere" }
    });
    assert.match(JSON.stringify(blocked), /not available to this worker agent/);
  } finally {
    
    
  }
});

test("an explicit context fork exposes only the generic create_task to a todo worker", async () => {
  const rpc = cliHarness({ env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_worker-1",
      THREADEX_CONTEXT_FORK_REQUEST: "1",
      THREADEX_TODO_AGENT_ROLE: "worker",
      THREADEX_TODO_PARENT_SESSION_ID: "local_parent-1",
      THREADEX_TODO_ITEM_ID: "todo-assigned-1"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const names = result.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("create_task"));
    assert.ok(!names.includes("todo_create_task"));
  } finally {
    
    
  }
});

test("an explicit context fork keeps create_task available when planner metadata is also present", async () => {
  const rpc = cliHarness({ env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_planner-1",
      THREADEX_CONTEXT_FORK_REQUEST: "1",
      THREADEX_TODO_AGENT_ROLE: "planner"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const names = result.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("create_task"));
    assert.ok(names.includes("todo_set_plan"));
    assert.ok(!names.includes("todo_create_task"));
  } finally {
    
    
  }
});

for (const running of [false, true]) {
for (const policy of [
  { parent: "granular", explicit: undefined, expected: "granular" },
  { parent: "granular", explicit: "on-request", expected: "on-request" },
  { parent: "", explicit: undefined, expected: undefined }
]) {
test(`prompt_session ${running ? "queues" : "starts"} with parent=${policy.parent} explicit=${policy.explicit}`, { timeout: 15_000 }, async () => {
  const received: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      : {};
    received.push({ url: request.url, body });

    if (request.method === "POST" && request.url === "/api/session-inspector/session") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        session: { id: "local_target-1", workspaceId: "default", threadId: "thread-target-1" },
        turns: running ? [{ id: "running-turn-1", status: "running" }] : [],
        turnPage: { total: 1, limit: 1, offset: 0, hasMore: false }
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/chat") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end('event: result\ndata: {"sessionId":"local_target-1","reply":"Done"}\n\n');
      return;
    }

    if (request.method === "POST" && request.url === "/api/pending-turns") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        sessionId: "local_target-1",
        turn: { id: "queued-turn-1", status: "todo" }
      }));
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const rpc = cliHarness({ env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_APPROVAL_POLICY: policy.parent,
      THREADEX_TODO_AGENT_ROLE: "default",
      THREADEX_CONTINUITY_ONLY: "0"
    } });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    assert.ok(result.tools?.some((tool) => tool.name === "prompt_session"));

    const called = await rpc(3, "tools/call", {
      name: "prompt_session",
      arguments: {
        sessionId: "local_target-1",
        message: "Please continue the normal session.",
        model: "gpt-5.6-terra",
        ...(policy.explicit ? { approvalPolicy: policy.explicit } : {}),
        executionMode: "plan"
      }
    });
    assert.equal(called.error, undefined);
    assert.equal((called.result as { isError?: boolean }).isError, undefined);
    const pendingRequest = received.find((item) => item.url === (running ? "/api/pending-turns" : "/api/chat"));
    assert.deepEqual(pendingRequest?.body, {
      message: "Please continue the normal session.",
      sessionId: "local_target-1",
      workspaceId: "default",
      model: "gpt-5.6-terra",
      ...(policy.expected ? { approvalPolicy: policy.expected } : {}),
      executionMode: "plan"
    });
  } finally {
    
    
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
}
}


test("lightweight agent exposes nested content tools and hides all legacy status writers", async () => {
  const rpc = cliHarness({ env: { ...process.env, THREADEX_SESSION_ID: "outcomes", SESSION_INSPECTOR_SERVER_URL: "http://127.0.0.1:1", THREADEX_LIGHTWEIGHT_TODO: "1" } });
  try {
    await rpc(1, "initialize");
    const listed = (await rpc(2, "tools/list")).result.tools;
    assert.ok(listed.some((tool: any) => tool.name === "outcome_plan_get"));
    const setter = listed.find((tool: any) => tool.name === "outcome_plan_set");
    assert.ok(setter.inputSchema.$defs.item.properties.children);
    assert.equal(setter.inputSchema.$defs.item.properties.status, undefined);
    assert.ok(!listed.some((tool: any) => tool.name.startsWith("todo_")));
    const rejected = await rpc(3, "tools/call", { name: "todo_update_item", arguments: { itemId: "x", status: "done" } });
    assert.equal(rejected.result.isError, true);
  } finally {   }
});
