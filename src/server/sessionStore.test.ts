import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parseSessionListSearchTerms, SessionStore } from "./sessionStore.js";

test("default workspace migrates legacy codex home to workspace-specific home", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-default-home-test-"));
  const dbPath = resolve(root, "threadex.postgres");
  const previousCodexHome = process.env.CODEX_HOME;
  const previousDefaultWorkspaceCodexHome = process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME;
  try {
    process.env.CODEX_HOME = resolve(root, "legacy-codex-home");
    process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME = resolve(root, "default-workspace-codex-home");

    let store = new SessionStore(dbPath);
    try {
      await store.ready();
      await store.upsertWorkspace({
        id: "default",
        name: "Default",
        codexHome: process.env.CODEX_HOME,
        cwd: root
      });
    } finally {
      await store.close();
    }

    store = new SessionStore(dbPath);
    try {
      await store.ready();
      const workspace = await store.getWorkspace("default");
      assert.equal(workspace?.codexHome, process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME);
    } finally {
      await store.close();
    }
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousDefaultWorkspaceCodexHome === undefined) delete process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME;
    else process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME = previousDefaultWorkspaceCodexHome;
  }
});

test("workspace account removals survive a store restart", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-workspace-account-restart-test-"));
  const dbPath = resolve(root, "threadex.postgres");
  let store = new SessionStore(dbPath);
  await store.ready();

  const retained = await store.upsertAccount({ id: "account-retained", name: "Retained" });
  const removed = await store.upsertAccount({ id: "account-removed", name: "Removed" });
  await store.bindWorkspaceAccount("default", retained.id);
  await store.bindWorkspaceAccount("default", removed.id);
  await store.unbindWorkspaceAccount("default", removed.id);
  assert.deepEqual(await store.listWorkspaceAccountIds("default"), [retained.id]);
  await store.close();

  store = new SessionStore(dbPath);
  try {
    await store.ready();
    assert.deepEqual(await store.listWorkspaceAccountIds("default"), [retained.id]);
  } finally {
    await store.close();
  }
});

test("workspace load-balance selections survive a store restart", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-workspace-load-balance-restart-test-"));
  const dbPath = resolve(root, "threadex.postgres");
  let store = new SessionStore(dbPath);
  await store.ready();

  await store.setWorkspaceAutoLoadBalance("default", true);
  const selected = await store.upsertAccount({ id: "account-load-balanced", name: "Load balanced" });
  await store.switchAccount(selected.id, "default");
  assert.deepEqual(await store.listAutoLoadBalanceWorkspaceIds(), ["default"]);
  await store.close();

  store = new SessionStore(dbPath);
  try {
    await store.ready();
    assert.deepEqual(await store.listAutoLoadBalanceWorkspaceIds(), ["default"]);

    await store.setWorkspaceAutoLoadBalance("default", false);
    assert.deepEqual(await store.listAutoLoadBalanceWorkspaceIds(), []);
  } finally {
    await store.close();
  }
});

test("removing a load-balance candidate preserves the manually active account", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-workspace-account-active-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    const account = await store.upsertAccount({ id: "account-manual", name: "Manual" });
    await store.bindWorkspaceAccount("default", account.id);
    await store.switchAccount(account.id);

    await store.unbindWorkspaceAccount("default", account.id);

    assert.deepEqual(await store.listWorkspaceAccountIds("default"), []);
    assert.equal((await store.getActiveAccount())?.id, account.id);
  } finally {
    await store.close();
  }
});

test("deleting an account removes credentials, bindings, and active session references", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-account-delete-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({
      id: "workspace-two",
      name: "Workspace two",
      codexHome: resolve(root, "codex-two"),
      cwd: root
    });
    const account = await store.upsertAccount({ id: "account-delete", name: "Delete me" });
    await store.setAccountAuth(account.id, '{"OPENAI_API_KEY":"secret"}', null);
    await store.bindWorkspaceAccount("default", account.id);
    await store.bindWorkspaceAccount("workspace-two", account.id);
    await store.switchAccount(account.id, "default");
    await store.switchAccount(account.id, "workspace-two");
    await store.upsertSession({ id: "account-session", accountId: account.id });
    await store.recordSessionTurn({
      id: "queued-account-turn",
      sessionId: "account-session",
      accountId: account.id,
      accountName: account.name,
      userInput: "queued",
      agentResponse: "Queued",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo"
    });
    await store.recordSessionTurn({
      id: "completed-account-turn",
      sessionId: "account-session",
      accountId: account.id,
      accountName: account.name,
      userInput: "done",
      agentResponse: "Done",
      tokenIn: 1,
      tokenOut: 1,
      status: "done"
    });

    assert.equal(await store.deleteAccount(account.id), true);
    assert.equal(await store.deleteAccount(account.id), false);
    assert.equal(await store.getAccount(account.id), null);
    assert.equal(await store.getAccountAuth(account.id), null);
    assert.deepEqual(await store.listWorkspaceAccountIds("default"), []);
    assert.deepEqual(await store.listWorkspaceAccountIds("workspace-two"), []);
    assert.equal(await store.getActiveAccount("default"), null);
    assert.equal(await store.getActiveAccount("workspace-two"), null);
    assert.equal((await store.getSession("account-session"))?.accountId, null);
    assert.equal((await store.getSessionTurn("queued-account-turn"))?.accountId, null);
    assert.equal((await store.getSessionTurn("completed-account-turn"))?.accountId, account.id);
  } finally {
    await store.close();
  }
});

test("active account selection is restored per workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-workspace-active-account-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({
      id: "workspace-two",
      name: "Workspace two",
      codexHome: resolve(root, "codex-two"),
      cwd: root
    });
    const defaultAccount = await store.upsertAccount({ id: "account-default", name: "Default account" });
    const workspaceTwoAccount = await store.upsertAccount({ id: "account-workspace-two", name: "Workspace two account" });

    await store.switchAccount(defaultAccount.id);
    await store.switchWorkspace("workspace-two");
    assert.equal(await store.getActiveAccount(), null);
    await store.switchAccount(workspaceTwoAccount.id);

    await store.switchWorkspace("default");
    assert.equal((await store.getActiveAccount())?.id, defaultAccount.id);
    await store.switchWorkspace("workspace-two");
    assert.equal((await store.getActiveAccount())?.id, workspaceTwoAccount.id);
  } finally {
    await store.close();
  }
});

test("composer suggestion keywords are workspace-scoped and preserve their order", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "threadex-composer-keywords-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({ id: "workspace-two", name: "Workspace two", codexHome: resolve(root, "codex-two"), cwd: root });
    assert.deepEqual(
      await store.addComposerSuggestionKeywords("default", ["deploy", "Review PR", "deploy"]),
      ["deploy", "Review PR"]
    );
    assert.deepEqual(await store.addComposerSuggestionKeywords("workspace-two", ["triage"]), ["triage"]);
    assert.deepEqual(await store.listComposerSuggestionKeywords("default"), ["deploy", "Review PR"]);
    assert.deepEqual(await store.removeComposerSuggestionKeyword("default", "DEPLOY"), ["Review PR"]);
    assert.deepEqual(await store.replaceComposerSuggestionKeywords("default", ["release", "review PR"]), ["release", "review PR"]);
    assert.deepEqual(await store.listComposerSuggestionKeywords("workspace-two"), ["triage"]);
  } finally {
    await store.close();
  }
});

test("active session selection is restored per workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-workspace-active-session-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({
      id: "workspace-two",
      name: "Workspace two",
      codexHome: resolve(root, "codex-two"),
      cwd: root
    });
    await store.upsertSession({ id: "default-session", workspaceId: "default" });
    await store.upsertSession({ id: "workspace-two-session", workspaceId: "workspace-two" });

    await store.switchSession("default-session");
    assert.equal(await store.getActiveSessionId(), "default-session");

    await store.switchWorkspace("workspace-two");
    assert.equal(await store.getActiveSessionId(), null);
    await store.switchSession("workspace-two-session");
    assert.equal(await store.getActiveSessionId(), "workspace-two-session");

    await store.switchWorkspace("default");
    assert.equal(await store.getActiveSessionId(), "default-session");
    await store.clearActiveSession();
    assert.equal(await store.getActiveSessionId(), null);

    await store.switchWorkspace("workspace-two");
    assert.equal(await store.getActiveSessionId(), "workspace-two-session");
    await store.clearActiveSession("default");
    assert.equal(await store.getActiveSessionId(), "workspace-two-session");
  } finally {
    await store.close();
  }
});

async function createStore() {
  const root = mkdtempSync(resolve(tmpdir(), "session-live-item-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  await store.upsertSession({ id: "session-1" });
  await store.recordSessionTurn({
    id: "turn-1",
    sessionId: "session-1",
    userInput: "test",
    agentResponse: "",
    tokenIn: 0,
    tokenOut: 0,
    status: "running"
  });
  return store;
}

test("session turn effort falls back to a recorded setting when the preferred token sample omits it", async () => {
  const store = await createStore();
  try {
    await store.recordTokenUsage([
      {
        id: "agent:turn:turn-1",
        usageType: "agent",
        source: "turn_final",
        sessionId: "session-1",
        turnId: "turn-1",
        model: "gpt-5.6-terra",
        sourceTimestamp: "2026-09-03T09:06:33.000Z",
        metadata: { reasoningEffort: "xhigh" }
      },
      {
        id: "agent:sample:turn-1:native-token-count",
        usageType: "agent",
        source: "native_token_count",
        sessionId: "session-1",
        turnId: "turn-1",
        model: "gpt-5.6-terra",
        sourceIndex: 69,
        sourceTimestamp: "2026-09-03T09:06:32.000Z",
        primaryUsedPercent: 2,
        inputTokens: 32_807,
        outputTokens: 1_665,
        totalTokens: 34_472
      }
    ]);

    const [turn] = await store.listSessionTurns("session-1");
    assert.equal(turn?.usageSample?.source, "native_token_count");
    assert.equal(turn?.reasoningEffort, "xhigh");
  } finally {
    await store.close();
  }
});

test("session turn claims serialize writers and queue different prompts", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-writer-claim-test-"));
  const dbPath = resolve(root, "threadex.postgres");
  const firstStore = new SessionStore(dbPath);
  await firstStore.ready();
  const secondStore = new SessionStore(dbPath);
  await secondStore.ready();
  try {
    await firstStore.upsertSession({ id: "writer-session", workspaceId: "default" });
    const claimInput = (id: string, userInput: string) => ({
      id,
      sessionId: "writer-session",
      userInput,
      agentResponse: "",
      tokenIn: 0,
      tokenOut: 0,
      status: "running" as const
    });

    const [first, second] = await Promise.all([
      firstStore.claimSessionTurn(claimInput("writer-turn-1", "first prompt")),
      secondStore.claimSessionTurn(claimInput("writer-turn-2", "second prompt"))
    ]);
    assert.deepEqual(new Set([first.disposition, second.disposition]), new Set(["started", "queued"]));

    const turns = await firstStore.listSessionTurns("writer-session");
    assert.equal(turns.filter((turn) => turn.status === "running").length, 1);
    assert.equal(turns.filter((turn) => turn.status === "todo" && turn.pendingReason === "queued").length, 1);

    const running = turns.find((turn) => turn.status === "running");
    const queued = turns.find((turn) => turn.status === "todo");
    assert.ok(running);
    assert.ok(queued);
    const reconnect = await secondStore.claimSessionTurn(
      claimInput("writer-turn-reconnect", running.userInput)
    );
    assert.equal(reconnect.disposition, "reconnected");
    assert.equal(reconnect.turn.id, running.id);

    const blocked = await secondStore.claimPendingSessionTurn(queued.id, "writer-session");
    assert.equal(blocked.disposition, "blocked");
    assert.equal(blocked.runningTurn?.id, running.id);

    await firstStore.updateSessionTurn({
      id: running.id,
      agentResponse: "done",
      tokenIn: 1,
      tokenOut: 1,
      status: "done",
      runnerExitCode: 0
    });
    const promoted = await Promise.all([
      firstStore.claimPendingSessionTurn(queued.id, "writer-session"),
      secondStore.claimPendingSessionTurn(queued.id, "writer-session")
    ]);
    assert.equal(promoted.filter((claim) => claim.disposition === "started").length, 1);
    assert.equal(promoted.filter((claim) => claim.disposition === "already_running").length, 1);
    assert.equal((await firstStore.getLatestRunningTurn("writer-session"))?.id, queued.id);
    assert.equal(
      (await firstStore.getSessionTurn(queued.id))?.pendingReason,
      "queued",
      "a started Todo keeps its origin so an immediate stop can cancel it instead of re-queueing it"
    );
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
  }
});

test("account auth is stored privately in PostgreSQL and updated with version checks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-account-auth-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    const created = await store.upsertAccount({ id: "account-1", name: "Account 1" });
    assert.equal(created.hasAuth, false);
    assert.equal(created.authVersion, 0);

    const authRaw = JSON.stringify({ OPENAI_API_KEY: "secret-one" });
    assert.equal(await store.setAccountAuth(created.id, authRaw, "model = \"gpt-test\"\n"), "updated");
    const account = await store.getAccount(created.id);
    assert.equal(account?.hasAuth, true);
    assert.equal(account?.authVersion, 1);
    assert.equal("authRaw" in (account as unknown as Record<string, unknown>), false);

    const stored = await store.getAccountAuth(created.id);
    assert.deepEqual(stored, {
      authRaw,
      configRaw: "model = \"gpt-test\"\n",
      version: 1
    });
    assert.equal(
      await store.compareAndSetAccountAuth(created.id, 0, JSON.stringify({ OPENAI_API_KEY: "stale" }), null),
      "conflict"
    );
    assert.equal(
      await store.compareAndSetAccountAuth(created.id, 1, JSON.stringify({ OPENAI_API_KEY: "secret-two" }), null),
      "updated"
    );
    assert.equal((await store.getAccountAuth(created.id))?.version, 2);
    await assert.rejects(
      store.runSqlQuery({ sql: "SELECT auth_json FROM accounts" }),
      /accounts table is protected/
    );
  } finally {
    await store.close();
  }
});

test("live items upsert by replay order without item event history", async () => {
  const store = await createStore();
  try {
    const storedDetail = "完整進度內容仍然保留，並會繼續處理後續驗證。".repeat(3);
    const storedLegacyShort = "正在處理";
    const record = (id: string, jsonlIndex: number, eventType: string, text: string, comment?: Record<string, string>) =>
      store.recordSessionTurnEvent({
        id,
        turnId: "turn-1",
        sessionId: "session-1",
        eventName: "item",
        jsonlIndex,
        payload: { id: "message-1", itemType: "agent_message", eventType, text, ...(comment ? { phase: "commentary", comment } : {}) }
      });

    await record("started", 10, "item.started", "starting");
    await record("updated", 11, "item.updated", "latest draft");
    await record("stale", 9, "item.started", "stale replay");
    await record("completed", 12, "item.completed", storedDetail, {
      type: "action",
      short: storedLegacyShort,
      detail: storedDetail
    });
    await record("duplicate-old", 11, "item.updated", "old draft replayed");

    const inspected = await store.inspectSession({
      sessionId: "session-1",
      includeLiveItems: true,
      includeEvents: true
    });
    const liveItems = inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>;
    assert.equal(liveItems.length, 1);
    assert.equal(liveItems[0].eventType, "item.completed");
    assert.equal(liveItems[0].text, storedDetail);
    assert.equal(liveItems[0].phase, "commentary");
    const storedComment = liveItems[0].comment as {
      extracts: Array<{ type: string; shortMsg: string }>;
      detail: string;
    };
    assert.deepEqual(storedComment.extracts, [{
      type: "action",
      shortMsg: "完整進度內容仍然保留，並會繼續處理後續驗證。完整進度內容仍然保…"
    }]);
    assert.equal(storedComment.detail, storedDetail);
    assert.equal(inspected?.events?.length, 0);

    const rows = await store.runSqlQuery({
      sql: "SELECT source_event_id, jsonl_index, is_final FROM session_live_item"
    });
    assert.deepEqual(rows.rows, [{ source_event_id: "completed", jsonl_index: 12, is_final: true }]);
  } finally {
    await store.close();
  }
});

test("session snapshots preserve escaped NULs in command output and raw Codex events", async () => {
  const store = await createStore();
  try {
    const output = "before\u0000after";
    await store.recordSessionTurnEvent({
      id: "nul-command", turnId: "turn-1", sessionId: "session-1", eventName: "item",
      payload: {
        id: "command-nul", itemType: "command_execution", eventType: "item.completed",
        command: "read binary output", aggregatedOutput: output,
        aggregatedOutputLength: output.length, exitCode: 0, status: "completed"
      }
    });
    await store.recordSessionTurnEvent({
      id: "nul-raw", turnId: "turn-1", sessionId: "session-1", eventName: "codex",
      payload: { method: "item/completed", params: { output } }
    });
    const inspected = await store.inspectSession({ sessionId: "session-1", includeLiveItems: true });
    const items = inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>;
    const command = items.find((item) => item.id === "command-nul");
    assert.equal(command?.aggregatedOutput, output);
    assert.equal(command?.exitCode, 0);
    assert.equal(command?.command, "read binary output");
  } finally {
    await store.close();
  }
});

test("context compaction live items survive session snapshot storage", async () => {
  const store = await createStore();
  try {
    await store.recordSessionTurnEvent({
      id: "context-compaction-completed",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "compact-1",
        itemType: "context_compaction",
        eventType: "item.completed"
      }
    });

    const inspected = await store.inspectSession({
      sessionId: "session-1",
      includeLiveItems: true
    });
    const liveItems = inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>;
    assert.equal(liveItems.length, 1);
    assert.deepEqual({
      id: liveItems[0].id,
      eventType: liveItems[0].eventType,
      itemType: liveItems[0].itemType
    }, {
      id: "compact-1",
      eventType: "item.completed",
      itemType: "context_compaction"
    });
  } finally {
    await store.close();
  }
});

test("authoritative turn diff supersedes partial file-change activity for historical turns", async () => {
  const store = await createStore();
  try {
    await store.recordSessionTurnEvent({
      id: "partial-edit",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "edit-1",
        itemType: "file_change",
        eventType: "item.completed",
        status: "completed",
        changes: [
          { path: "src/reverted-a.ts", kind: "update", diff: "@@ -1 +0,0 @@\n-old" },
          { path: "src/reverted-b.ts", kind: "update", diff: "@@ -1 +0,0 @@\n-old" }
        ]
      }
    });
    await store.recordSessionTurnEvent({
      id: "final-turn-diff",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "codex",
      payload: {
        method: "turn/diff/updated",
        params: {
          turnId: "native-turn-1",
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
            "@@ -2 +2,2 @@",
            "-before",
            "+after",
            "+extra"
          ].join("\n")
        }
      }
    });

    const items = await store.listSessionLiveItems("session-1");
    const authoritative = (items["turn-1"] as Array<Record<string, unknown>>)
      .find((item) => item.authoritative === true);
    assert.equal(authoritative?.id, "turn-diff:native-turn-1");
    assert.deepEqual(
      (authoritative?.changes as Array<Record<string, unknown>>).map((change) => change.path),
      ["src/net-a.ts", "src/net-b.ts"]
    );

    const inspected = await store.inspectSession({ sessionId: "session-1", view: "turn_summary" });
    assert.deepEqual(inspected?.turns[0]?.fileChanges.map((change) => change.path), ["src/net-a.ts", "src/net-b.ts"]);
    assert.deepEqual(inspected?.turns[0]?.totals, { files: 2, additions: 3, deletions: 2 });

    await store.recordSessionTurnEvent({
      id: "failed-edit", sessionId: "session-1", turnId: "turn-1", eventName: "item",
      payload: { id: "failed-edit", itemType: "file_change", eventType: "item.completed",
        status: "failed", changes: [{ path: "denied.ts", kind: "update" }] }
    });
    await store.recordSessionTurnEvent({
      id: "empty-after-failure", sessionId: "session-1", turnId: "turn-1", eventName: "codex",
      payload: { method: "turn/diff/updated", params: { turnId: "native-turn-1", diff: "" } }
    });
    await store.recordSessionTurnEvent({
      id: "stored-empty-diff", sessionId: "session-1", turnId: "turn-1", eventName: "item",
      payload: { id: "turn-diff:native-turn-1", itemType: "file_change", eventType: "item.completed",
        authoritative: true, status: "completed", changes: [] }
    });
    const recovered = await store.inspectSession({ sessionId: "session-1", view: "turn_summary" });
    assert.deepEqual(recovered?.turns[0]?.fileChanges.map((change) => change.path), ["src/net-a.ts", "src/net-b.ts"]);

    await store.recordSessionTurnEvent({
      id: "successful-revert", sessionId: "session-1", turnId: "turn-1", eventName: "item",
      payload: { id: "successful-revert", itemType: "file_change", eventType: "item.completed",
        status: "completed", changes: [{ path: "src/net-a.ts", kind: "update" }] }
    });
    await store.recordSessionTurnEvent({
      id: "empty-after-revert", sessionId: "session-1", turnId: "turn-1", eventName: "codex",
      payload: { method: "turn/diff/updated", params: { turnId: "native-turn-1", diff: "" } }
    });
    const reverted = await store.inspectSession({ sessionId: "session-1", view: "turn_summary" });
    assert.deepEqual(reverted?.turns[0]?.fileChanges, []);
  } finally {
    await store.close();
  }
});

test("turn live-item lookup excludes oversized evidence from other turns while retaining the target diff", async () => {
  const store = await createStore();
  try {
    await store.recordSessionTurnEvent({
      id: "target-file-change", turnId: "turn-1", sessionId: "session-1", eventName: "item",
      payload: {
        id: "target-file-change", itemType: "file_change", eventType: "item.completed",
        changes: [{ path: "src/target.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }]
      }
    });
    await store.recordSessionTurnEvent({
      id: "oversized-other-turn", turnId: "turn-2", sessionId: "session-1", eventName: "item",
      payload: { id: "oversized-other-turn", itemType: "agent_message", eventType: "item.completed", text: "x".repeat(1_000_000) }
    });

    const targetItems = await store.listSessionTurnLiveItems("session-1", "turn-1") as Array<Record<string, unknown>>;
    assert.equal(targetItems.length, 1);
    assert.equal(targetItems[0].id, "target-file-change");
    assert.deepEqual((targetItems[0].changes as Array<Record<string, unknown>>).map((change) => change.path), ["src/target.ts"]);
  } finally {
    await store.close();
  }
});

test("persists accepted steer messages for session snapshots", async () => {
  const store = await createStore();
  try {
    await store.recordSessionTurnEvent({
      id: "steer.accepted:legacy",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "steer.accepted",
      payload: {
        commandId: "legacy",
        message: "Restore this steer from the runner acceptance event."
      }
    });
    await store.recordSessionTurnEvent({
      id: "steer:one",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "steer",
      payload: {
        id: "one",
        content: "Keep the migration backwards-compatible.",
        attachments: [{ id: "attachment-1", name: "notes.txt", type: "text/plain", size: 42, path: "/tmp/notes.txt" }],
        forcePlan: true
      }
    });
    await store.recordSessionTurnEvent({
      id: "steer:invalid",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "steer",
      payload: { id: "invalid", content: "" }
    });

    const steers = await store.listSessionSteerMessages("session-1");
    assert.equal(steers["turn-1"]?.length, 2);
    assert.deepEqual(steers["turn-1"]?.[0], {
      id: "legacy",
      content: "Restore this steer from the runner acceptance event.",
      attachments: [],
      forcePlan: false,
      created: steers["turn-1"]?.[0]?.created
    });
    assert.deepEqual(steers["turn-1"]?.[1], {
      id: "one",
      content: "Keep the migration backwards-compatible.",
      attachments: [{ id: "attachment-1", name: "notes.txt", type: "text/plain", size: 42, path: "/tmp/notes.txt" }],
      forcePlan: true,
      created: steers["turn-1"]?.[1]?.created
    });
    assert.ok(steers["turn-1"]?.[0]?.created);
    assert.ok(steers["turn-1"]?.[1]?.created);

    await store.recordSessionTurnEvent({
      id: "steer.accepted:one",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "steer.accepted",
      payload: { commandId: "one", message: "Old runner copy" }
    });
    const deduplicated = await store.listSessionSteerMessages("session-1");
    assert.equal(deduplicated["turn-1"]?.length, 2);
    const restoredCurrentSteer = deduplicated["turn-1"]?.find((steer) => steer.id === "one");
    assert.deepEqual(
      restoredCurrentSteer && { ...restoredCurrentSteer, created: undefined },
      steers["turn-1"]?.[1] && { ...steers["turn-1"]?.[1], created: undefined }
    );
    assert.ok(restoredCurrentSteer?.created);
  } finally {
    await store.close();
  }
});

test("live items with the same raw id remain distinct across app-server origin threads", async () => {
  const store = await createStore();
  try {
    for (const [index, originThreadId] of ["child-a", "child-b"].entries()) {
      await store.recordSessionTurnEvent({
        id: `command-${index}`,
        turnId: "turn-1",
        sessionId: "session-1",
        eventName: "item",
        jsonlIndex: index,
        payload: {
          id: "shared-command-id",
          itemType: "command_execution",
          eventType: "item.completed",
          command: `command from ${originThreadId}`,
          aggregatedOutput: `output from ${originThreadId}`,
          status: "completed",
          exitCode: 0,
          originThreadId,
          originTurnId: `turn-${originThreadId}`
        }
      });
    }

    const itemsByTurn = await store.listSessionLiveItems("session-1");
    const items = itemsByTurn["turn-1"] as Array<Record<string, unknown>>;
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.id), ["shared-command-id", "shared-command-id"]);
    assert.deepEqual(items.map((item) => item.originThreadId), ["child-a", "child-b"]);
    assert.deepEqual(items.map((item) => item.originTurnId), ["turn-child-a", "turn-child-b"]);

    const rows = await store.runSqlQuery({ sql: "SELECT count(DISTINCT item_id) AS item_count FROM session_live_item" });
    assert.deepEqual(rows.rows, [{ item_count: 2 }]);
  } finally {
    await store.close();
  }
});

test("session side chats are separate from turn context", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-side-chat-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session-1", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "turn-1",
      sessionId: "session-1",
      userInput: "real prompt",
      agentResponse: "real answer",
      tokenIn: 1,
      tokenOut: 1,
      status: "done"
    });
    const sideChat = await store.recordSessionSideChat({
      sessionId: "session-1",
      workspaceId: "default",
      sourceSessionId: "session-2",
      sourceTurnId: "turn-2",
      question: "What happened?",
      answer: "Only a side chat answer.",
      model: "luna",
      contextTurnCount: 1
    });

    const regular = await store.inspectSession({ sessionId: "session-1" });
    assert.equal(regular?.turns.length, 1);
    assert.equal(regular?.turns[0]?.userInput, "real prompt");
    assert.equal(regular && "sideChats" in regular, false);

    const withSideChats = await store.inspectSession({ sessionId: "session-1", includeSideChats: true });
    assert.equal(withSideChats?.turns.length, 1);
    assert.deepEqual(withSideChats?.sideChats?.map((record) => record.id), [sideChat.id]);
    assert.equal(withSideChats?.sideChats?.[0]?.answer, "Only a side chat answer.");
  } finally {
    await store.close();
  }
});

test("diagnostic turn events can avoid refreshing runner heartbeat", async () => {
  const store = await createStore();
  try {
    assert.equal(await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    }), false);
    const startedHeartbeat = (await store.getSessionTurn("turn-1"))?.runnerHeartbeat;
    assert.ok(startedHeartbeat);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.recordSessionTurnEvent({
      id: "turn-1:progress",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: { id: "item-1", itemType: "agent_message", eventType: "item.started", text: "working" }
    });
    const progressHeartbeat = (await store.getSessionTurn("turn-1"))?.runnerHeartbeat;
    assert.ok(progressHeartbeat);
    assert.notEqual(progressHeartbeat, startedHeartbeat);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.recordSessionTurnEvent({
      id: "turn-1:watchdog-stale",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "runner.watchdog.stale",
      payload: { staleMs: 120_000 },
      refreshRunnerHeartbeat: false
    });
    const diagnosticHeartbeat = (await store.getSessionTurn("turn-1"))?.runnerHeartbeat;
    assert.equal(diagnosticHeartbeat, progressHeartbeat);
  } finally {
    await store.close();
  }
});

test("runner start time is retained and completed turns expose the runner-reported duration", async () => {
  const store = await createStore();
  try {
    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    const firstStartedAt = (await store.getSessionTurn("turn-1"))?.runnerStarted;
    assert.ok(firstStartedAt);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerStarted, firstStartedAt);

    await store.recordSessionTurnEvent({
      id: "turn-1:result",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "result",
      payload: { elapsedMs: 311_296 }
    });
    assert.equal((await store.getSessionTurn("turn-1"))?.executionDurationMs, 311_296);
    assert.equal((await store.listSessionTurns("session-1"))[0]?.executionDurationMs, 311_296);
  } finally {
    await store.close();
  }
});

test("non-running turn updates clear live runner pid and active execution status", async () => {
  const store = await createStore();
  try {
    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), {
      "session-1": "running"
    });

    await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Prompt runner stopped before completion. Saved as pending for retry.",
      tokenIn: 1,
      tokenOut: 1,
      status: "todo",
      pendingReason: "queued"
    });

    const pendingTurn = await store.getSessionTurn("turn-1");
    assert.equal(pendingTurn?.status, "todo");
    assert.equal(pendingTurn?.runnerPid, null);
    assert.equal(pendingTurn?.runnerLogPath, "/tmp/threadex-runner.ndjson");
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), {});

    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    assert.equal((await store.getSessionTurn("turn-1"))?.status, "todo");
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, null);

    const claimedRetry = await store.claimPendingSessionTurn(
      "turn-1",
      "session-1",
      "/tmp/threadex-runner-retry.ndjson"
    );
    assert.equal(claimedRetry.disposition, "started");
    assert.equal(await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: 99998,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    }), false);
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, null);
    assert.equal(
      (await store.getSessionTurn("turn-1"))?.runnerLogPath,
      "/tmp/threadex-runner-retry.ndjson"
    );
    assert.equal(await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: process.pid,
      runnerLogPath: "/tmp/threadex-runner-retry.ndjson"
    }), true);
    await (store as unknown as {
      write(callback: (connection: {
        run(sql: string, params?: Record<string, unknown>): Promise<unknown>;
      }) => Promise<void>): Promise<void>;
    }).write(async (connection) => {
      await connection.run("UPDATE session_turn SET status = 'todo' WHERE id = $id", { id: "turn-1" });
    });
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, null);
  } finally {
    await store.close();
  }
});

test("watchdog compare-and-set cannot overwrite a completed or restarted turn", async () => {
  const store = await createStore();
  try {
    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: 41001,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Completed result",
      tokenIn: 10,
      tokenOut: 5,
      status: "done",
      runnerExitCode: 0
    });

    assert.equal(await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Stale watchdog stop",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "stopped",
      expectedStatus: "running",
      expectedRunnerPid: 41001
    }), false);
    assert.equal((await store.getSessionTurn("turn-1"))?.agentResponse, "Completed result");
    assert.equal((await store.getSessionTurn("turn-1"))?.status, "done");

    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: 41002,
      runnerLogPath: "/tmp/threadex-runner.ndjson"
    });
    assert.equal((await store.getSessionTurn("turn-1"))?.status, "done");
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, null);
    await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Queued for an explicit retry",
      tokenIn: 10,
      tokenOut: 5,
      status: "todo",
      pendingReason: "queued"
    });
    assert.equal((await store.claimPendingSessionTurn(
      "turn-1",
      "session-1",
      "/tmp/threadex-runner-retry.ndjson"
    )).disposition, "started");
    await store.markSessionTurnRunning({
      id: "turn-1",
      runnerPid: 41002,
      runnerLogPath: "/tmp/threadex-runner-retry.ndjson"
    });
    assert.equal(await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Late pending result from the first runner",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "rate_limit",
      expectedStatus: "running",
      expectedRunnerLogPath: "/tmp/threadex-runner.ndjson"
    }), false);
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, 41002);
    assert.equal((await store.getSessionTurn("turn-1"))?.status, "running");
    assert.equal(await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "Old runner watchdog stop",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "stopped",
      expectedStatus: "running",
      expectedRunnerPid: 41001
    }), false);
    assert.equal((await store.getSessionTurn("turn-1"))?.runnerPid, 41002);
    assert.equal((await store.getSessionTurn("turn-1"))?.status, "running");
  } finally {
    await store.close();
  }
});

test("session todo supports nesting comments and user hold on locked active item", async () => {
  const store = await createStore();
  try {
    let todo = await store.upsertTodoItem({
      id: "todo-root",
      sessionId: "session-1",
      title: "Build todo MCP",
      details: "Create the shared todo plan",
      context: "Repository todo state lives in PostgreSQL.",
      status: "active",
      actor: "agent",
      turnId: "turn-1",
      activeStatus: "Creating the todo schema and APIs."
    });
    todo = await store.upsertTodoItem({
      id: "todo-child",
      sessionId: "session-1",
      parentId: "todo-root",
      title: "Add nested UI",
      context: "Render context as expandable item detail.",
      status: "todo",
      actor: "agent"
    });
    todo = await store.addTodoComment({
      sessionId: "session-1",
      itemId: "todo-root",
      turnId: "turn-1",
      type: "blocker",
      author: "agent",
      body: "Need to verify runner pause semantics."
    });

    assert.deepEqual(todo.items.map((item) => [item.id, item.parentId, item.status]), [
      ["todo-root", null, "active"],
      ["todo-child", "todo-root", "todo"]
    ]);
    assert.equal(todo.items[0].lockedByTurnId, "turn-1");
    assert.equal(todo.items[0].context, "Repository todo state lives in PostgreSQL.");
    assert.equal(todo.itemTree[0]?.context, "Repository todo state lives in PostgreSQL.");
    assert.equal(todo.itemTree[0]?.children[0]?.context, "Render context as expandable item detail.");
    assert.equal(todo.comments[0].type, "blocker");

    todo = await store.updateTodoItem({
      id: "todo-root",
      sessionId: "session-1",
      title: "Build todo MCP, edited by user",
      actor: "user"
    });
    const root = todo.items.find((item) => item.id === "todo-root");
    assert.equal(root?.status, "hold");
    assert.match(root?.lockReason ?? "", /User edited/);

    const control = await store.getTodoRunnerControl({ sessionId: "session-1", turnId: "turn-1" });
    assert.equal(control.pause, true);
    assert.match(control.reason, /User edited/);

    todo = await store.linkTodoItemSession({
      sessionId: "session-1",
      itemId: "todo-root",
      childSessionId: "session-child-1",
      childTurnId: "turn-child-1",
      title: "Worker task",
      role: "worker"
    });
    assert.deepEqual(todo.itemSessions.map((session) => [session.itemId, session.childSessionId, session.childTurnId]), [
      ["todo-root", "session-child-1", "turn-child-1"]
    ]);
    assert.equal(todo.itemTree[0]?.sessions[0]?.childSessionId, "session-child-1");

    todo = await store.setTodoControl({
      sessionId: "session-1",
      paused: true,
      pauseReason: "Reviewing plan",
      context: "Plan-level context prepared before execution.",
      actor: "user"
    });
    assert.equal(todo.control.paused, true);
    assert.equal(todo.control.pausedBy, "user");
    assert.equal(todo.control.context, "Plan-level context prepared before execution.");
  } finally {
    await store.close();
  }
});

test("session todo supports typed item messages challenges and file summaries", async () => {
  const store = await createStore();
  try {
    let todo = await store.upsertTodoItem({
      id: "todo-root",
      sessionId: "session-1",
      title: "Implement status UI",
      status: "active",
      actor: "agent",
      turnId: "turn-1"
    });
    assert.deepEqual(todo.messages, []);

    const update = await store.addTodoMessage({
      sessionId: "session-1",
      itemId: "todo-root",
      turnId: "turn-1",
      title: "Store shape confirmed"
    });
    assert.equal(update.message.id, 1);
    assert.equal(update.message.type, "update");
    assert.equal(update.message.resolved, true);

    const challenge = await store.addTodoMessage({
      sessionId: "session-1",
      itemId: "todo-root",
      turnId: "turn-1",
      type: "challenge",
      title: "Runner hook needs a guard",
      body: "Avoid repeating follow-up turns."
    });
    assert.equal(challenge.message.id, 2);
    assert.equal(challenge.challengeId, 2);
    assert.equal(challenge.message.resolved, false);

    let unresolved = await store.listUnresolvedTodoChallenges("session-1");
    assert.deepEqual(unresolved.map((message) => [message.id, message.title, message.resolved]), [
      [2, "Runner hook needs a guard", false]
    ]);

    const resolved = await store.resolveTodoChallenge({ sessionId: "session-1", challengeId: 2, actor: "agent" });
    assert.equal(resolved.resolvedChallengeId, 2);
    unresolved = await store.listUnresolvedTodoChallenges("session-1");
    assert.deepEqual(unresolved, []);
    assert.equal(resolved.messages.find((message) => message.id === 2)?.resolved, true);

    await store.recordSessionTurnEvent({
      id: "file-change-1",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:1",
        itemType: "file_change",
        eventType: "item.completed",
        changes: [
          { path: "src/server/sessionStore.ts", kind: "update" },
          { path: "src/client/App.runtime.js", kind: "update" }
        ]
      }
    });
    await store.recordSessionTurnEvent({
      id: "file-change-2",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:2",
        itemType: "file_change",
        eventType: "item.completed",
        changes: [
          { path: "src/server/sessionStore.ts", kind: "update" },
          { path: "src/client/styles.css", kind: "update" }
        ]
      }
    });
    todo = await store.getSessionTodo("session-1");
    const root = todo.items.find((item) => item.id === "todo-root");
    assert.equal(root?.changedFileCount, 3);
    assert.deepEqual(root?.changedFiles, [
      "src/client/App.runtime.js",
      "src/client/styles.css",
      "src/server/sessionStore.ts"
    ]);
  } finally {
    await store.close();
  }
});

test("session todo snapshot includes context tree and multiple child sessions per item", async () => {
  const store = await createStore();
  try {
    let todo = await store.setTodoControl({
      sessionId: "session-1",
      context: "Repo context prepared before creating executable todo items.",
      problem: "Todo plans do not distinguish the motivating need from the work.",
      objective: "Every plan exposes an observable outcome before executable items.",
      actor: "agent"
    });
    assert.equal(todo.control.context, "Repo context prepared before creating executable todo items.");
    assert.equal(todo.control.problem, "Todo plans do not distinguish the motivating need from the work.");
    assert.equal(todo.control.objective, "Every plan exposes an observable outcome before executable items.");

    todo = await store.upsertTodoItem({
      id: "todo-root",
      sessionId: "session-1",
      title: "Implement todo context",
      details: "Add context to shared todo snapshots",
      context: "Root item context that child workers should inherit.",
      section: "solution",
      status: "active",
      activeStatus: "Preparing context-aware snapshot.",
      actor: "agent",
      turnId: "turn-1"
    });
    todo = await store.upsertTodoItem({
      id: "todo-child",
      sessionId: "session-1",
      parentId: "todo-root",
      title: "Wire worker handoff",
      context: "Worker-specific context.",
      actor: "agent"
    });
    await store.addTodoMessage({
      sessionId: "session-1",
      itemId: "todo-root",
      title: "Snapshot ready",
      body: "Tree contains context and progress."
    });
    await store.linkTodoItemSession({
      sessionId: "session-1",
      itemId: "todo-root",
      childSessionId: "child-session-1",
      childTurnId: "child-turn-1",
      title: "First worker"
    });
    todo = await store.linkTodoItemSession({
      sessionId: "session-1",
      itemId: "todo-root",
      childSessionId: "child-session-2",
      childTurnId: "child-turn-2",
      title: "Second worker"
    });

    assert.equal(todo.itemSessions.length, 2);
    assert.equal(todo.itemTree.length, 1);
    assert.equal(todo.itemTree[0].context, "Root item context that child workers should inherit.");
    assert.equal(todo.itemTree[0].section, "solution");
    assert.equal(todo.itemTree[0].latestProgressMessage?.title, "Snapshot ready");
    assert.deepEqual(todo.itemTree[0].sessions.map((session) => session.childSessionId), [
      "child-session-1",
      "child-session-2"
    ]);
    assert.equal(todo.itemTree[0].children[0].context, "Worker-specific context.");
    assert.equal(todo.itemTree[0].children[0].section, "solution");
  } finally {
    await store.close();
  }
});

test("session inspection file_changes view returns compact changed files and line counts", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-file-changes-view-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  await store.upsertSession({ id: "session-1" });
  await store.recordSessionTurn({
    id: "turn-1",
    sessionId: "session-1",
    userInput: "update parser",
    agentResponse: "updated parser",
    tokenIn: 0,
    tokenOut: 0,
    status: "done"
  });

  try {
    await store.recordSessionTurnEvent({
      id: "file-change-1",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:1",
        itemType: "file_change",
        eventType: "item.completed",
        status: "completed",
        changes: [
          {
            path: "src/parser.ts",
            kind: "update",
            unifiedDiff: [
              "--- a/src/parser.ts",
              "+++ b/src/parser.ts",
              "@@",
              "-oldLine();",
              "+newLine();",
              "+extraLine();",
              " contextLine();"
            ].join("\n")
          }
        ]
      }
    });

    const inspected = await store.inspectSession({ sessionId: "session-1", view: "file_changes" });
    assert.equal(inspected?.view, "file_changes");
    assert.deepEqual(inspected?.fileChanges, [
      {
        path: "src/parser.ts",
        kind: "update",
        additions: 2,
        deletions: 1,
        turnIds: ["turn-1"]
      }
    ]);
    assert.deepEqual(inspected?.totals, { files: 1, additions: 2, deletions: 1 });
    assert.equal("turns" in (inspected ?? {}), false);
  } finally {
    await store.close();
  }
});

test("session inspection file_changes view keeps only the latest change for a repeated path", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-file-changes-latest-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  await store.upsertSession({ id: "session-1" });
  await store.recordSessionTurn({ id: "turn-1", sessionId: "session-1", userInput: "first edit", agentResponse: "done", tokenIn: 0, tokenOut: 0, status: "done" });
  await store.recordSessionTurn({ id: "turn-2", sessionId: "session-1", userInput: "second edit", agentResponse: "done", tokenIn: 0, tokenOut: 0, status: "done" });

  try {
    await store.recordSessionTurnEvent({
      id: "file-change-1",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:1",
        itemType: "file_change",
        eventType: "item.completed",
        status: "completed",
        changes: [{ path: "src/parser.ts", kind: "update", unifiedDiff: "@@\n-old\n+new\n+extra" }]
      }
    });
    await store.recordSessionTurnEvent({
      id: "file-change-2",
      turnId: "turn-2",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:2",
        itemType: "file_change",
        eventType: "item.completed",
        status: "completed",
        changes: [{ path: "src/parser.ts", kind: "update", unifiedDiff: "@@\n-oldest\n+latest" }]
      }
    });

    const inspected = await store.inspectSession({ sessionId: "session-1", view: "file_changes" });
    assert.deepEqual(inspected?.fileChanges, [
      { path: "src/parser.ts", kind: "update", additions: 1, deletions: 1, turnIds: ["turn-2"] }
    ]);
    assert.deepEqual(inspected?.totals, { files: 1, additions: 1, deletions: 1 });
  } finally {
    await store.close();
  }
});

test("session inspection turn_summary view returns prompts conclusions and file changes by turn", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-turn-summary-view-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  await store.upsertSession({ id: "session-1" });
  await store.recordSessionTurn({
    id: "turn-1",
    sessionId: "session-1",
    userInput: "add read option",
    agentResponse: "Added read option and verified tests.",
    tokenIn: 0,
    tokenOut: 0,
    status: "done"
  });

  try {
    await store.recordSessionTurnEvent({
      id: "file-change-1",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      payload: {
        id: "file:1",
        itemType: "file_change",
        eventType: "item.completed",
        status: "completed",
        changes: [
          {
            path: "src/server/sessionInspectorMcp.ts",
            kind: "add",
            currentContent: "",
            afterContent: "line one\nline two\n"
          }
        ]
      }
    });

    const inspected = await store.inspectSession({ sessionId: "session-1", view: "turn_summary" });
    assert.equal(inspected?.view, "turn_summary");
    assert.deepEqual(inspected?.turns, [
      {
        id: "turn-1",
        status: "done",
        created: inspected?.turns[0]?.created,
        userPrompt: "add read option",
        conclusion: "Added read option and verified tests.",
        fileChanges: [
          {
            path: "src/server/sessionInspectorMcp.ts",
            kind: "add",
            additions: 2,
            deletions: 0
          }
        ],
        totals: { files: 1, additions: 2, deletions: 0 }
      }
    ]);
  } finally {
    await store.close();
  }
});

test("snapshot live items keep their first-seen order after later updates complete out of order", async () => {
  const store = await createStore();
  try {
    const record = (eventId: string, jsonlIndex: number, itemId: string, eventType: string) =>
      store.recordSessionTurnEvent({
        id: eventId,
        turnId: "turn-1",
        sessionId: "session-1",
        eventName: "item",
        jsonlIndex,
        payload: {
          id: itemId,
          itemType: "agent_message",
          eventType,
          text: `${itemId}:${eventType}`
        }
      });

    await record("a-started", 10, "message-a", "item.started");
    await record("b-started", 20, "message-b", "item.started");
    await record("b-completed", 30, "message-b", "item.completed");
    await record("a-completed", 40, "message-a", "item.completed");

    const inspected = await store.inspectSession({ sessionId: "session-1", includeLiveItems: true });
    const liveItems = inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>;
    assert.deepEqual(liveItems.map((item) => item.id), ["message-a", "message-b"]);
    assert.deepEqual(liveItems.map((item) => item.eventType), ["item.completed", "item.completed"]);
  } finally {
    await store.close();
  }
});

test("command live items retain only the latest 64 KiB output tail and total length", async () => {
  const store = await createStore();
  try {
    const output = `${"a".repeat(10_000)}${"z".repeat(70_000)}`;
    await store.recordSessionTurnEvent({
      id: "command-completed",
      turnId: "turn-1",
      sessionId: "session-1",
      eventName: "item",
      jsonlIndex: 20,
      payload: {
        id: "command-1",
        itemType: "command_execution",
        eventType: "item.completed",
        command: "printf output",
        aggregatedOutput: output,
        status: "completed",
        exitCode: 0
      }
    });

    const stored = await store.runSqlQuery({
      sql: `SELECT
        octet_length(encode(json_extract_string(payload, '$.aggregatedOutput'))) AS output_bytes,
        CAST(json_extract(payload, '$.aggregatedOutputLength') AS BIGINT) AS output_length,
        CAST(json_extract(payload, '$.omittedOutputChars') AS BIGINT) AS omitted_chars
      FROM session_live_item`
    });
    assert.deepEqual(stored.rows, [{
      output_bytes: 64 * 1024,
      output_length: output.length,
      omitted_chars: output.length - 64 * 1024
    }]);

    const inspected = await store.inspectSession({ sessionId: "session-1", includeLiveItems: true });
    const item = inspected?.turns[0]?.liveItems?.[0] as Record<string, unknown>;
    assert.equal(item.aggregatedOutputLength, output.length);
    assert.equal(item.outputTruncated, true);
    assert.match(String(item.aggregatedOutput), /^\[output truncated: omitted 14,464 chars\]\n/);
    assert.ok(String(item.aggregatedOutput).endsWith("z".repeat(64 * 1024)));
  } finally {
    await store.close();
  }
});

test("session list search distinguishes quoted phrases from separate keywords", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-search-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "phrase", title: "Alpha beta release", workspaceId: "default" });
    await store.upsertSession({
      id: "separate",
      title: "Alpha overview",
      description: "Contains beta details",
      workspaceId: "default"
    });
    await store.upsertSession({ id: "partial", title: "Alpha only", workspaceId: "default" });
    await store.upsertSession({ id: "unrelated", title: "Gamma release", workspaceId: "default" });

    const keywords = await store.listSessionsPage("default", 0, 20, "alpha beta");
    assert.deepEqual(new Set(keywords.sessions.slice(0, 2).map((session) => session.id)), new Set(["phrase", "separate"]));
    assert.equal(keywords.sessions[2]?.id, "partial");

    const phrase = await store.listSessionsPage("default", 0, 20, '"alpha beta"');
    assert.deepEqual(phrase.sessions.map((session) => session.id), ["phrase"]);
  } finally {
    await store.close();
  }
});

test("session list search parser supports mixed phrases and keywords", () => {
  assert.deepEqual(parseSessionListSearchTerms('one "two three" FOUR one'), ["one", "two three", "FOUR"]);
  assert.deepEqual(parseSessionListSearchTerms('"say \\"hello\\"" world'), ['say "hello"', "world"]);
});

test("session summary refresh does not move old sessions above newer activity", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-summary-sort-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "old-session", workspaceId: "default", title: "Old" });
    await store.recordSessionTurn({
      id: "old-turn",
      sessionId: "old-session",
      userInput: "old work",
      agentResponse: "done",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });
    const oldUpdated = (await store.getSession("old-session"))?.updated;
    assert.ok(oldUpdated);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({ id: "new-session", workspaceId: "default", title: "New" });
    await store.recordSessionTurn({
      id: "new-turn",
      sessionId: "new-session",
      userInput: "new work",
      agentResponse: "done",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSessionSummary({
      sessionId: "old-session",
      sourceHash: "old-summary-source",
      sourceTurnCount: 1,
      sourceUpdated: oldUpdated,
      summarizerModel: "test-model",
      title: "Summarized old session",
      keywordWeights: { summary: 1 }
    });

    const oldAfterSummary = await store.getSession("old-session");
    assert.equal(oldAfterSummary?.updated, oldUpdated);
    assert.equal(oldAfterSummary?.title, "Summarized old session");
    assert.deepEqual(oldAfterSummary?.keywordWeights, { summary: 1 });

    await store.upsertSessionSummary({
      sessionId: "old-session",
      sourceHash: "old-summary-source-2",
      sourceTurnCount: 1,
      sourceUpdated: oldUpdated,
      summarizerModel: "test-model"
    });
    const oldAfterUntitledSummary = await store.getSession("old-session");
    assert.equal(oldAfterUntitledSummary?.title, "Summarized old session");
    assert.deepEqual(oldAfterUntitledSummary?.keywordWeights, { summary: 1 });

    const page = await store.listSessionsPage("default", 0, 20);
    assert.deepEqual(page.sessions.map((session) => session.id), ["new-session", "old-session"]);
  } finally {
    await store.close();
  }
});

test("session list pages every thread by last updated, including child threads", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-tree-page-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "parent-a", workspaceId: "default", title: "Parent A" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({ id: "parent-b", workspaceId: "default", title: "Parent B" });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({
      id: "child-a",
      workspaceId: "default",
      title: "Child A",
      parentSessionId: "parent-a"
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({
      id: "grandchild-a",
      workspaceId: "default",
      title: "Grandchild A",
      parentSessionId: "child-a"
    });

    const firstPage = await store.listSessionsPage("default", 0, 1);
    assert.deepEqual(firstPage.sessions.map((session) => session.id), ["grandchild-a"]);
    assert.equal(firstPage.total, 4);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextOffset, 1);

    const secondPage = await store.listSessionsPage("default", firstPage.nextOffset ?? 0, 1);
    assert.deepEqual(secondPage.sessions.map((session) => session.id), ["child-a"]);
    assert.equal(secondPage.hasMore, true);
    assert.equal(secondPage.nextOffset, 2);

    const remainingPage = await store.listSessionsPage("default", secondPage.nextOffset ?? 0, 20);
    assert.deepEqual(remainingPage.sessions.map((session) => session.id), ["parent-b", "parent-a"]);
    assert.equal(remainingPage.hasMore, false);
    assert.equal(remainingPage.nextOffset, null);
  } finally {
    await store.close();
  }
});

test("session snapshot pages each project independently", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-project-page-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "alpha-1", workspaceId: "default", cwd: "/work/alpha" });
    await store.upsertSession({ id: "alpha-2", workspaceId: "default", cwd: "/work/alpha" });
    await store.upsertSession({ id: "alpha-3", workspaceId: "default", cwd: "/work/alpha" });
    await store.upsertSession({ id: "beta-1", workspaceId: "default", cwd: "/work/beta" });
    await store.upsertSession({ id: "beta-2", workspaceId: "default", cwd: "/work/beta" });

    const snapshot = await store.listSessionsByProjectPage("default", 2);
    const alpha = snapshot.projects.find((project) => project.cwd === "/work/alpha");
    const beta = snapshot.projects.find((project) => project.cwd === "/work/beta");

    assert.equal(alpha?.sessions.length, 2);
    assert.equal(alpha?.total, 3);
    assert.equal(alpha?.hasMore, true);
    assert.equal(alpha?.nextOffset, 2);
    assert.equal(beta?.sessions.length, 2);
    assert.equal(beta?.total, 2);
    assert.equal(beta?.hasMore, false);
    assert.equal(beta?.nextOffset, null);
    assert.equal(snapshot.sessions.length, 4);

    const alphaRemainder = await store.listSessionsPage("default", alpha?.nextOffset ?? 0, 2, null, "/work/alpha");
    assert.equal(alphaRemainder.sessions.length, 1);
    assert.equal(alphaRemainder.hasMore, false);
  } finally {
    await store.close();
  }
});

test("session list groups completed turn token usage by model", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-model-token-usage-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "model-usage", workspaceId: "default" });
    await Promise.all([
      store.recordSessionTurn({
        id: "luna-turn",
        sessionId: "model-usage",
        userInput: "luna",
        agentResponse: "",
        tokenIn: 1_000,
        tokenOut: 250,
        status: "done"
      }),
      store.recordSessionTurn({
        id: "terra-turn",
        sessionId: "model-usage",
        userInput: "terra",
        agentResponse: "",
        tokenIn: 500,
        tokenOut: 125,
        status: "done"
      }),
      store.recordSessionTurn({
        id: "legacy-turn",
        sessionId: "model-usage",
        userInput: "legacy",
        agentResponse: "",
        tokenIn: 20,
        tokenOut: 5,
        status: "done"
      })
    ]);
    await store.recordTokenUsage([
      {
        id: "agent:turn:luna-turn",
        usageType: "agent",
        source: "turn_started",
        sessionId: "model-usage",
        turnId: "luna-turn",
        model: "gpt-5.6-luna"
      },
      {
        id: "agent:sample:luna-turn:1",
        usageType: "agent",
        source: "app_server",
        sessionId: "model-usage",
        turnId: "luna-turn",
        model: "gpt-5.6-luna",
        cachedInputTokens: 800
      },
      {
        id: "agent:turn:terra-turn",
        usageType: "agent",
        source: "turn_started",
        sessionId: "model-usage",
        turnId: "terra-turn",
        model: "gpt-5.6-terra"
      },
      {
        id: "background:session-question",
        usageType: "background",
        source: "app_server",
        sessionId: "model-usage",
        model: "gpt-5.6-sol",
        totalTokens: 999
      }
    ]);

    const page = await store.listSessionsPage("default", 0, 20);
    const session = page.sessions.find((candidate) => candidate.id === "model-usage");
    assert.equal(session?.tokenCount, 1_900);
    assert.deepEqual(session?.modelTokenUsage, [
      { model: "gpt-5.6-luna", tokenCount: 1_250, inputTokenCount: 1_000, cachedInputTokenCount: 800, outputTokenCount: 250 },
      { model: "gpt-5.6-terra", tokenCount: 625, inputTokenCount: 500, cachedInputTokenCount: 0, outputTokenCount: 125 },
      { model: "Unknown", tokenCount: 25, inputTokenCount: 20, cachedInputTokenCount: 0, outputTokenCount: 5 }
    ]);
  } finally {
    await store.close();
  }
});

test("session search sorts keyword, title, prompt, agent, then other matches", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-search-relevance-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({
      id: "keyword-match",
      title: "Unrelated title",
      keywordWeights: { approval: 1 },
      workspaceId: "default"
    });
    await store.upsertSession({ id: "title-match", title: "Approval title", workspaceId: "default" });
    await store.upsertSession({ id: "prompt-match", title: "Unrelated prompt", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "prompt-match-turn",
      sessionId: "prompt-match",
      userInput: "Approval is needed",
      agentResponse: "Waiting",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });
    await store.upsertSession({ id: "agent-match", title: "Unrelated agent", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "agent-match-turn",
      sessionId: "agent-match",
      userInput: "Continue",
      agentResponse: "Approval is needed",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });
    await store.upsertSession({ id: "other-match", title: "Unrelated other", description: "Approval details", workspaceId: "default" });

    const result = await store.listSessionsPage("default", 0, 20, "approval");

    assert.deepEqual(result.sessions.map((session) => session.id), [
      "keyword-match",
      "title-match",
      "prompt-match",
      "agent-match",
      "other-match"
    ]);
  } finally {
    await store.close();
  }
});

test("keyword search keeps separate sessions with the same title", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-keyword-search-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    for (const id of ["approval-1", "approval-2", "approval-3"]) {
      await store.upsertSession({
        id,
        title: "Approval follow-up",
        description: "Approval request handling",
        keywordWeights: { approval: 1 },
        workspaceId: "default"
      });
    }

    const result = await store.searchSessionsByKeywords({
      keywords: ["approval"],
      workspaceId: "default",
      limit: 20
    });

    assert.equal(result.page.total, 3);
    assert.deepEqual(new Set(result.results.map((candidate) => candidate.session.id)), new Set(["approval-1", "approval-2", "approval-3"]));
  } finally {
    await store.close();
  }
});

test("keyword search includes turn and event content beyond session metadata", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-keyword-content-search-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "turn-content", title: "Unrelated title", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "turn-content-turn",
      sessionId: "turn-content",
      userInput: "Need approval for this change",
      agentResponse: "Waiting",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });

    await store.upsertSession({ id: "event-content", title: "Another unrelated title", workspaceId: "default" });
    await store.recordSessionTurn({
      id: "event-content-turn",
      sessionId: "event-content",
      userInput: "Continue the task",
      agentResponse: "Done",
      tokenIn: 0,
      tokenOut: 0,
      status: "done"
    });
    await store.recordSessionTurnEvent({
      id: "event-content-event",
      turnId: "event-content-turn",
      sessionId: "event-content",
      eventName: "approval.requested",
      payload: { method: "item/commandExecution/requestApproval" }
    });

    const result = await store.searchSessionsByKeywords({ keywords: ["approval"], workspaceId: "default", limit: 20 });

    assert.deepEqual(
      new Set(result.results.map((candidate) => candidate.session.id)),
      new Set(["turn-content", "event-content"])
    );

    const sessionList = await store.listSessionsPage("default", 0, 20, "approval");
    assert.deepEqual(
      new Set(sessionList.sessions.map((session) => session.id)),
      new Set(["turn-content", "event-content"])
    );
  } finally {
    await store.close();
  }
});

test("coalesces a new local id onto an existing thread in the same workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-thread-dedupe-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({
      id: "original",
      threadId: "thread-1",
      workspaceId: "default",
      title: "Original"
    });

    const coalesced = await store.upsertSession({
      id: "local_new",
      threadId: "thread-1",
      workspaceId: "default",
      title: "Should not create a duplicate"
    });

    assert.equal(coalesced.id, "original");
    const rows = await store.runSqlQuery({
      sql: "SELECT id FROM sessions WHERE thread_id = 'thread-1' ORDER BY id"
    });
    assert.deepEqual(rows.rows, [{ id: "original" }]);
  } finally {
    await store.close();
  }
});

test("ignores Codex title sync and thread rename updates", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-title-sync-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({
      id: "pending",
      threadId: "thread-pending",
      workspaceId: "default",
      title: "Fallback title",
      titleSource: "initial"
    });
    await store.upsertSession({
      id: "synced",
      threadId: "thread-synced",
      workspaceId: "default",
      title: "Existing Codex title",
      titleSource: "summarizer"
    });

    await store.markUnsyncedSessionTitlesPending("default", ["thread-synced"]);
    assert.deepEqual(await store.listPendingSessionTitleThreadIds("default"), []);
    assert.equal((await store.getSession("pending"))?.title, "Fallback title");
    assert.equal((await store.getSession("synced"))?.title, "Existing Codex title");

    const pendingUpdated = (await store.getSession("pending"))?.updated;
    assert.deepEqual(
      await store.syncSessionTitles("default", [{ threadId: "thread-pending", title: "Generated title" }]),
      []
    );
    assert.deepEqual(await store.listPendingSessionTitleThreadIds("default"), []);
    assert.equal((await store.getSession("pending"))?.title, "Fallback title");
    assert.equal((await store.getSession("pending"))?.updated, pendingUpdated);
    assert.deepEqual(
      await store.syncSessionTitles("default", [{ threadId: "thread-pending", title: "Generated title" }]),
      []
    );

    const generatedUpdated = (await store.getSession("pending"))?.updated;
    assert.deepEqual(
      await store.syncSessionTitles("default", [{ threadId: "thread-pending", title: "Renamed after sync" }]),
      []
    );
    assert.equal((await store.getSession("pending"))?.title, "Fallback title");
    assert.equal((await store.getSession("pending"))?.updated, generatedUpdated);

    const syncedUpdated = (await store.getSession("synced"))?.updated;
    await store.updateSessionTitle({
      sessionId: "synced",
      threadId: "thread-synced",
      title: "Renamed Codex title",
      source: "codex"
    });
    assert.equal((await store.getSession("synced"))?.title, "Existing Codex title");
    assert.equal((await store.getSession("synced"))?.updated, syncedUpdated);
  } finally {
    await store.close();
  }
});

test("user session titles are frozen until the user changes them again", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-title-frozen-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({
      id: "session-1",
      threadId: "thread-1",
      workspaceId: "default",
      title: "Initial prompt title",
      titleSource: "initial"
    });

    await store.upsertSessionSummary({
      sessionId: "session-1",
      sourceHash: "summary-1",
      sourceTurnCount: 1,
      sourceUpdated: new Date().toISOString(),
      summarizerModel: "test-model",
      title: "Summarizer title",
      keywordWeights: { summary: 1 }
    });
    assert.equal((await store.getSession("session-1"))?.title, "Summarizer title");
    assert.equal((await store.getSession("session-1"))?.titleSource, "summarizer");

    await store.upsertSession({
      id: "session-1",
      title: "User title"
    });
    assert.equal((await store.getSession("session-1"))?.title, "User title");
    assert.equal((await store.getSession("session-1"))?.titleSource, "user");

    await store.upsertSessionSummary({
      sessionId: "session-1",
      sourceHash: "summary-2",
      sourceTurnCount: 2,
      sourceUpdated: new Date().toISOString(),
      summarizerModel: "test-model",
      title: "Blocked summarizer title",
      keywordWeights: { blocked: 1 }
    });
    await store.updateSessionTitle({
      sessionId: "session-1",
      threadId: "thread-1",
      title: "Blocked Codex title",
      source: "codex"
    });
    assert.equal((await store.getSession("session-1"))?.title, "User title");
    assert.equal((await store.getSession("session-1"))?.titleSource, "user");

    await store.upsertSession({
      id: "session-1",
      title: "Second user title"
    });
    assert.equal((await store.getSession("session-1"))?.title, "Second user title");
    assert.equal((await store.getSession("session-1"))?.titleSource, "user");
  } finally {
    await store.close();
  }
});

test("backfills session updated from the last turn without arbitrary SQL execution", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-updated-backfill-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "with-turn", title: "Initial" });
    await store.recordSessionTurn({
      id: "turn-1",
      sessionId: "with-turn",
      userInput: "test",
      agentResponse: "done",
      tokenIn: 0,
      tokenOut: 0
    });
    await store.upsertSession({ id: "without-turn", title: "Initial" });

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({ id: "with-turn", title: "Metadata changed" });
    await store.upsertSession({ id: "without-turn", title: "Metadata changed" });

    assert.deepEqual(await store.backfillSessionUpdatedFromLastTurn(), {
      totalSessions: 2,
      fromLastTurn: 1,
      fromCreated: 1,
      changed: 0
    });

    const rows = await store.runSqlQuery({
      sql: `
        SELECT
          sessions.id,
          CAST(sessions.updated AS VARCHAR) AS updated,
          CAST(coalesce(max(session_turn.created), sessions.created) AS VARCHAR) AS expected
        FROM sessions
        LEFT JOIN session_turn ON session_turn.session_id = sessions.id
        GROUP BY sessions.id, sessions.updated, sessions.created
        ORDER BY sessions.id
      `
    });
    assert.deepEqual(rows.rows, [
      { id: "with-turn", updated: rows.rows[0]?.expected, expected: rows.rows[0]?.expected },
      { id: "without-turn", updated: rows.rows[1]?.expected, expected: rows.rows[1]?.expected }
    ]);

    const withTurnUpdated = (await store.getSession("with-turn"))?.updated;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    await store.upsertSession({ id: "with-turn", description: "Metadata changed later" });
    await store.updateSessionTurn({
      id: "turn-1",
      agentResponse: "updated response",
      tokenIn: 1,
      tokenOut: 1,
      status: "done"
    });
    assert.equal((await store.getSession("with-turn"))?.updated, withTurnUpdated);
    assert.equal((await store.backfillSessionUpdatedFromLastTurn()).changed, 0);
  } finally {
    await store.close();
  }
});

test("auto model starts at Luna high, allows jumps, and rejects downgrades", async () => {
  const store = await createStore();
  try {
    assert.deepEqual(await store.getSessionAutoModel("session-1"), {
      sessionId: "session-1",
      enabled: false,
      model: "gpt-5.6-luna",
      effort: "high",
      revision: 0,
      updated: ""
    });

    const enabled = await store.setSessionAutoModelEnabled("session-1", true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.model, "gpt-5.6-luna");
    assert.equal(enabled.effort, "high");
    assert.equal(enabled.revision, 0);
    assert.equal(await store.claimSessionAutoModelPrompt("session-1"), true);
    assert.equal(await store.claimSessionAutoModelPrompt("session-1"), false);

    const jumped = await store.upgradeSessionAutoModel({
      sessionId: "session-1",
      model: "gpt-5.6-sol",
      effort: "xhigh"
    });
    assert.equal(jumped.model, "gpt-5.6-sol");
    assert.equal(jumped.effort, "xhigh");
    assert.equal(jumped.revision, 1);

    await assert.rejects(
      store.upgradeSessionAutoModel({ sessionId: "session-1", model: "gpt-5.6-terra", effort: "xhigh" }),
      /cannot downgrade/i
    );
    await assert.rejects(
      store.upgradeSessionAutoModel({ sessionId: "session-1", model: "gpt-5.6-sol", effort: "high" }),
      /cannot downgrade/i
    );

    const astra = await store.upgradeSessionAutoModel({ sessionId: "session-1", model: "gpt-6-astra", effort: "ultra" });
    assert.equal(astra.model, "gpt-6-astra");
    await assert.rejects(store.upgradeSessionAutoModel({ sessionId: "session-1", model: "gpt-5.6-sol", effort: "ultra" }), /cannot downgrade/i);
    const nextTurn = await store.selectSessionAutoModel({ sessionId: "session-1", model: "gpt-5.6-luna", effort: "low" });
    assert.equal(nextTurn.model, "gpt-5.6-luna");
    assert.equal(nextTurn.effort, "low");
    assert.equal(nextTurn.revision, astra.revision + 1);
    await assert.rejects(store.selectSessionAutoModel({ sessionId: "session-1", model: "unknown", effort: "low" }), /Invalid/);

    await store.setSessionAutoModelEnabled("session-1", false);
    const restarted = await store.setSessionAutoModelEnabled("session-1", true);
    assert.equal(restarted.model, "gpt-5.6-luna");
    assert.equal(restarted.effort, "high");
    assert.equal(restarted.revision, 0);
    assert.equal(await store.claimSessionAutoModelPrompt("session-1"), true);
  } finally {
    await store.close();
  }
});

test("session model preferences persist the selected gear state", async () => {
  const store = await createStore();
  try {
    assert.deepEqual(await store.getSessionModelPreferences("session-1"), {
      sessionId: "session-1",
      selectedModel: "gpt-5.6-terra",
      selectedEffort: "low",
      gearProfiles: [
        { model: "gpt-5.6-terra", effort: "low" },
        { model: "gpt-5.6-luna", effort: "medium" },
        { model: "gpt-5.6-sol", effort: "high" },
        { model: "gpt-5.6-terra", effort: "xhigh" },
        { model: "gpt-5.6-luna", effort: "high" },
        { model: "gpt-5.6-sol", effort: "xhigh" }
      ],
      activeGearIndex: 0,
      updated: ""
    });

    const saved = await store.setSessionModelPreferences("session-1", {
      selectedModel: "gpt-5.6-sol",
      selectedEffort: "xhigh",
      activeGearIndex: 2,
      gearProfiles: [
        { model: "gpt-5.6-terra", effort: "medium" },
        { model: "gpt-5.6-luna", effort: "high" },
        { model: "gpt-5.6-sol", effort: "xhigh" }
      ]
    });
    assert.equal(saved.selectedModel, "gpt-5.6-sol");
    assert.equal(saved.selectedEffort, "xhigh");
    assert.equal(saved.activeGearIndex, 2);
    assert.deepEqual(saved.gearProfiles, [
      { model: "gpt-5.6-terra", effort: "medium" },
      { model: "gpt-5.6-luna", effort: "high" },
      { model: "gpt-5.6-sol", effort: "xhigh" },
      { model: "gpt-5.6-terra", effort: "xhigh" },
      { model: "gpt-5.6-luna", effort: "high" },
      { model: "gpt-5.6-sol", effort: "xhigh" }
    ]);

    const migratedWorkspacePreferences = await store.getWorkspaceModelPreferences("default");
    assert.equal(migratedWorkspacePreferences.selectedModel, "gpt-5.6-sol");
    assert.deepEqual(migratedWorkspacePreferences.gearProfiles, saved.gearProfiles);
    const sixGears = saved.gearProfiles.map((profile, index) => index === 5
      ? { model: "gpt-5.6-luna", effort: "low" }
      : profile);
    await store.setSessionModelPreferences("session-1", {
      gearProfiles: sixGears,
      activeGearIndex: 5
    });
    const restored = await store.getSessionModelPreferences("session-1");
    assert.equal(restored.activeGearIndex, 5);
    assert.deepEqual(restored.gearProfiles, sixGears);
    assert.equal(restored.selectedModel, "gpt-5.6-luna");
    assert.equal(restored.selectedEffort, "low");
    const auto = await store.setSessionModelPreferences("session-1", {
      gearProfiles: sixGears.map((profile, index) => index === 5 ? { model: "auto", effort: "high" } : profile),
      activeGearIndex: 5
    });
    assert.equal(auto.gearProfiles.length, 6);
    assert.equal(auto.activeGearIndex, 5);
    assert.equal(auto.selectedModel, "auto");
    const migrated = await store.setSessionModelPreferences("session-1", {
      gearProfiles: [...sixGears, { model: "auto", effort: "high" }]
    });
    assert.deepEqual(migrated.gearProfiles, sixGears);
  } finally {
    await store.close();
  }
});

test("workspace model preferences are shared by its sessions and isolated from other workspaces", async () => {
  const store = await createStore();
  try {
    await store.upsertWorkspace({
      id: "workspace-two",
      name: "Workspace two",
      codexHome: "/tmp/workspace-two-codex",
      cwd: "/tmp/workspace-two"
    });
    await store.upsertSession({ id: "session-2", workspaceId: "default" });

    const saved = await store.setWorkspaceModelPreferences("default", {
      selectedModel: "gpt-5.6-sol",
      selectedEffort: "xhigh",
      activeGearIndex: 2,
      gearProfiles: [
        { model: "gpt-5.6-terra", effort: "medium" },
        { model: "gpt-5.6-luna", effort: "high" },
        { model: "gpt-5.6-sol", effort: "xhigh" }
      ]
    });
    assert.equal(saved.workspaceId, "default");
    assert.equal(saved.selectedModel, "gpt-5.6-sol");
    assert.equal(saved.activeGearIndex, 2);

    const shared = await store.getWorkspaceModelPreferences("default");
    assert.deepEqual(shared.gearProfiles, saved.gearProfiles);
    assert.equal(shared.selectedEffort, "xhigh");

    const otherWorkspace = await store.getWorkspaceModelPreferences("workspace-two");
    assert.equal(otherWorkspace.workspaceId, "workspace-two");
    assert.equal(otherWorkspace.selectedModel, "gpt-5.6-terra");
    assert.equal(otherWorkspace.activeGearIndex, 0);
  } finally {
    await store.close();
  }
});

test("resolves session references within an explicit workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-reference-workspace-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertWorkspace({
      id: "workspace-a",
      name: "Workspace A",
      codexHome: resolve(root, "codex-a"),
      cwd: root
    });
    await store.upsertWorkspace({
      id: "workspace-b",
      name: "Workspace B",
      codexHome: resolve(root, "codex-b"),
      cwd: root
    });
    await store.upsertSession({ id: "local_a", threadId: "shared-thread", workspaceId: "workspace-a" });
    await store.upsertSession({ id: "local_b", threadId: "shared-thread", workspaceId: "workspace-b" });

    assert.equal((await store.resolveSession({ threadId: "shared-thread", workspaceId: "workspace-a" }))?.id, "local_a");
    assert.equal((await store.resolveSession({ threadId: "shared-thread", workspaceId: "workspace-b" }))?.id, "local_b");
    assert.equal(await store.resolveSession({ sessionId: "local_a", workspaceId: "workspace-b" }), null);
  } finally {
    await store.close();
  }
});

test("background model usage is attributed to its workspace and upserts idempotently", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-background-usage-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  const suffix = crypto.randomUUID();
  const workspaceId = `workspace-${suffix}`;
  const sessionId = `session-${suffix}`;
  const turnId = `turn-${suffix}`;
  const usageId = `background:commentary:${suffix}`;
  await store.ready();
  try {
    await store.upsertWorkspace({
      id: workspaceId,
      name: "Background usage test",
      codexHome: resolve(root, "codex-home"),
      cwd: root
    });
    await store.upsertSession({ id: sessionId, workspaceId });
    await store.upsertAccount({ id: "background-account-a", name: "Background A" });
    await store.upsertAccount({ id: "background-account-b", name: "Background B" });
    await store.recordSessionTurn({
      id: turnId,
      sessionId,
      userInput: "test",
      agentResponse: "",
      tokenIn: 0,
      tokenOut: 0,
      status: "running"
    });
    await store.recordTokenUsage([{
      id: usageId,
      usageType: "background",
      source: "app_server",
      sessionId,
      turnId,
      accountId: "background-account-a",
      model: "gpt-5.6-luna",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      metadata: { task: "commentary_headline" }
    }]);
    await store.recordTokenUsage([{
      id: usageId,
      usageType: "background",
      source: "app_server",
      sessionId,
      turnId,
      accountId: "background-account-b",
      model: "gpt-5.6-luna",
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      metadata: { task: "commentary_headline" }
    }]);

    const result = await store.runSqlQuery({
      sql: `SELECT usage_type, workspace_id, account_id, total_tokens, json_extract_string(metadata, '$.task') AS task
        FROM token_usage WHERE id = $id`,
      params: { id: usageId },
      limit: 1
    });
    assert.deepEqual(result.rows, [{
      usage_type: "background",
      workspace_id: workspaceId,
      account_id: "background-account-b",
      total_tokens: 14,
      task: "commentary_headline"
    }]);
  } finally {
    await store.close();
  }
});
