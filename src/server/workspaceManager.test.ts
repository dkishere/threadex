import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { SessionStore } from "./sessionStore";
import { openPostgresSessionConnection, postgresSchemaFromStoreId } from "./sessionDb";
import { WorkspaceManagerService, WORKSPACE_MANAGER_INSTRUCTIONS, workspaceManagerEvent, workspaceManagerContext } from "./workspaceManager";
import { WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS } from "./workspaceManagerRouting";
import { isSilentManagerResponse, recentWorkspaceManagerMessages, recentWorkspaceManagerTurns, visibleWorkspaceManagerMessage, type WorkspaceManagerEvent } from "../workspaceManager";

test("manager renders only the latest 50 turns including a live reply, without changing history", () => {
  const messages = Array.from({ length: 65 }, (_, index) => [
    { role: "user", turnId: `turn-${index}`, content: `Request ${index}`, turnStatus: "done" },
    { role: "assistant", turnId: `turn-${index}`, content: `Reply ${index}`, turnStatus: index === 64 ? "running" : "done" }
  ]).flat();
  const visible = recentWorkspaceManagerMessages(messages);
  assert.equal(new Set(visible.map(message => message.turnId)).size, 50);
  assert.equal(visible[0].turnId, "turn-15");
  assert.equal(visible.at(-1)?.turnStatus, "running");
  assert.equal(messages.length, 130);
});

test("long manager snapshots exclude old payloads before parsing, including on reopen", () => {
  const turns = Array.from({ length: 10_000 }, (_, index) => ({
    id: `turn-${index}`, status: index === 9999 ? "running" : "done", agentResponse: `Reply ${index}`,
    get userInput() { assert.ok(index >= 9950, "old prompt must not be parsed"); return `Request ${index}`; },
    get liveItems() { assert.ok(index >= 9950, "old timeline must not be built"); return []; }
  }));
  for (let reopen = 0; reopen < 2; reopen++) {
    const selected = recentWorkspaceManagerTurns(turns);
    assert.equal(selected.length, 50);
    assert.equal(selected[0].id, "turn-9950");
    assert.equal(selected.at(-1)?.status, "running");
    selected.forEach(turn => { assert.ok(turn.userInput); assert.deepEqual(turn.liveItems, []); });
  }
  assert.equal(turns.length, 10_000);
});

test("a running turn stays in the 50-turn window even behind many queued turns and multiple blocks", () => {
  const turns = Array.from({ length: 65 }, (_, index) => ({ id: `turn-${index}`, status: index === 0 ? "running" : "todo", agentResponse: "" }));
  const selected = recentWorkspaceManagerTurns(turns);
  assert.equal(selected.length, 50);
  assert.equal(selected[0].id, "turn-0");
  assert.equal(selected[1].id, "turn-16");
  const messages = turns.flatMap(turn => [
    { role: "user", turnId: turn.id, turnStatus: turn.status, content: "Request" },
    { role: "assistant", turnId: turn.id, turnStatus: turn.status, content: "Live reply" },
    { role: "user", kind: "steer", turnId: turn.id, turnStatus: turn.status, content: "More context" }
  ]);
  const visible = recentWorkspaceManagerMessages(messages);
  assert.equal(new Set(visible.map(message => message.turnId)).size, 50);
  assert.equal(visible.length, 150);
  const streamed = recentWorkspaceManagerMessages(visible.map(message => message.turnId === "turn-0" && message.role === "assistant"
    ? { ...message, content: "Live reply continued" } : message));
  assert.equal(streamed.length, 150);
  assert.equal(streamed[1].content, "Live reply continued");
});

test("manager lifecycle events distinguish normal completion, explicit stop, unexpected exit and process changes", () => {
  const base = { eventId: "event", workspaceId: "a", sessionId: "task", turnId: "turn", timestamp: new Date().toISOString(), payload: {} };
  assert.equal(workspaceManagerEvent({ ...base, type: "runner.codex" }), null);
  assert.equal(workspaceManagerEvent({ ...base, type: "runner.result" })?.type, "task.turn_completed");
  assert.equal(workspaceManagerEvent({ ...base, type: "runner.pending", payload: { reason: "stopped" } })?.type, "task.interrupted");
  assert.equal(workspaceManagerEvent({ ...base, type: "runner.pending", payload: { reason: "stopped", stopped: true } })?.type, "task.stopped");
  const first = workspaceManagerEvent({ ...base, type: "runner.result" })!;
  assert.equal(workspaceManagerEvent({ ...base, type: "runner.result" })?.id, first.id);
  assert.notEqual(workspaceManagerEvent({ ...base, eventId: "new-attempt", type: "runner.result" })?.id, first.id);
  const process = workspaceManagerEvent({ ...base, sessionId: null, turnId: null, type: "process.monitor.changed", payload: { action: "stopped", label: "build", status: "stopped" } });
  assert.equal(process?.type, "process.changed");
  assert.match(process!.summary, /stopped/);
  assert.equal(isSilentManagerResponse("  [workspace-note] Expected process exit."), true);
  assert.equal(isSilentManagerResponse("Task finished. [workspace-note]"), false);
  assert.equal(visibleWorkspaceManagerMessage({ role: "user", turnId: "manager_event", content: "System event" }), false);
  assert.equal(visibleWorkspaceManagerMessage({ role: "assistant", turnId: "manager_event", content: "[workspace-note] Fine", turnStatus: "done" }), false);
  assert.equal(visibleWorkspaceManagerMessage({ role: "assistant", turnId: "manager_event", content: "Needs attention", turnStatus: "done" }), true);
  assert.equal(visibleWorkspaceManagerMessage({ role: "assistant", turnId: "user-turn", content: "Streaming", turnStatus: "running" }), true);
});

test("direct task prompts create one durable manager event; historical dismissals are audited and never delivered", async t => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-prompts-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  t.after(() => store.close());
  await store.upsertWorkspace({ id: "activity", name: "Activity", cwd: root, codexHome: root });
  const manager = await store.ensureWorkspaceManager("activity");
  await store.upsertSession({ id: "ordinary", workspaceId: "activity", cwd: root, title: "Ordinary task" });
  await store.recordSessionTurn({ id: "direct-prompt", sessionId: "ordinary", userInput: "Continue the task",
    agentResponse: "Queued", status: "todo", pendingReason: "queued", tokenIn: 0, tokenOut: 0,
    requestMetadata: { clientLayout: "desktop" } });
  await store.recordSessionTurn({ id: "automatic-prompt", sessionId: "ordinary", userInput: "Automatic follow-up",
    agentResponse: "Queued", status: "todo", pendingReason: "queued", tokenIn: 0, tokenOut: 0,
    requestMetadata: { backgroundTask: true } });
  await store.recordSessionTurn({ id: "manager-prompt", sessionId: manager.sessionId, userInput: "Coordinate work",
    agentResponse: "Queued", status: "todo", pendingReason: "queued", tokenIn: 0, tokenOut: 0,
    requestMetadata: { clientLayout: "desktop" } });
  const events = await store.listWorkspaceManagerEvents("activity");
  assert.deepEqual(events.map(event => [event.type, event.turnId]), [["task.prompted", "direct-prompt"]]);
  assert.match(events[0].summary, /Continue the task/);
  await store.claimSessionTurn({ id: "direct-prompt", sessionId: "ordinary", userInput: "Continue the task",
    agentResponse: "", tokenIn: 0, tokenOut: 0, requestMetadata: { clientLayout: "desktop" } });
  assert.equal((await store.listWorkspaceManagerEvents("activity")).length, 1, "retrying a turn cannot double-notify");

  await store.updateWorkspaceManager("activity", { notificationsEnabled: false });
  assert.equal(await store.queueWorkspaceManagerEvents("activity"), null);
  assert.equal((await store.workspaceManagerSnapshot("activity")).pendingEvents, 1);
  assert.deepEqual(await store.dismissWorkspaceManagerEvents("activity", [events[0].id, events[0].id], "stale after review"), [events[0].id]);
  assert.equal((await store.workspaceManagerSnapshot("activity")).pendingEvents, 0);
  assert.equal((await store.listWorkspaceManagerEvents("activity", false))[0].dismissedReason, "stale after review");
  await store.updateWorkspaceManager("activity", { notificationsEnabled: true });
  assert.equal(await store.queueWorkspaceManagerEvents("activity"), null, "a dismissed event must not wake the manager");
});

test("repeated API restarts leave one pending manager notice and retain earlier notices for audit", async t => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-restarts-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  t.after(() => store.close());
  await store.upsertWorkspace({ id: "activity", name: "Activity", cwd: root, codexHome: root });
  await store.ensureWorkspaceManager("activity");
  const first = { id: "first-restart", workspaceId: "activity", sessionId: null, turnId: null,
    type: "platform.restarted", summary: "First", created: new Date(Date.now() + 1000).toISOString() };
  const second = { ...first, id: "second-restart", summary: "Second", created: new Date(Date.now() + 2000).toISOString() };
  await store.recordWorkspaceManagerEvent(first);
  await store.recordWorkspaceManagerEvent(second);
  await store.recordWorkspaceManagerEvent(first);
  assert.deepEqual((await store.listWorkspaceManagerEvents("activity")).map(event => event.id), ["second-restart"]);
  const all = await store.listWorkspaceManagerEvents("activity", false);
  assert.equal(all.length, 2);
  assert.equal(all[0].dismissedReason, "superseded by a later platform restart");
  assert.equal((await store.workspaceManagerSnapshot("activity")).pendingEvents, 1);
});

test("one manager per workspace, durable deduplicated delivery, pause, busy protection and normal history", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-test-"));
  const path = resolve(root, "test.postgres");
  let store = new SessionStore(path);
  await store.ready();
  try {
    await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
    await store.upsertWorkspace({ id: "b", name: "B", cwd: root, codexHome: root });
    const [a, duplicate, b] = await Promise.all([store.ensureWorkspaceManager("a"), store.ensureWorkspaceManager("a"), store.ensureWorkspaceManager("b")]);
    assert.equal(a.sessionId, duplicate.sessionId);
    assert.notEqual(a.sessionId, b.sessionId);
    await store.upsertSession({ id: "tx_task_a", workspaceId: "a", cwd: root, title: "Build" });
    await store.upsertSession({ id: "tx_task_b", workspaceId: "b", cwd: root, title: "Other" });
    await store.recordSessionTurn({ id: "stopped-work", sessionId: "tx_task_a", userInput: "Work", agentResponse: "Stopped", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "stopped" });
    assert.equal((await store.workspaceManagerSnapshot("a")).pendingTasks, 0);
    const event: WorkspaceManagerEvent = { id: "event-a", workspaceId: "a", sessionId: "tx_task_a", turnId: "work", type: "task.started", summary: "Started", created: new Date(Date.now() + 1).toISOString() };
    await store.recordWorkspaceManagerEvent(event);
    await store.recordWorkspaceManagerEvent(event);
    await store.recordWorkspaceManagerEvent({ ...event, id: "self", sessionId: a.sessionId });
    await store.recordWorkspaceManagerEvent({ ...event, id: "cross-workspace", sessionId: "tx_task_b" });
    await store.recordWorkspaceManagerEvent({ ...event, id: "process", sessionId: null, turnId: null, type: "process.exited" });
    assert.equal((await store.workspaceManagerSnapshot("a")).pendingEvents, 2);
    assert.equal((await store.workspaceManagerSnapshot("b")).pendingEvents, 0);
    await store.updateWorkspaceManager("a", { notificationsEnabled: false });
    assert.equal(await store.queueWorkspaceManagerEvents("a"), null);
    await store.updateWorkspaceManager("a", { notificationsEnabled: true });
    await store.recordSessionTurn({ id: "user-turn", sessionId: a.sessionId, userInput: "Help", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    assert.equal(await store.queueWorkspaceManagerEvents("a"), null);
    await store.updateSessionTurn({ id: "user-turn", agentResponse: "Done", tokenIn: 0, tokenOut: 0, status: "done" });
    const [batch, concurrent] = await Promise.all([store.queueWorkspaceManagerEvents("a"), store.queueWorkspaceManagerEvents("a")]);
    assert.ok(batch);
    assert.equal(concurrent, null);
    assert.deepEqual(await store.workspaceManagerActivityTurns(a.sessionId), [batch.turnId]);
    const turn = await store.getSessionTurn(batch.turnId);
    assert.match(turn!.userInput, /event-a/);
    assert.match(turn!.userInput, /process/);
    assert.equal(turn!.pendingReason, "queued");
    assert.equal((await store.workspaceManagerSnapshot("a")).pendingEvents, 0);
    const context = workspaceManagerContext(await store.workspaceManagerSnapshot("a"), { processes: [] });
    assert.match(context, /ordinary session history is your memory/);
    assert.match(context, /tx_task_a/);
    assert.doesNotMatch(context, /tx_task_b/);
    await store.close();
    store = new SessionStore(path);
    await store.ready();
    await store.recordWorkspaceManagerEvent(event);
    assert.equal(await store.queueWorkspaceManagerEvents("a"), null);
    assert.equal((await store.listSessionTurns(a.sessionId)).length, 2);
    assert.equal((await store.getWorkspaceManager("a"))!.sessionId, a.sessionId);
  } finally { await store.close(); }
});

test("legacy manager inbox migrates without losing history and delivers sessionless process events", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-migration-"));
  const path = resolve(root, "test.postgres");
  let store = new SessionStore(path);
  await store.ready();
  await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
  const manager = await store.ensureWorkspaceManager("a");
  await store.recordSessionTurn({ id: "original", sessionId: manager.sessionId, userInput: "Remember this", agentResponse: "Remembered", status: "done", tokenIn: 0, tokenOut: 0 });
  await store.close();
  const connection = await openPostgresSessionConnection(undefined, postgresSchemaFromStoreId(path));
  try {
    await connection.run("ALTER TABLE workspace_manager_event ALTER COLUMN session_id SET NOT NULL");
    await connection.run("ALTER TABLE workspace_manager_event ALTER COLUMN turn_id SET NOT NULL");
  } finally { await connection.close(); }
  store = new SessionStore(path);
  await store.ready();
  try {
    assert.equal((await store.ensureWorkspaceManager("a")).sessionId, manager.sessionId);
    await store.recordWorkspaceManagerEvent({ id: "process-after-upgrade", workspaceId: "a", sessionId: null, turnId: null,
      type: "process.exited", summary: "Expected verification process exit", created: new Date(Date.now() + 1).toISOString() });
    const batch = await store.queueWorkspaceManagerEvents("a");
    assert.ok(batch);
    assert.match((await store.getSessionTurn(batch.turnId))!.userInput, /process-after-upgrade/);
    assert.equal((await store.getSessionTurn("original"))!.agentResponse, "Remembered");
  } finally { await store.close(); }
});

test("manager actions stay within workspace, stop pending work first, and silent notes stay in normal history", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-route-test-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const service = new WorkspaceManagerService(store, { schedule: async () => undefined,
    platform: async () => ({ approvals: [] }), post: async (path, body) => { posts.push({ path, body }); return { ok: true }; } });
  const app = express();
  app.use(express.json()); app.use("/manager", service.router());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/manager`;
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
    await store.upsertWorkspace({ id: "b", name: "B", cwd: root, codexHome: root });
    const manager = await store.ensureWorkspaceManager("a");
    await store.upsertSession({ id: "tx_a", workspaceId: "a", cwd: root, title: "Build" });
    await store.upsertSession({ id: "tx_b", workspaceId: "b", cwd: root, title: "Other" });
    assert.equal((await post(`/${manager.sessionId}/action`, { action: "prompt", sessionId: "tx_b", message: "bad", requestId: "x" })).status, 403);
    assert.equal((await post("/tx_a/action", { action: "status" })).status, 403);
    assert.equal((await post(`/${manager.sessionId}/action`, { action: "inspect", sessionId: manager.sessionId })).status, 200);
    await store.recordSessionTurn({ id: "running", sessionId: "tx_a", userInput: "Work", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    await store.recordSessionTurn({ id: "queued", sessionId: "tx_a", userInput: "Next", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" });
    assert.equal((await post(`/${manager.sessionId}/action`, { action: "stop", sessionId: "tx_a" })).status, 200);
    assert.deepEqual(posts.map(item => item.body.turnId), ["queued", "running"]);
    const create = { action: "create", title: "New task", message: "A self-contained brief", requestId: "create-1", cwd: root };
    const created = await post(`/${manager.sessionId}/action`, create);
    assert.equal(created.status, 200);
    const unverified = await created.json();
    assert.equal(unverified.execution.state, "unknown");
    assert.equal(unverified.started, false, "an accepted response without turn evidence cannot confirm a start");
    assert.equal(posts.at(-1)?.body.parentSessionId, manager.sessionId);
    assert.equal((await post(`/${manager.sessionId}/action`, { ...create, requestId: "create-2", parentSessionId: "tx_a" })).status, 200);
    assert.deepEqual(posts.at(-1), { path: "/api/session-tasks", body: {
      parentSessionId: "tx_a", sourceSessionId: manager.sessionId, prompt: create.message, title: create.title,
      cwd: root, managerRequestId: "create-2", startImmediately: true, approvalPolicy: await store.resolveApprovalPolicy(manager.sessionId)
    } });
    const count = posts.length;
    assert.equal((await post(`/${manager.sessionId}/action`, { ...create, parentSessionId: "tx_b" })).status, 403);
    assert.equal((await post(`/${manager.sessionId}/action`, { ...create, parentSessionId: "missing" })).status, 403);
    assert.equal(posts.length, count);
    const attachments = [{ name: "brief.txt", type: "text/plain", dataUrl: "data:text/plain;base64,bWFuZ28=" }];
    assert.equal((await post("/messages", { workspaceId: "a", turnId: "upload-turn", attachments, model: "gpt-6-astra", effort: "low" })).status, 200);
    assert.deepEqual(posts.at(-1)?.body.attachments, attachments);
    assert.equal(posts.at(-1)?.body.model, "gpt-6-luna");
    assert.equal(posts.at(-1)?.body.modelReasoningEffort, "max");
    assert.equal(posts.at(-1)?.body.autoModel, false);
    const prefs = await store.getSessionModelPreferences(manager.sessionId);
    assert.equal(prefs.selectedModel, "gpt-6-luna");
    assert.equal(prefs.selectedEffort, "max");
    await store.recordWorkspaceManagerEvent({ id: "activity", workspaceId: "a", sessionId: "tx_a", turnId: "running", type: "task.started", summary: "Started", created: new Date(Date.now() + 1).toISOString() });
    const batch = await store.queueWorkspaceManagerEvents("a");
    assert.ok(batch);
    await store.updateSessionTurn({ id: batch.turnId, status: "done", agentResponse: "[workspace-note] Expected start, nothing needed.", tokenIn: 0, tokenOut: 0 });
    const quiet = await (await fetch(`${url}/conversation?workspaceId=a`)).json();
    assert.equal(quiet.turns.length, 0);
    assert.equal((await store.listSessionTurns(manager.sessionId)).length, 1);
    await store.updateSessionTurn({ id: batch.turnId, status: "done", agentResponse: "The build failed; I need your decision.", tokenIn: 0, tokenOut: 0 });
    const report = await (await fetch(`${url}/conversation?workspaceId=a`)).json();
    assert.equal(report.turns[0].userInput, null);
    assert.match(report.turns[0].agentResponse, /need your decision/);
  } finally { await new Promise<void>(done => server.close(() => done())); await store.close(); }
});

test("dashboard status reports active turn metrics from persisted runner and file records", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-dashboard-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
    await store.ensureWorkspaceManager("a");
    await store.upsertSession({ id: "task", workspaceId: "a", cwd: root, title: "Active build" });
    await store.recordSessionTurn({ id: "first", sessionId: "task", userInput: "Initial", agentResponse: "Done",
      tokenIn: 0, tokenOut: 0, status: "done" });
    await store.recordSessionTurnEvent({ id: "earlier-file", turnId: "first", sessionId: "task", eventName: "item",
      payload: { id: "earlier-file", itemType: "file_change", eventType: "item.completed",
        status: "completed", changes: [{ path: "src/earlier.ts" }] } });
    await store.recordSessionTurn({ id: "active", sessionId: "task", userInput: "Continue", agentResponse: "",
      tokenIn: 0, tokenOut: 0, status: "running", requestMetadata: { model: "gpt-6-sol" } });
    await store.markSessionTurnRunning({ id: "active", runnerPid: process.pid, runnerLogPath: "/tmp/dashboard-runner.ndjson" });
    await store.recordSessionTurn({ id: "waiting", sessionId: "task", userInput: "Next", agentResponse: "",
      tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" });
    for (const [id, status, changes] of [
      ["saved", "completed", [{ path: "src/a.ts" }, { path: "src/b.ts" }]],
      ["failed", "failed", [{ path: "src/not-updated.ts" }]]
    ] as const) await store.recordSessionTurnEvent({ id, turnId: "active", sessionId: "task", eventName: "item",
      payload: { id, itemType: "file_change", eventType: "item.completed", status, changes } });
    const snapshot = await store.workspaceManagerSnapshot("a");
    const task = snapshot.tasks.find(item => item.sessionId === "task");
    assert.equal(snapshot.runningTasks, 1);
    assert.equal(snapshot.pendingTasks, 0, "pendingTasks counts tasks whose selected turn is queued");
    assert.equal(task?.status, "running");
    assert.equal(task?.turnNumber, 2);
    assert.equal(task?.queuedTurns, 1);
    assert.equal(task?.updatedFiles, 3, "unique successful edits across all turns count toward the task");
    assert.equal(task?.runningModel, "gpt-6-sol (requested)");
    assert.ok(task?.runningSince && Number.isFinite(Date.parse(task.runningSince)));
    await store.recordTokenUsage([{ id: "dashboard-model", usageType: "agent", source: "native_token_count",
      sessionId: "task", turnId: "active", model: "gpt-6-luna" }]);
    assert.equal((await store.workspaceManagerSnapshot("a")).tasks.find(item => item.sessionId === "task")?.runningModel,
      "gpt-6-luna", "recorded runner model takes priority over the requested model");
  } finally { await store.close(); }
});

test("manager origin survives a different hierarchy parent without changing session context", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-origin-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
    await store.upsertWorkspace({ id: "b", name: "B", cwd: root, codexHome: root });
    const manager = await store.ensureWorkspaceManager("a");
    const other = await store.ensureWorkspaceManager("b");
    await store.upsertSession({ id: "parent", workspaceId: "a", cwd: root, threadId: "parent-thread", title: "Parent" });
    await store.upsertSession({ id: "child", workspaceId: "a", cwd: root, threadId: "child-thread", title: "Child", parentSessionId: "parent" });
    await store.recordSessionTurn({ id: "child-turn", sessionId: "child", userInput: "Child context", agentResponse: "Child result", status: "done", tokenIn: 0, tokenOut: 0 });
    await store.setSessionModelPreferences("child", { selectedModel: "gpt-6-sol", selectedEffort: "high" });
    await store.setSessionTaskManager("child", manager.sessionId);
    await store.setSessionTaskManager("child", manager.sessionId);
    const retry = await store.upsertSession({ id: "child", workspaceId: "a", cwd: root, threadId: null, title: "Retry", parentSessionId: manager.sessionId }, { createOnly: true });
    assert.equal(retry.parentSessionId, "parent");
    assert.equal(retry.threadId, "child-thread");
    assert.equal((await store.getSessionTaskManager("child"))?.sessionId, manager.sessionId);
    await assert.rejects(store.setSessionTaskManager("child", other.sessionId), /same workspace/);
    const child = await store.getSession("child");
    assert.equal(child?.parentSessionId, "parent");
    assert.equal(child?.threadId, "child-thread");
    assert.equal((await store.getSessionTurn("child-turn"))?.agentResponse, "Child result");
    assert.equal((await store.getSessionModelPreferences("child")).selectedModel, "gpt-6-sol");
    assert.equal(await store.getSessionWorkspaceManager("child"), null);
    await store.upsertSession({ id: "legacy-child", workspaceId: "a", cwd: root, title: "Legacy", parentSessionId: manager.sessionId });
    assert.equal((await store.getSessionTaskManager("legacy-child"))?.sessionId, manager.sessionId);
    assert.equal(await store.getSessionTaskManager("parent"), null);
  } finally { await store.close(); }
});

test("clearing a manager atomically replaces it, archives history and retains workspace routing", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "workspace-manager-reset-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  let bootstrapAvailable = true;
  const service = new WorkspaceManagerService(store, { schedule: async () => undefined,
    platform: async () => {
      if (!bootstrapAvailable) throw new Error("Platform context unavailable");
      return { projects: [root] };
    }, post: async () => ({ ok: true }) });
  const app = express();
  app.use(express.json()); app.use("/manager", service.router());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/manager`;
  const reset = (sessionId: string) => fetch(`${url}/reset`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "a", expectedSessionId: sessionId }) });
  try {
    await store.upsertWorkspace({ id: "a", name: "A", cwd: root, codexHome: root });
    await store.upsertWorkspace({ id: "b", name: "B", cwd: root, codexHome: root });
    const old = await store.ensureWorkspaceManager("a");
    const other = await store.ensureWorkspaceManager("b");
    await store.recordSessionTurn({ id: "old-history", sessionId: old.sessionId, userInput: "Keep this",
      agentResponse: "Saved", status: "done", tokenIn: 0, tokenOut: 0 });
    await store.upsertSession({ id: "owned-task", workspaceId: "a", cwd: root, title: "Owned",
      parentSessionId: old.sessionId });
    await store.setSessionTaskManager("owned-task", old.sessionId);
    await store.resolveApprovalPolicy(old.sessionId, undefined, "on-request");
    await store.updateWorkspaceManager("a", { notificationsEnabled: false });
    await store.recordWorkspaceManagerEvent({ id: "pending-reset-event", workspaceId: "a",
      sessionId: "owned-task", turnId: null, type: "task.started", summary: "Started",
      created: new Date(Date.now() + 1000).toISOString() });

    bootstrapAvailable = false;
    assert.equal((await reset(old.sessionId)).status, 400);
    assert.equal((await store.getWorkspaceManager("a"))?.sessionId, old.sessionId);
    assert.equal((await store.listWorkspaceManagerArchives("a")).length, 0);
    bootstrapAvailable = true;
    await store.recordSessionTurn({ id: "busy-manager", sessionId: old.sessionId, userInput: "Working",
      agentResponse: "", status: "running", tokenIn: 0, tokenOut: 0 });
    assert.equal((await reset(old.sessionId)).status, 409);
    assert.equal((await store.getWorkspaceManager("a"))?.sessionId, old.sessionId);
    await store.updateSessionTurn({ id: "busy-manager", agentResponse: "Done", status: "done", tokenIn: 0, tokenOut: 0 });

    const response = await reset(old.sessionId);
    assert.equal(response.status, 200, await response.clone().text());
    const replaced = await response.json();
    const fresh = replaced.manager;
    assert.notEqual(fresh.sessionId, old.sessionId);
    assert.equal(replaced.archivedSessionId, old.sessionId);
    assert.equal(fresh.notificationsEnabled, false);
    assert.equal((await store.getWorkspaceManager("a"))?.sessionId, fresh.sessionId);
    assert.equal((await store.getWorkspaceManager("b"))?.sessionId, other.sessionId);
    assert.equal(await store.getSessionWorkspaceManager(old.sessionId), null);
    assert.equal(await store.isArchivedWorkspaceManagerSession(old.sessionId), true);
    assert.equal((await store.listSessionTurns(old.sessionId)).length, 2);
    assert.equal((await store.listSessionTurns(fresh.sessionId)).length, 0);
    assert.equal((await store.listSessionsPage("a")).sessions.some(session => session.id === old.sessionId), false);
    assert.equal((await store.workspaceManagerSnapshot("a")).tasks.some(task => task.sessionId === old.sessionId), false);
    assert.equal((await store.getSessionTaskManager("owned-task"))?.sessionId, fresh.sessionId);
    assert.equal((await store.getSession("owned-task"))?.parentSessionId, old.sessionId);
    assert.equal(await store.resolveApprovalPolicy(fresh.sessionId), "on-request");
    assert.equal((await store.getSessionModelPreferences(fresh.sessionId)).selectedModel, "gpt-6-luna");
    assert.equal((await store.getSessionModelPreferences(fresh.sessionId)).selectedEffort, "max");
    assert.equal((await store.getSessionAutoModel(fresh.sessionId)).enabled, false);
    const bootstrap = await service.context("a");
    assert.ok(bootstrap.includes(WORKSPACE_MANAGER_INSTRUCTIONS));
    assert.ok(bootstrap.includes(WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS));
    assert.match(bootstrap, new RegExp(fresh.sessionId));
    assert.equal((await reset(old.sessionId)).status, 409, "a stale clear cannot create another manager");
    assert.equal((await store.listWorkspaceManagerArchives("a")).length, 1);
    assert.equal((await (await fetch(`${url}/archive?workspaceId=a`)).json()).archivedManagers[0].sessionId, old.sessionId);
    assert.equal((await fetch(`${url}/${old.sessionId}/action`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }) })).status, 403);
    await store.updateWorkspaceManager("a", { notificationsEnabled: true });
    const delivered = await store.queueWorkspaceManagerEvents("a");
    assert.equal(delivered?.sessionId, fresh.sessionId);
    assert.equal((await store.getSessionTurn(delivered!.turnId))?.sessionId, fresh.sessionId);
  } finally { await new Promise<void>(done => server.close(() => done())); await store.close(); }
});
