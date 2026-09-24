import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { SessionStore } from "./sessionStore";
import { WorkspaceManagerService, WORKSPACE_MANAGER_INSTRUCTIONS } from "./workspaceManager";
import { WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS } from "./workspaceManagerRouting";
import { WORKSPACE_MANAGER_TOOLS } from "./workspaceManagerTools";

test("manager startup policy follows demand, project, clarification, known-thread, search, fork and create order", () => {
  assert.ok(WORKSPACE_MANAGER_INSTRUCTIONS.includes(WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS));
  // These are policy-contract assertions, not an LLM behavior simulation.
  const policy = WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS;
  const ordered = ["1. Is this an actionable request?", "2. Establish the project and workspace",
    "3. Confirm the requirement", "4. Choose the thread in this order", "5. If a suitable thread has more than 15",
    "6. Only if no suitable thread exists", "7. Preserve the canonical request", "8. Verify dispatch"];
  const positions = ordered.map(step => policy.indexOf(step));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(policy, /「manager做事順序：是需求？》項目》確認需求（問清楚）》揀thread實作，優先：\n1\. context中已知thread\n2\. 查找已有thread\n如現有thread已很長（來回超過15T\)，帶fork badge要現thread fork\n都沒有就開新」/);
  assert.match(policy, /An attachment without a clear actionable request is context only/);
  assert.match(policy, /explicit 'do not create a task'/);
  assert.match(policy, /candidate thread belongs to the intended project/);
  assert.match(policy, /If multiple plausible projects or workspaces would change where work goes, ask a focused question/);
  assert.match(policy, /First check a relevant thread already explicitly known in current manager context/);
  assert.match(policy, /use it without searching again/);
  assert.match(policy, /If no suitable thread is already known, call workspace_search_tasks/);
  assert.match(policy, /including completed and older work/);
  assert.match(policy, /completedRoundTrips > 15/);
  assert.match(policy, /same Context Fork\/Fork badge handoff as the ordinary composer/);
  assert.match(policy, /Only if no suitable thread exists, use workspace_create_task/);
  assert.match(policy, /original user wording verbatim as 'Canonical user request'/);
  assert.match(policy, /carry the canonical original wording verbatim into its child handoff/);
  assert.match(policy, /inspect the handoff result and resulting child session separately/);
  const tool = (name: string) => WORKSPACE_MANAGER_TOOLS.find(item => item.name === name)!;
  assert.match(tool("workspace_search_tasks").description, /When no suitable thread is already known/);
  assert.match(tool("workspace_prompt_task").description, /at most 15 completed user\/agent round trips/);
  assert.match(tool("workspace_fork_task").description, /more than 15 completed user\/agent round trips/);
  assert.match(tool("workspace_create_task").description, /Only when no suitable context-known or searched thread exists/);
  assert.ok(tool("workspace_create_task").inputSchema.properties.parentSessionId);
  assert.ok(tool("workspace_inspect_task").inputSchema.properties.turnId);
});

test("persistent manager policy clarifies material ambiguity, preserves user wording and supersedes wrong assumptions", () => {
  const policy = WORKSPACE_MANAGER_INSTRUCTIONS;
  assert.match(policy, /ask the user a focused clarification question before dispatching or executing dependent actions/);
  assert.match(policy, /Clear, directly actionable requests do not need extra questions/);
  assert.match(policy, /uncertainty about a technical cause are not by themselves ambiguity about the user's intent/);
  assert.match(policy, /original user wording verbatim as 'Canonical user request'/);
  assert.match(policy, /Manager interpretation \(may be wrong\)/);
  assert.match(policy, /first verify the original request and supplied context/);
  assert.match(policy, /promptly deliver the verbatim correction to affected work/);
  assert.match(policy, /explicitly supersede the old assumption/);
  assert.match(policy, /never duplicate a correction already received by its owning task/);
  assert.match(policy, /report queued rather than assuming a child exists/);
  assert.match(policy, /'彈左去外面'/);
  assert.match(policy, /'我指既係layout 彈左出去'/);
  assert.match(policy, /do not invent a file-picker task/);
  assert.match(policy, /This clarified request is actionable and does not need the same question again/);
  for (const name of ["workspace_create_task", "workspace_prompt_task", "workspace_fork_task"]) {
    const tool = WORKSPACE_MANAGER_TOOLS.find(item => item.name === name)!;
    const message = tool.inputSchema.properties.message as { description: string };
    assert.match(message.description, /original words verbatim as the canonical request/);
    assert.match(message.description, /interpretation of meaning\/cause as possibly wrong/);
    assert.match(message.description, /explicitly supersede the old assumption/);
  }
});

async function managerFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "manager-routing-"));
  const store = new SessionStore(resolve(root, "test.postgres"));
  await store.ready();
  t.after(() => store.close());
  await store.upsertWorkspace({ id: "routing", name: "Routing", cwd: root, codexHome: root });
  const manager = await store.ensureWorkspaceManager("routing");
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const service = new WorkspaceManagerService(store, {
    schedule: async () => undefined, platform: async () => ({ projects: [root] }),
    post: async (path, body) => {
      posts.push({ path, body });
      const create = path === "/api/session-tasks";
      const sessionId = create ? `task-${body.managerRequestId}` : String(body.sessionId);
      const turnId = create ? `turn-${body.managerRequestId}` : String(body.turnId);
      if (create) await store.upsertSession({ id: sessionId, workspaceId: "routing", cwd: root,
        parentSessionId: String(body.parentSessionId), title: String(body.title) }, { createOnly: true });
      if (!await store.getSessionTurn(turnId)) await store.recordSessionTurn({
        id: turnId, sessionId, userInput: String(body.prompt ?? body.message), agentResponse: "Queued.",
        status: "todo", pendingReason: "queued", tokenIn: 0, tokenOut: 0
      });
      // Deliberately emulate the upstream API's misleading legacy start flag.
      return { ok: true, sessionId, turnId, started: true };
    }
  });
  const app = express();
  app.use(express.json());
  app.use("/manager", service.router());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const action = async (body: Record<string, unknown>, expectedStatus = 200) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/manager/${manager.sessionId}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal(response.status, expectedStatus, await response.clone().text());
    return response.json();
  };
  return { root, store, manager, service, posts, action, baseUrl: "http://127.0.0.1:" + address.port + "/manager" };
}

test("read-only and attachment-only manager messages stay in the manager session without automatic task creation", async t => {
  const { manager, store, posts, baseUrl } = await managerFixture(t);
  const status = await fetch(baseUrl + "/?workspaceId=routing");
  assert.equal(status.status, 200);
  assert.equal(posts.length, 0);
  const response = await fetch(baseUrl + "/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "routing", turnId: "attachment-only",
      attachments: [{ name: "screen.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }] })
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/pending-turns");
  assert.equal(posts[0].body.sessionId, manager.sessionId);
  assert.match(String(posts[0].body.message), /Review the attached file/);
  assert.equal((await store.listSessions("routing")).length, 1);
  assert.match(WORKSPACE_MANAGER_INSTRUCTIONS, /An attachment without a clear actionable request is context only/);
});

test("routing tools find older completed results outside the startup snapshot and preserve separate dispatch targets", async t => {
  const { root, store, manager, service, posts, action } = await managerFixture(t);
  await store.upsertSession({ id: "old-export", workspaceId: "routing", cwd: root, threadId: "export-thread", title: "Report download" });
  await store.recordSessionTurn({ id: "export-result", sessionId: "old-export", userInput: "Implement CSV export",
    agentResponse: "CSV export implemented; quoting checks passed.", status: "done", tokenIn: 0, tokenOut: 0 });
  for (let i = 0; i < 45; i++) {
    await store.upsertSession({ id: `recent-${i}`, workspaceId: "routing", cwd: root, title: `Other work ${i}` });
    await store.recordSessionTurn({ id: `recent-result-${i}`, sessionId: `recent-${i}`, userInput: `Other objective ${i}`,
      agentResponse: "Completed", status: "done", tokenIn: 0, tokenOut: 0 });
  }
  await store.upsertSession({ id: "active-ui", workspaceId: "routing", cwd: root, title: "Dashboard UI" });
  await store.recordSessionTurn({ id: "dashboard-turn", sessionId: "active-ui", userInput: "Redesign dashboard UI",
    agentResponse: "Working", status: "running", tokenIn: 0, tokenOut: 0 });
  await store.upsertWorkspace({ id: "other", name: "Other", cwd: root, codexHome: root });
  await store.upsertSession({ id: "outside", workspaceId: "other", cwd: root, title: "CSV export" });
  await store.recordSessionTurn({ id: "outside-result", sessionId: "outside", userInput: "CSV export",
    agentResponse: "Different workspace result", status: "done", tokenIn: 0, tokenOut: 0 });

  const context = await service.context("routing");
  assert.ok(context.includes(WORKSPACE_MANAGER_ROUTING_INSTRUCTIONS));
  assert.equal(context.includes('"sessionId":"old-export"'), false, "old work must be outside the bounded snapshot fixture");
  const history = await action({ action: "search", query: "CSV" });
  assert.deepEqual(history.results.map((item: any) => item.session.id), ["old-export"]);
  assert.match(history.results[0].turn.agentResponse, /quoting checks passed/);
  const inspected = await action({ action: "inspect", sessionId: "old-export" });
  assert.match(inspected.turns[0].userPrompt, /Implement CSV export/);
  assert.match(inspected.turns[0].conclusion, /quoting checks passed/);

  // Exercise the tool sequence for a mixed request after inspecting history.
  // Semantic selection belongs to the injected policy, not a keyword router.
  const followup = await action({ action: "prompt", sessionId: "old-export", requestId: "export-fix",
    message: "Correct the CSV export quoting regression and verify the original export acceptance checks." });
  assert.equal(followup.sessionId, "old-export");
  assert.equal(followup.started, false);
  assert.equal((await action({ action: "search", query: "notification" })).results.length, 0);
  const separate = await action({ action: "create", requestId: "notification", title: "Export notification feature", cwd: root,
    message: "Add opt-in notification delivery for completed exports. This is a separate objective; verify delivery and preferences.",
    parentSessionId: "old-export" });
  assert.notEqual(separate.sessionId, followup.sessionId);
  assert.equal(posts.at(-1)?.body.parentSessionId, "old-export");
  assert.equal(posts.at(-1)?.body.sourceSessionId, manager.sessionId);
  assert.equal((await store.getSession(separate.sessionId))?.threadId, null);
  assert.equal((await store.getSession("old-export"))?.threadId, "export-thread");
  assert.equal((await store.listSessionTurns("active-ui")).length, 1);
  assert.equal((await store.getSessionTurn("export-result"))?.agentResponse, "CSV export implemented; quoting checks passed.");
  assert.ok(posts.every(post => post.body.sessionId !== "active-ui"));
  const defaultParent = await action({ action: "create", requestId: "independent", title: "Independent project", cwd: root,
    message: "A distinct objective with no suitable existing parent." });
  assert.equal((await store.getSession(defaultParent.sessionId))?.parentSessionId, manager.sessionId);
});

test("manager Fork badge handoff requires over 15 turns, preserves the original thread context and is idempotent", async t => {
  const { root, store, posts, action } = await managerFixture(t);
  await store.upsertSession({ id: "long-task", workspaceId: "routing", cwd: root, title: "Long export task" });
  for (let i = 0; i < 15; i++) await store.recordSessionTurn({
    id: "long-" + i, sessionId: "long-task", userInput: "User request " + i,
    agentResponse: "Agent result " + i, status: "done", tokenIn: 0, tokenOut: 0
  });
  const inspected = await action({ action: "inspect", sessionId: "long-task" });
  assert.equal(inspected.turnPage.total, 15, "each saved turn is one user/agent round trip");
  assert.equal(inspected.completedRoundTrips, 15);
  const original = "Canonical user request:「修正呢個 export」\nManager interpretation (may be wrong): CSV quoting. First verify original intent and this thread's context.";
  const fork = { action: "fork", sessionId: "long-task", requestId: "long-export-followup", message: original };
  await store.recordSessionTurn({ id: "queued-not-a-roundtrip", sessionId: "long-task", userInput: "Queued prompt",
    agentResponse: "Queued", status: "todo", pendingReason: "queued", tokenIn: 0, tokenOut: 0 });
  assert.equal((await action({ action: "inspect", sessionId: "long-task" })).completedRoundTrips, 15);
  await action(fork, 409);
  assert.equal(posts.length, 0, "the 15-turn boundary cannot dispatch a Fork badge");
  await store.recordSessionTurn({ id: "long-15", sessionId: "long-task", userInput: "User request 15",
    agentResponse: "Agent result 15", status: "done", tokenIn: 0, tokenOut: 0 });
  assert.equal((await action({ action: "inspect", sessionId: "long-task" })).completedRoundTrips, 16);
  const handoff = await action(fork);
  assert.equal(handoff.sessionId, "long-task");
  assert.equal(handoff.contextForkHandoff, true);
  assert.equal(handoff.childSessionId, null, "a queued parent handoff is not a started child");
  assert.equal(handoff.execution.state, "queued");
  assert.equal(handoff.started, false);
  assert.equal(posts.at(-1)?.path, "/api/pending-turns");
  assert.equal(posts.at(-1)?.body.contextFork, true);
  assert.equal(posts.at(-1)?.body.backgroundTask, true);
  assert.equal(posts.at(-1)?.body.message, original);
  assert.equal((await store.getSessionTurn(handoff.turnId))?.sessionId, "long-task");
  const retry = await action(fork);
  assert.equal(retry.turnId, handoff.turnId);
  assert.equal((await store.listSessionTurns("long-task")).length, 18);
  assert.equal((await store.listSessions("routing")).filter(session => session.parentSessionId === "long-task").length, 0);
});

test("manager dispatch verifies actual runner state, including queued retries and runner errors", async t => {
  const { root, store, action } = await managerFixture(t);
  const create = { action: "create", requestId: "execution", title: "Execution check", cwd: root, message: "Verify execution." };
  const queued = await action(create);
  assert.equal(queued.started, false);
  assert.equal(queued.execution.state, "queued");
  const { sessionId, turnId } = queued;
  const update = (status: "running" | "todo" | "done", fields = {}) => store.updateSessionTurn({
    id: turnId, status, agentResponse: "Attempt state", tokenIn: 0, tokenOut: 0, pendingReason: null, ...fields
  });
  await update("running");
  const starting = await action(create);
  assert.equal(starting.execution.state, "starting");
  assert.equal(starting.started, false, "claiming a turn does not prove a runner was spawned");
  await store.markSessionTurnRunning({ id: turnId, runnerPid: 12345, runnerLogPath: resolve(root, "fake-runner.ndjson") });
  const running = await action(create);
  assert.equal(running.execution.state, "running");
  assert.equal(running.started, true);
  assert.ok(running.execution.runnerStartedAt);

  for (const pendingReason of ["rate_limit", "auth"] as const) {
    await update("todo", { pendingReason, runnerExitCode: pendingReason === "auth" ? 1 : 0 });
    const pending = await action(create);
    assert.equal(pending.execution.state, "queued");
    assert.equal(pending.execution.pendingReason, pendingReason);
    assert.equal(pending.started, false, "an earlier attempt's start is not current execution");
  }
  await update("done", { runnerExitCode: 1, agentResponse: "Codex error: runner could not start." });
  const failed = await action(create);
  assert.equal(failed.execution.state, "failed");
  assert.equal(failed.started, false);
  assert.match(failed.execution.detail, /could not start/);
  // A verification must find the dispatched turn even beyond the recent page.
  for (let i = 0; i < 7; i++) await store.recordSessionTurn({ id: `later-${i}`, sessionId,
    userInput: "Later", agentResponse: "Later result", status: "done", tokenIn: 0, tokenOut: 0 });
  const exact = await action({ action: "inspect", sessionId, turnId, offset: 999 });
  assert.deepEqual(exact.turns.map((turn: any) => turn.id), [turnId]);
  assert.equal(exact.turns[0].execution.state, "failed");
  assert.equal(exact.turns[0].execution.runnerExitCode, 1);
  await update("done", { runnerExitCode: 0, agentResponse: "Checks passed." });
  assert.equal((await action(create)).execution.state, "completed");
  await update("todo", { pendingReason: "stopped", runnerExitCode: 0 });
  const stopped = await action(create);
  assert.equal(stopped.execution.state, "stopped");
  assert.equal(stopped.started, false);
  await store.upsertSession({ id: "different-task", workspaceId: "routing", cwd: root, title: "Different task" });
  await action({ action: "inspect", sessionId: "different-task", turnId }, 404);
  assert.equal((await store.listSessions("routing")).filter(session => session.id === sessionId).length, 1);
});

test("manager tools preserve canonical wording and an explicit superseding correction in the affected task", async t => {
  const { root, store, posts, action } = await managerFixture(t);
  const original = "Canonical user request:「彈左去外面」\nConfirmed clarification:「我指既係layout 彈左出去」\nManager interpretation (may be wrong): Workspace chat viewport overflow. Verify the original request and browser context before implementation.";
  const created = await action({ action: "create", requestId: "canonical", title: "Workspace chat layout", cwd: root, message: original });
  assert.equal(posts[0].body.prompt, original);
  assert.equal((await store.getSessionTurn(created.turnId))?.userInput, original);
  const correction = "Canonical user request:「彈左去外面」\nUser correction:「我指既係layout 彈左出去」\nThis supersedes the file-picker assumption and the conflicting brief. Check Workspace chat viewport overflow; do not investigate file-picker behavior. Manager interpretation (may be wrong): the composer may exceed the viewport. First verify the original wording and context.";
  const followup = await action({ action: "prompt", sessionId: created.sessionId, requestId: "canonical-correction", message: correction });
  assert.equal(followup.sessionId, created.sessionId);
  assert.equal(posts.at(-1)?.path, "/api/pending-turns");
  assert.equal(posts.at(-1)?.body.message, correction);
  assert.equal((await store.getSessionTurn(followup.turnId))?.userInput, correction);
  assert.equal(followup.execution.state, "queued");
  assert.equal(followup.started, false, "persisting the correction is not proof the worker has processed it");
  assert.equal(posts.filter(post => post.path === "/api/session-tasks").length, 1);
});

test("manager follow-ups carry the destination's model selection into the queued turn", async t => {
  const { root, store, manager, posts, action } = await managerFixture(t);
  await store.upsertSession({ id: "ordinary-task", workspaceId: "routing", cwd: root, title: "Existing task" });
  await store.setWorkspaceModelPreferences("routing", { selectedModel: "auto", selectedEffort: "high" });
  await action({ action: "prompt", sessionId: "ordinary-task", requestId: "ordinary-followup", message: "Continue the existing task." });
  assert.equal(posts.at(-1)?.body.model, "auto");
  assert.equal(posts.at(-1)?.body.modelReasoningEffort, "high");

  await store.upsertSession({ id: "managed-task", workspaceId: "routing", cwd: root, title: "Managed task" });
  await store.setSessionTaskManager("managed-task", manager.sessionId);
  await store.setSessionModelPreferences("managed-task", { selectedModel: "gpt-6-sol", selectedEffort: "max" });
  await action({ action: "prompt", sessionId: "managed-task", requestId: "managed-followup", message: "Continue the managed task." });
  assert.equal(posts.at(-1)?.body.model, "gpt-6-sol");
  assert.equal(posts.at(-1)?.body.modelReasoningEffort, "max");
});
