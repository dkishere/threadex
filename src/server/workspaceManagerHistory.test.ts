import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore";
import type { SessionDbConnection } from "./sessionDb";

test("manager history reads 50 visible turns at a time, pins live turns and survives inserts with tied timestamps", async t => {
  const root = await mkdtemp(join(tmpdir(), "manager-history-"));
  const store = new SessionStore(join(root, "test.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "manager", workspaceId: "default", cwd: root });
    const connection = await (store as unknown as { connectionPromise: Promise<SessionDbConnection> }).connectionPromise;
    await connection.run(`INSERT INTO session_turn (id, session_id, user_input, agent_response, status, token_in, token_out, created)
      SELECT 'turn-' || lpad(i::TEXT, 3, '0'), 'manager',
        CASE WHEN i < 75 THEN $largePrompt ELSE 'Recent prompt' END, 'Reply ' || i,
        CASE WHEN i = 0 THEN 'running' ELSE 'done' END, 0, 0, '2026-01-01'::TIMESTAMPTZ
      FROM generate_series(0, 124) AS i`, { largePrompt: "Old prompt ".repeat(20_000) });
    await connection.run(`INSERT INTO session_turn (id, session_id, user_input, agent_response, status, token_in, token_out, created)
      VALUES ('manager_silent', 'manager', 'Wake-up', E'\n\t [workspace-note] Internal note', 'done', 0, 0, '2026-01-02'),
        ('manager_visible', 'manager', 'Wake-up', 'Meaningful outcome', 'done', 0, 0, '2026-01-02'),
        ('manager_pending', 'manager', 'Wake-up', '', 'todo', 0, 0, '2026-01-02')`);

    const returnedPrompts: string[] = [];
    const run = connection.run.bind(connection);
    t.mock.method(connection, "run", async (...args: Parameters<SessionDbConnection["run"]>) => {
      const result = await run(...args);
      for (const row of await result.getRowObjectsJS()) if (typeof row.user_input === "string") returnedPrompts.push(row.user_input);
      return result;
    });
    const first = await store.listWorkspaceManagerTurnPage("manager");
    assert.equal(first.turns.length, 51, "50 visible turns plus the older pinned running turn");
    assert.equal(first.managerHistory.beforeTurnId, "turn-076", "an older pinned turn must not skip unrequested history");
    assert.equal(first.managerHistory.hasMore, true);
    assert.equal(first.turns[0].id, "turn-000");
    assert.ok(!first.turns.some(turn => turn.id === "manager_pending"));
    assert.ok(!first.turns.some(turn => turn.id === "manager_silent"));
    assert.equal(returnedPrompts.filter(prompt => prompt.startsWith("Old prompt")).length, 1, "only the pinned live turn may read an old prompt");

    await store.recordSessionTurn({ id: "new-turn", sessionId: "manager", userInput: "New request", agentResponse: "New reply", status: "done", tokenIn: 0, tokenOut: 0 });
    const second = await store.listWorkspaceManagerTurnPage("manager", first.managerHistory.beforeTurnId!);
    assert.equal(second.turns.length, 50);
    assert.equal(second.turns[0].id, "turn-026");
    assert.equal(second.turns.at(-1)!.id, "turn-075");
    const last = await store.listWorkspaceManagerTurnPage("manager", second.managerHistory.beforeTurnId!);
    assert.equal(last.turns.length, 26);
    assert.equal(last.managerHistory.hasMore, false);
    assert.equal(new Set([...first.turns, ...second.turns, ...last.turns].map(turn => turn.id)).size, 126);
    assert.equal((await store.listSessionTurns("manager")).length, 129, "raw history retains silent turns and the new insert");

    await store.updateSessionTurn({ id: "turn-000", agentResponse: "Final reply", status: "done", tokenIn: 0, tokenOut: 0 });
    const reconciled = await store.listWorkspaceManagerTurnPage("manager", undefined, "turn-000");
    assert.equal(reconciled.turns.find(turn => turn.id === "turn-000")?.status, "done", "a just-finished turn outside the latest page must still reconcile");
    await store.updateSessionTurn({ id: "manager_pending", agentResponse: "", status: "running", tokenIn: 0, tokenOut: 0 });
    assert.ok((await store.listWorkspaceManagerTurnPage("manager")).turns.some(turn => turn.id === "manager_pending"));
    await store.updateSessionTurn({ id: "manager_pending", agentResponse: "[workspace-note] Done silently", status: "done", tokenIn: 0, tokenOut: 0 });
    assert.ok(!(await store.listWorkspaceManagerTurnPage("manager")).turns.some(turn => turn.id === "manager_pending"));
    await store.upsertSession({ id: "other", workspaceId: "default", cwd: root });
    const foreign = await store.listWorkspaceManagerTurnPage("other", "turn-076");
    assert.deepEqual(foreign.turns, []);
    assert.equal(foreign.managerHistory.hasMore, false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("page detail reads scope tool payloads, diffs, approvals, instructions, steers and model selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "manager-page-details-"));
  const store = new SessionStore(join(root, "test.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "manager", workspaceId: "default", cwd: root });
    for (const turnId of ["old", "recent"]) {
      const event = (eventName: string, payload: unknown) => store.recordSessionTurnEvent({
        id: `${turnId}-${eventName}`, sessionId: "manager", turnId, eventName, payload, refreshRunnerHeartbeat: false
      });
      await event("item", { id: "tool", itemType: "command", eventType: "item.completed", status: "completed", command: turnId, output: "x".repeat(100_000) });
      await event("codex", { method: "turn/diff/updated", params: { turnId, diff: `diff --git a/${turnId}.ts b/${turnId}.ts\n--- a/${turnId}.ts\n+++ b/${turnId}.ts\n@@ -1 +1 @@\n-old\n+new` } });
      await event("developer_instructions", { developerInstructions: turnId });
      await event("steer", { id: `${turnId}-steer`, content: turnId });
      await event("auto_model.selected", { provider: "fallback", confidence: 0.8 });
      await event("approval.requested", { approvalId: `${turnId}-approval`, title: turnId, method: "item/commandExecution/requestApproval", params: {} });
    }
    const scopedReads = [
      store.listSessionLiveItems.bind(store), store.listSessionApprovalLiveItems.bind(store),
      store.listSessionDeveloperInstructions.bind(store), store.listSessionSteerMessages.bind(store), store.listSessionAutoModelProviders.bind(store)
    ];
    for (const read of scopedReads) {
      assert.deepEqual(Object.keys(await read("manager", ["recent"])), ["recent"]);
      assert.deepEqual(await read("manager", []), {});
      assert.deepEqual(Object.keys(await read("manager")).sort(), ["old", "recent"]);
    }
    const items = await store.listSessionLiveItems("manager", ["recent"]) as Record<string, Array<{ authoritative?: boolean; changes?: Array<{ path: string }> }>>;
    assert.deepEqual(items.recent.find(item => item.authoritative)?.changes?.map(change => change.path), ["recent.ts"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
