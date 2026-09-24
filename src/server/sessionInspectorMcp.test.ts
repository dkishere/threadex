import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import test from "node:test";

const mcpPath = resolve(import.meta.dirname, "sessionInspectorMcp.ts");

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
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_WORKSPACE_MANAGER: "1", THREADEX_SESSION_ID: "tx_manager", THREADEX_CONTINUITY_ONLY: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  lines.on("line", line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>(done => {
    pending.set(++id, done); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await rpc("initialize");
    const exposed = (await rpc("tools/list")).result.tools.map((tool: any) => tool.name);
    assert.deepEqual(exposed, ["workspace_status", "workspace_search_tasks", "workspace_inspect_task", "workspace_create_task", "workspace_prompt_task", "workspace_stop_task"]);
    const forbidden = await rpc("tools/call", { name: "prompt_session", arguments: { sessionId: "another-workspace", message: "go" } });
    assert.equal(forbidden.result.isError, true);
    assert.equal(requests.length, 0);
    const allowed = await rpc("tools/call", { name: "workspace_prompt_task", arguments: { sessionId: "tx_task", message: "go", requestId: "same-action" } });
    assert.equal(allowed.result.isError, undefined);
    assert.deepEqual(requests, [{ url: "/api/workspace-manager/tx_manager/action", body: { action: "prompt", sessionId: "tx_task", message: "go", requestId: "same-action" } }]);
    const create = { title: "Child", message: "Independent task brief", cwd: "/tmp", requestId: "new-task", parentSessionId: "tx_parent" };
    assert.equal((await rpc("tools/call", { name: "workspace_create_task", arguments: create })).result.isError, undefined);
    assert.deepEqual(requests.at(-1), { url: "/api/workspace-manager/tx_manager/action", body: { action: "create", ...create } });
    const inspect = { sessionId: "tx_task", turnId: "dispatched-turn" };
    assert.equal((await rpc("tools/call", { name: "workspace_inspect_task", arguments: inspect })).result.isError, undefined);
    assert.deepEqual(requests.at(-1), { url: "/api/workspace-manager/tx_manager/action", body: { action: "inspect", ...inspect } });
  } finally { child.kill("SIGTERM"); lines.close(); await new Promise<void>(done => server.close(() => done())); }
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
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_TODO_AGENT_ROLE: "worker", THREADEX_CONTINUITY_ONLY: "0" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((done) => {
    pending.set(++id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
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
    child.kill("SIGTERM");
    lines.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

for (const count of ["1", undefined, "invalid", "NaN", "Infinity", "-1", "1.5"]) {
  test(`grill MCP exposes source lookup for totalTurns=${count}`, { timeout: 10_000 }, async () => {
    const env = { ...process.env, THREADEX_SESSION_ID: "single", THREADEX_GRILL_TURN_ID: "target", THREADEX_TODO_AGENT_ROLE: "turn_grill", THREADEX_GRILL_TOTAL_TURNS: count };
    if (count === undefined) delete env.THREADEX_GRILL_TOTAL_TURNS;
    const child = spawn(process.execPath, ["--import", "tsx", mcpPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<number, (value: any) => void>();
    lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
    let id = 0;
    const rpc = (method: string, params?: unknown) => new Promise<any>((done) => {
      pending.set(++id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    try {
      await rpc("initialize");
      assert.deepEqual((await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["get_session"]);
    } finally {
      child.kill("SIGTERM");
      lines.close();
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
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: { ...process.env, SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`, THREADEX_SESSION_ID: "source", THREADEX_GRILL_TURN_ID: "target", THREADEX_TODO_AGENT_ROLE: "turn_grill", THREADEX_GRILL_TOTAL_TURNS: "3" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<any>((done) => {
    pending.set(++id, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
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
    const exhausted = await call();
    assert.equal(exhausted.result.isError, true);
    assert.match(exhausted.result.content[0].text, /budget exhausted/);
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
    child.kill("SIGTERM");
    lines.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("todo planner exposes plan creation and clarification tools only", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_TODO_AGENT_ROLE: "planner",
      THREADEX_TODO_REQUIRE_INITIAL_GRILL: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
  }
});

test("side-chat role exposes stored-session reads only", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      THREADEX_SESSION_ID: "session-1",
      THREADEX_TODO_AGENT_ROLE: "side_chat"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
  }
});

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

  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_current-1",
      THREADEX_CONTINUITY_ONLY: "1",
      THREADEX_TODO_AGENT_ROLE: "default"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const listedResult = listed.result as { tools?: Array<{ name?: string }> };
    assert.deepEqual(listedResult.tools?.map((tool) => tool.name), [
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
    child.kill("SIGTERM");
    lines.close();
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

  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_TURN_ID: "turn-plan-1",
      THREADEX_TODO_AGENT_ROLE: "planner"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
      pauseReason: "Todo MCP plan needs clarification before it can be created.",
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
      pauseReason: "Initial Todo MCP plan created for review. Execution has not started.",
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
    child.kill("SIGTERM");
    lines.close();
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

  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_THREAD_ID: "thread-parent-1",
      THREADEX_MODEL: "gpt-5.6-terra",
      THREADEX_MODEL_REASONING_EFFORT: "high",
      THREADEX_APPROVAL_POLICY: "auto",
      THREADEX_CHILD_EXECUTION_MODE: "goal",
      THREADEX_CHILD_SKILLS: JSON.stringify([{ name: "handoff-skill", path: "/skills/handoff/SKILL.md" }])
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
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

  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_SESSION_ID: "local_parent-1",
      THREADEX_THREAD_ID: "thread-parent-1",
      THREADEX_APPROVAL_POLICY: "granular"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

test("todo workers cannot create another task during ordinary follow-up turns", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_worker-1",
      THREADEX_TODO_AGENT_ROLE: "worker",
      THREADEX_TODO_PARENT_SESSION_ID: "local_parent-1",
      THREADEX_TODO_ITEM_ID: "todo-assigned-1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
  }
});

test("an explicit context fork exposes only the generic create_task to a todo worker", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_worker-1",
      THREADEX_CONTEXT_FORK_REQUEST: "1",
      THREADEX_TODO_AGENT_ROLE: "worker",
      THREADEX_TODO_PARENT_SESSION_ID: "local_parent-1",
      THREADEX_TODO_ITEM_ID: "todo-assigned-1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const names = result.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("create_task"));
    assert.ok(!names.includes("todo_create_task"));
  } finally {
    child.kill("SIGTERM");
    lines.close();
  }
});

test("an explicit context fork keeps create_task available when planner metadata is also present", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      THREADEX_SESSION_ID: "local_planner-1",
      THREADEX_CONTEXT_FORK_REQUEST: "1",
      THREADEX_TODO_AGENT_ROLE: "planner"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

  try {
    await rpc(1, "initialize");
    const listed = await rpc(2, "tools/list");
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const names = result.tools?.map((tool) => tool.name) ?? [];
    assert.ok(names.includes("create_task"));
    assert.ok(names.includes("todo_set_plan"));
    assert.ok(!names.includes("todo_create_task"));
  } finally {
    child.kill("SIGTERM");
    lines.close();
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

  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: {
      ...process.env,
      SESSION_INSPECTOR_SERVER_URL: `http://127.0.0.1:${address.port}`,
      THREADEX_APPROVAL_POLICY: policy.parent,
      THREADEX_TODO_AGENT_ROLE: "default",
      THREADEX_CONTINUITY_ONLY: "0"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null) pending.get(id)?.(message);
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });

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
    child.kill("SIGTERM");
    lines.close();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
}
}


test("lightweight agent exposes nested content tools and hides all legacy status writers", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", mcpPath], {
    env: { ...process.env, THREADEX_SESSION_ID: "outcomes", SESSION_INSPECTOR_SERVER_URL: "http://127.0.0.1:1", THREADEX_LIGHTWEIGHT_TODO: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  lines.on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<any>((resolveRpc) => {
    pending.set(id, resolveRpc);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + String.fromCharCode(10));
  });
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
  } finally { child.kill("SIGTERM"); lines.close(); }
});
