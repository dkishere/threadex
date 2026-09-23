import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CONTEXT_FORK_USER_SUFFIX } from "../contextFork.js";
import { openPostgresSessionConnection, postgresSchemaFromStoreId } from "./sessionDb.js";
import { SessionStore } from "./sessionStore.js";

test("in-progress Codex app imports keep their newest activity timestamp", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-in-progress-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "09", "04");
  const sessionId = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-09-04T08-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  const records = [
    { timestamp: "2026-09-04T08:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
    { timestamp: "2026-09-04T08:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "old-turn" } },
    { timestamp: "2026-09-04T08:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: "old-turn", message: "old completed work" } },
    { timestamp: "2026-09-04T08:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "old-turn" } },
    { timestamp: "2026-09-04T09:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } },
    { timestamp: "2026-09-04T09:00:01Z", type: "event_msg", payload: { type: "user_message", turn_id: "new-turn", message: "new work still running" } }
  ];
  writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  const store = new SessionStore(resolve(root, "in-progress.postgres"));
  try {
    await store.ready();
    const imported = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    const localSessionId = `tx_${sessionId}`;

    assert.equal(await store.hasIncompleteImportedLocalTurns(localSessionId), true);
    assert.equal((await store.listSessionTurns(localSessionId)).length, 1);
    assert.equal(Date.parse((await store.getSession(localSessionId))?.updated ?? ""), Date.parse("2026-09-04T09:00:01Z"));

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ timestamp: "2026-09-04T09:00:02Z", type: "event_msg", payload: { type: "task_complete", turn_id: "new-turn" } })}\n`
    );
    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.equal(await store.hasIncompleteImportedLocalTurns(localSessionId), false);
    assert.equal((await store.listSessionTurns(localSessionId)).length, 2);
  } finally {
    await store.close();
  }
});

test("local-session import upserts final live items without item snapshot events", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "10");
  const dbPath = resolve(root, "import.postgres");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const turnId = "turn-import-1";
  const output = "x".repeat(70_000);
  const customToolOutput = `first line\n${output}`;
  mkdirSync(sessionsDir, { recursive: true });
  const records = [
    { timestamp: "2026-07-10T10:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
    { timestamp: "2026-07-10T10:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { timestamp: "2026-07-10T10:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "run it" } },
    {
      timestamp: "2026-07-10T10:00:03Z",
      type: "response_item",
      payload: { type: "custom_tool_call", turn_id: turnId, id: "item-1", call_id: "call-1", name: "exec", input: "printf output" }
    },
    {
      timestamp: "2026-07-10T10:00:04Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        turn_id: turnId,
        call_id: "call-1",
        output: [
          { type: "input_text", text: "first line" },
          { type: "input_text", text: output }
        ]
      }
    },
    {
      timestamp: "2026-07-10T10:00:05Z",
      type: "response_item",
      payload: {
        type: "function_call",
        turn_id: turnId,
        id: "agent-spawn-1",
        call_id: "agent-call-1",
        name: "spawn_agent",
        namespace: "collaboration",
        arguments: JSON.stringify({ task_name: "inspect_tests", message: "Inspect the API tests" })
      }
    },
    {
      timestamp: "2026-07-10T10:00:06Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        turn_id: turnId,
        call_id: "agent-call-1",
        output: JSON.stringify({ task_name: "/root/inspect_tests" })
      }
    },
    {
      timestamp: "2026-07-10T10:00:07Z",
      type: "response_item",
      payload: {
        type: "function_call",
        turn_id: turnId,
        id: "agent-list-1",
        call_id: "agent-call-2",
        name: "list_agents",
        namespace: "collaboration",
        arguments: "{}"
      }
    },
    {
      timestamp: "2026-07-10T10:00:08Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        turn_id: turnId,
        call_id: "agent-call-2",
        output: JSON.stringify({
          agents: [{ agent_name: "/root/inspect_tests", agent_status: { completed: "Found two missing cases." }, last_task_message: null }]
        })
      }
    },
    {
      timestamp: "2026-07-10T10:00:09Z",
      type: "response_item",
      payload: {
        type: "function_call",
        turn_id: turnId,
        id: "agent-wait-1",
        call_id: "agent-call-3",
        name: "wait_agent",
        namespace: "collaboration",
        arguments: JSON.stringify({ timeout_ms: 20_000 })
      }
    },
    {
      timestamp: "2026-07-10T10:00:10Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        turn_id: turnId,
        call_id: "agent-call-3",
        output: JSON.stringify({ message: "Wait timed out.", timed_out: true })
      }
    },
    { timestamp: "2026-07-10T10:00:11Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }
  ];
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-10T10-00-00-${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );

  const runImport = () => spawnSync(process.execPath, [
    "scripts/import-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const imported = runImport();
    assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  }

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const rows = await store.runSqlQuery({
      sql: `SELECT
        count(*) AS live_count,
        max(CAST(json_extract(payload, '$.aggregatedOutputLength') AS BIGINT)) AS output_length,
        max(octet_length(encode(json_extract_string(payload, '$.aggregatedOutput')))) AS output_bytes
      FROM session_live_item`
    });
    assert.deepEqual(rows.rows, [{ live_count: 3, output_length: customToolOutput.length, output_bytes: 64 * 1024 }]);
    const inspected = await store.inspectSession({ sessionId: `tx_${sessionId}`, includeLiveItems: true });
    const command = (inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>)
      .find((item) => item.itemType === "command_execution");
    assert.equal(command?.aggregatedOutputLength, customToolOutput.length);
    assert.match(String(command?.aggregatedOutput), /^\[output truncated: omitted 4,475 chars\]\n/);
    assert.ok(String(command?.aggregatedOutput).endsWith(output.slice(-(64 * 1024))));
    const subagents = (inspected?.turns[0]?.liveItems as Array<Record<string, unknown>>)
      .filter((item) => item.itemType === "subagent");
    assert.equal(subagents.length, 2);
    assert.equal(subagents[0]?.label, "/root/inspect_tests");
    assert.equal(subagents[0]?.prompt, "Inspect the API tests");
    assert.deepEqual(subagents[1]?.agents, [{
      id: "/root/inspect_tests",
      name: "/root/inspect_tests",
      status: "completed",
      message: "Found two missing cases."
    }]);
    const itemEvents = await store.runSqlQuery({
      sql: "SELECT count(*) AS item_events FROM session_turn_event WHERE event_name = 'item' OR starts_with(event_name, 'local.response_item')"
    });
    assert.deepEqual(itemEvents.rows, [{ item_events: 0 }]);
  } finally {
    await store.close();
  }
});

test("local-session import keeps an interrupted delegated turn", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-interrupted-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "17");
  const dbPath = resolve(root, "interrupted.postgres");
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const turnId = "turn-interrupted";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-07-17T09-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-17T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-17T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      {
        timestamp: "2026-07-17T09:00:02Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
          content: [{ type: "input_text", text: "<recommended_plugins>\ncontext only\n</recommended_plugins>" }]
        }
      },
      {
        timestamp: "2026-07-17T09:00:03Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
          content: [{ type: "input_text", text: "<codex_delegation>\n<input>Repair the interrupted task</input>\n</codex_delegation>" }]
        }
      },
      { timestamp: "2026-07-17T09:00:04Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, message: "Started the repair." } },
      { timestamp: "2026-07-17T09:00:05Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    const turns = await store.listSessionTurns(`tx_${sessionId}`);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.userInput, "Repair the interrupted task");
    assert.equal(turns[0]?.agentResponse, "Started the repair.\n\n_Turn interrupted by user before completion._");
    assert.equal(turns[0]?.lastEventName, "local.hook_imported_aborted");
    assert.equal(turns[0]?.status, "done");
  } finally {
    await store.close();
  }
});

test("local-session import preserves parent metadata for nested Codex tasks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-parent-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "18");
  const dbPath = resolve(root, "import.postgres");
  const parentSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const childSessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-18T09-00-00-${parentSessionId}.jsonl`),
    [
      { timestamp: "2026-07-18T09:00:00Z", type: "session_meta", payload: { id: parentSessionId, cwd: root } },
      { timestamp: "2026-07-18T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-parent" } },
      { timestamp: "2026-07-18T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: "turn-parent", message: "parent task" } },
      { timestamp: "2026-07-18T09:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-parent" } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-18T09-05-00-${childSessionId}.jsonl`),
    [
      {
        timestamp: "2026-07-18T09:05:00Z",
        type: "session_meta",
        payload: { id: childSessionId, cwd: root, parent_session_id: parentSessionId }
      },
      { timestamp: "2026-07-18T09:05:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-child" } },
      { timestamp: "2026-07-18T09:05:02Z", type: "event_msg", payload: { type: "user_message", turn_id: "turn-child", message: "child task" } },
      { timestamp: "2026-07-18T09:05:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-child" } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const imported = spawnSync(process.execPath, [
    "scripts/import-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const child = await store.getSession(`tx_${childSessionId}`);
    assert.equal(child?.parentSessionId, `tx_${parentSessionId}`);
  } finally {
    await store.close();
  }
});

test("local-session sync detects modified sessions, missing turns, and delegates to the standard importer", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-sync-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "11");
  const dbPath = resolve(root, "sync.postgres");
  const sessionId = "22222222-3333-4444-8555-666666666666";
  const turnId = "turn-sync-1";
  const rolloutPath = resolve(sessionsDir, `rollout-2026-07-11T09-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    rolloutPath,
    [
      { timestamp: "2026-07-11T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-11T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-11T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "sync me" } },
      { timestamp: "2026-07-11T09:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Sync test", updated_at: "2026-07-11T09:00:03Z" })}\n`,
  );

  const runSync = (...args: string[]) => spawnSync(process.execPath, [
    "scripts/sync-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events",
    ...args,
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });

  const missing = runSync("--check");
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /1 stale or missing/);

  const synced = runSync();
  assert.equal(synced.status, 0, syncOutput(synced));
  assert.match(synced.stdout, /standard local-session importer/);
  assert.match(synced.stdout, /now in sync/);

  const current = runSync("--check");
  assert.equal(current.status, 0, syncOutput(current));
  assert.match(current.stdout, /0 stale or missing/);

  const connection = await openPostgresSessionConnection(undefined, postgresSchemaFromStoreId(dbPath));
  try {
    await connection.run("DELETE FROM session_turn WHERE id = $turnId", { turnId });
  } finally {
    await connection.close();
  }

  const missingTurn = runSync("--check");
  assert.equal(missingTurn.status, 1, missingTurn.stderr);
  assert.match(missingTurn.stdout, /source turn id is missing from manager/);

  const resynced = runSync();
  assert.equal(resynced.status, 0, syncOutput(resynced));
  assert.match(resynced.stdout, /now in sync/);

  appendFileSync(
    rolloutPath,
    `${JSON.stringify({ timestamp: "2026-07-11T09:01:00Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, message: "new action" } })}\n`,
  );
  writeFileSync(
    resolve(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: sessionId, thread_name: "Sync test", updated_at: "2026-07-11T09:01:00Z" })}\n`,
  );

  const stale = runSync("--check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stdout, /source modified_at changed|manager last action is older/);
});

test("local-session sync follows importer session_meta id precedence", () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-sync-meta-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "12");
  const dbPath = resolve(root, "sync-meta.postgres");
  const filenameSessionId = "33333333-4444-4555-8666-777777777777";
  const finalSessionId = "44444444-5555-4666-8777-888888888888";
  const turnId = "turn-sync-meta-1";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-12T09-00-00-${filenameSessionId}.jsonl`),
    [
      { timestamp: "2026-07-12T09:00:00Z", type: "session_meta", payload: { id: filenameSessionId, session_id: filenameSessionId, cwd: root } },
      { timestamp: "2026-07-12T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-12T09:00:02Z", type: "session_meta", payload: { id: finalSessionId, session_id: finalSessionId, cwd: root } },
      { timestamp: "2026-07-12T09:00:03Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "sync meta" } },
      { timestamp: "2026-07-12T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const runSync = (...args: string[]) => spawnSync(process.execPath, [
    "scripts/sync-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events",
    ...args,
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });

  const synced = runSync();
  assert.equal(synced.status, 0, syncOutput(synced));

  const current = runSync("--check");
  assert.equal(current.status, 0, syncOutput(current));
  assert.match(current.stdout, /0 stale or missing/);
});

test("local-session sync imports default workspace codex-home sessions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-default-sync-test-"));
  const codexHome = resolve(root, "empty-local-codex-home");
  const defaultCodexHome = resolve(root, "default-workspace-codex-home");
  const sessionsDir = resolve(defaultCodexHome, "sessions", "2026", "07", "15");
  const dbPath = resolve(root, "default-sync.postgres");
  const sessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const turnId = "turn-default-sync-1";
  const rolloutPath = resolve(sessionsDir, `rollout-2026-07-15T09-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    rolloutPath,
    [
      { timestamp: "2026-07-15T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-15T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-15T09:00:01Z", type: "turn_context", payload: { turn_id: turnId, model: "gpt-5.6-luna" } },
      { timestamp: "2026-07-15T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "default workspace sync me" } },
      { timestamp: "2026-07-15T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "synced default" } },
      {
        timestamp: "2026-07-15T09:00:03Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          turn_id: turnId,
          info: {
            last_token_usage: { input_tokens: 20, output_tokens: 5 },
            total_token_usage: { input_tokens: 200, output_tokens: 50 }
          }
        }
      },
      { timestamp: "2026-07-15T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const runSync = (...args: string[]) => spawnSync(process.execPath, [
    "scripts/sync-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events",
    ...args,
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: defaultCodexHome,
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });

  const missing = runSync("--check");
  assert.equal(missing.status, 1, syncOutput(missing));
  assert.match(missing.stdout, /1 stale or missing/);

  const synced = runSync();
  assert.equal(synced.status, 0, syncOutput(synced));

  const current = runSync("--check");
  assert.equal(current.status, 0, syncOutput(current));
  assert.match(current.stdout, /1\/1 session file\(s\) current; 0 stale or missing/);

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const session = await store.getSession(`tx_${sessionId}`);
    assert.equal(session?.workspaceId, "default");
    assert.equal(session?.title, "default workspace sync me");
    const page = await store.listSessionsPage("default", 0, 20);
    assert.deepEqual(page.sessions.find((candidate) => candidate.id === `tx_${sessionId}`)?.modelTokenUsage, [
      { model: "gpt-5.6-luna", tokenCount: 25, inputTokenCount: 20, cachedInputTokenCount: 0, outputTokenCount: 5 }
    ]);
    assert.deepEqual(await store.listImportedLocalCodexSessionFilePaths("default"), [rolloutPath]);
    const fileRows = await store.runSqlQuery({
      sql: "SELECT path, workspace_id, session_id FROM local_session_file ORDER BY path"
    });
    assert.deepEqual(fileRows.rows, [{
      path: rolloutPath,
      workspace_id: "default",
      session_id: `tx_${sessionId}`
    }]);
  } finally {
    await store.close();
  }
});

test("local-session sync trusts file mtime when a transcript has malformed JSONL", async () => {
  // @ts-expect-error The production sync CLI is intentionally plain JavaScript.
  const { compareSessions } = await import("../../scripts/sync-local-sessions.mjs");
  const comparison = compareSessions(
    [{
      path: "/tmp/malformed-transcript.jsonl",
      sessionId: "local_malformed",
      threadId: "malformed",
      turnIds: ["source-turn"],
      hasParseErrors: true,
      modifiedAt: "2026-08-24T12:00:00.000Z",
      lastActionAt: null,
    }],
    [{
      path: "/tmp/malformed-transcript.jsonl",
      sessionId: "local_malformed",
      threadId: "malformed",
      allTurnIds: new Set(),
      importedTurnCount: 1,
      storedTurnCount: 0,
      fileModifiedAt: "2026-08-24T12:00:00.000Z",
      lastActionAt: null,
    }],
  );

  assert.equal(comparison.stale.length, 0);
  assert.equal(comparison.current.length, 1);
});

test("local-session sync accepts existing manager session ids for matching thread", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-threadex-id-sync-test-"));
  const codexHome = resolve(root, "empty-local-codex-home");
  const defaultCodexHome = resolve(root, "default-workspace-codex-home");
  const sessionsDir = resolve(defaultCodexHome, "sessions", "2026", "07", "16");
  const dbPath = resolve(root, "manager-id-sync.postgres");
  const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const turnId = "turn-manager-id-sync-1";
  const rolloutPath = resolve(sessionsDir, `rollout-2026-07-16T09-00-00-${threadId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    rolloutPath,
    [
      { timestamp: "2026-07-16T09:00:00Z", type: "session_meta", payload: { id: threadId, cwd: root } },
      { timestamp: "2026-07-16T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-16T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "sync existing manager id" } },
      { timestamp: "2026-07-16T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "existing id synced" } },
      { timestamp: "2026-07-16T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "manager-session-1",
      threadId,
      workspaceId: "default",
      cwd: root,
      title: "Existing manager session",
    });
  } finally {
    await store.close();
  }

  const runSync = (...args: string[]) => spawnSync(process.execPath, [
    "scripts/sync-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events",
    ...args,
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: defaultCodexHome,
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });

  const synced = runSync();
  assert.equal(synced.status, 0, syncOutput(synced));

  const current = runSync("--check");
  assert.equal(current.status, 0, syncOutput(current));
  assert.match(current.stdout, /1\/1 session file\(s\) current; 0 stale or missing/);

  const verifiedStore = new SessionStore(dbPath);
  try {
    await verifiedStore.ready();
    const session = await verifiedStore.getSession("manager-session-1");
    assert.equal(session?.threadId, threadId);
    assert.equal(session?.workspaceId, "default");
    const fileRows = await verifiedStore.runSqlQuery({
      sql: "SELECT path, workspace_id, session_id FROM local_session_file ORDER BY path"
    });
    assert.deepEqual(fileRows.rows, [{
      path: rolloutPath,
      workspace_id: "default",
      session_id: "manager-session-1"
    }]);
  } finally {
    await verifiedStore.close();
  }
});

test("local-session import and sync ignore maintenance summarizer sessions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-sync-summarizer-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "13");
  const dbPath = resolve(root, "sync-summarizer.postgres");
  const summarizerSessionId = "55555555-6666-4777-8888-999999999999";
  const normalSessionId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  mkdirSync(sessionsDir, { recursive: true });

  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-13T09-00-00-${summarizerSessionId}.jsonl`),
    [
      { timestamp: "2026-07-13T09:00:00Z", type: "session_meta", payload: { id: summarizerSessionId, cwd: root } },
      { timestamp: "2026-07-13T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-summarizer-1" } },
      {
        timestamp: "2026-07-13T09:00:02Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: "turn-summarizer-1",
          message: [
            "You are a keyword-first session metadata generator for a coding workspace.",
            "Read the compact turn log and output only retrieval-friendly keywords.",
            "",
            "TURN LOG:",
            "#1",
            "in: fix the session search"
          ].join("\n")
        }
      },
      { timestamp: "2026-07-13T09:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-summarizer-1" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-13T09-10-00-${normalSessionId}.jsonl`),
    [
      { timestamp: "2026-07-13T09:10:00Z", type: "session_meta", payload: { id: normalSessionId, cwd: root } },
      { timestamp: "2026-07-13T09:10:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-normal-1" } },
      {
        timestamp: "2026-07-13T09:10:02Z",
        type: "event_msg",
        payload: { type: "user_message", turn_id: "turn-normal-1", message: "summarizer should not create sessions" }
      },
      { timestamp: "2026-07-13T09:10:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-normal-1" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const runSync = (...args: string[]) => spawnSync(process.execPath, [
    "scripts/sync-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events",
    ...args,
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      SESSION_LOCAL_SYNC_QUIET_MS: "0",
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });

  const synced = runSync();
  assert.equal(synced.status, 0, syncOutput(synced));

  const current = runSync("--check");
  assert.equal(current.status, 0, syncOutput(current));
  assert.match(current.stdout, /1\/1 session file\(s\) current; 0 stale or missing/);

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const sessionRows = await store.runSqlQuery({ sql: "SELECT id FROM sessions ORDER BY id" });
    assert.deepEqual(sessionRows.rows, [{ id: `tx_${normalSessionId}` }]);
    const fileRows = await store.runSqlQuery({ sql: "SELECT DISTINCT session_id FROM local_session_file WHERE session_id IS NOT NULL ORDER BY session_id" });
    assert.deepEqual(fileRows.rows, [{ session_id: `tx_${normalSessionId}` }]);
  } finally {
    await store.close();
  }
});

test("server-side local Codex hook import upserts transcript into an existing matching session", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-hook-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "14");
  const dbPath = resolve(root, "hook-import.postgres");
  const sessionId = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";
  const turnId = "turn-hook-import-1";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-07-14T09-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-14T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-14T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-14T09:00:01Z", type: "turn_context", payload: { turn_id: turnId, model: "gpt-5.6-terra" } },
      {
        timestamp: "2026-07-14T09:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
          content: [{ type: "input_text", text: "<recommended_plugins>\nplugin context\n</recommended_plugins>" }]
        }
      },
      {
        timestamp: "2026-07-14T09:00:02Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: turnId,
          message: [
            "<recommended_plugins>",
            "plugin context",
            "</recommended_plugins>",
            "# AGENTS.md instructions for /tmp/repo",
            "",
            "User request:",
            "hook sync me"
          ].join("\n")
        }
      },
      {
        timestamp: "2026-07-14T09:00:02.250Z",
        type: "response_item",
        payload: {
          type: "function_call",
          turn_id: turnId,
          id: "hook-command-1",
          call_id: "hook-call-1",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "printf hook" })
        }
      },
      {
        timestamp: "2026-07-14T09:00:02.500Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          turn_id: turnId,
          call_id: "hook-call-1",
          output: "hook output\nProcess exited with code 0"
        }
      },
      { timestamp: "2026-07-14T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "hook synced" } },
      {
        timestamp: "2026-07-14T09:00:03Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "hook-message-1",
          role: "assistant",
          content: [{ type: "output_text", text: "hook synced" }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      },
      {
        timestamp: "2026-07-14T09:00:04Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          turn_id: turnId,
          info: {
            last_token_usage: { input_tokens: 12, output_tokens: 7 },
            total_token_usage: { input_tokens: 112, output_tokens: 57 }
          }
        }
      },
      { timestamp: "2026-07-14T09:00:05Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "local_existing-manager-session",
      threadId: sessionId,
      workspaceId: "default",
      cwd: root,
      title: "Existing manager session",
    });
    const imported = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.equal(imported.skipped, false);
    assert.equal(imported.sessionId, "local_existing-manager-session");
    assert.equal(imported.turns, 1);
    assert.equal((await store.getSession("tx_existing-manager-session"))?.id, "local_existing-manager-session");
    const aliasInspection = await store.inspectSession({ sessionId: "tx_existing-manager-session", includeLiveItems: true });
    assert.equal(aliasInspection?.session.id, "local_existing-manager-session");
    const importedAgain = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.equal(importedAgain.sessionId, "local_existing-manager-session");
    assert.equal(await store.getSession("tx_" + sessionId), null);

    const session = await store.getSession("local_existing-manager-session");
    assert.equal(session?.title, "hook sync me");
    const turns = await store.listSessionTurns("local_existing-manager-session");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.id, turnId);
    assert.equal(turns[0]?.userInput, "hook sync me");
    assert.equal(turns[0]?.agentResponse, "hook synced");
    assert.equal(turns[0]?.model, "gpt-5.6-terra");
    assert.equal(turns[0]?.tokenIn, 12);
    assert.equal(turns[0]?.tokenOut, 7);
    const page = await store.listSessionsPage("default", 0, 20);
    assert.deepEqual(page.sessions.find((candidate) => candidate.id === "local_existing-manager-session")?.modelTokenUsage, [
      { model: "gpt-5.6-terra", tokenCount: 19, inputTokenCount: 12, cachedInputTokenCount: 0, outputTokenCount: 7 }
    ]);
    const inspected = await store.inspectSession({ sessionId: "local_existing-manager-session", includeLiveItems: true });
    const liveItems = ((inspected?.turns[0]?.liveItems ?? []) as Array<Record<string, unknown>>)
      .map(({ sortCreated, sortEventId, ...item }) => item);
    assert.deepEqual(liveItems, [{
      id: "hook-command-1",
      eventType: "item.completed",
      itemType: "command_execution",
      command: "printf hook",
      aggregatedOutput: "hook output\nProcess exited with code 0",
      aggregatedOutputLength: 38,
      exitCode: 0,
      status: "completed"
    }]);

    const files = await store.runSqlQuery({
      sql: "SELECT path, session_id, turn_count FROM local_session_file"
    });
    assert.deepEqual(files.rows, [{ path: transcriptPath, session_id: "local_existing-manager-session", turn_count: 1 }]);
  } finally {
    await store.close();
  }
});

test("server-side local Codex import preserves a live manager retry and reconciles it after the watchdog stops it", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-managed-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "14");
  const dbPath = resolve(root, "managed-import.postgres");
  const threadId = "77777777-8888-4999-aaaa-cccccccccccc";
  const historicalTurnId = "external-history-turn-1";
  const nativeTurnId = "native-managed-turn-1";
  const retryTurnId = "native-managed-turn-2";
  const managerTurnId = "manager-turn-1";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-07-14T10-00-00-${threadId}.jsonl`);
  const nowMs = Date.now();
  const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: at(-65_000), type: "session_meta", payload: { id: threadId, cwd: root } },
      { timestamp: at(-60_000), type: "event_msg", payload: { type: "task_started", turn_id: historicalTurnId } },
      {
        timestamp: at(-59_000),
        type: "event_msg",
        payload: { type: "user_message", turn_id: historicalTurnId, message: "keep this external history" }
      },
      {
        timestamp: at(-58_000),
        type: "event_msg",
        payload: { type: "agent_message", turn_id: historicalTurnId, phase: "final_answer", message: "historical final" }
      },
      { timestamp: at(-57_000), type: "event_msg", payload: { type: "task_complete", turn_id: historicalTurnId } },
      { timestamp: at(60_000), type: "event_msg", payload: { type: "task_started", turn_id: nativeTurnId } },
      {
        timestamp: at(61_000),
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: nativeTurnId,
          message: "solve it"
        }
      },
      {
        timestamp: at(62_000),
        type: "event_msg",
        payload: { type: "agent_message", turn_id: nativeTurnId, phase: "final_answer", message: "native final" }
      },
      { timestamp: at(63_000), type: "event_msg", payload: { type: "task_complete", turn_id: nativeTurnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "local_managed-session",
      threadId,
      workspaceId: "default",
      cwd: root,
      title: "Managed session"
    });

    const legacyImport = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.equal(legacyImport.skipped, false);
    assert.equal((await store.listSessionTurns("local_managed-session")).length, 2);
    assert.equal(await store.isLocalCodexSessionFileStale(transcriptPath, statSync(transcriptPath).mtime), false);

    await store.recordSessionTurn({
      id: managerTurnId,
      sessionId: "local_managed-session",
      userInput: "solve it",
      agentResponse: "manager final",
      tokenIn: 3,
      tokenOut: 2,
      status: "running"
    });
    await store.markSessionTurnRunning({
      id: managerTurnId,
      runnerPid: process.pid,
      runnerLogPath: resolve(root, "manager-runner.ndjson")
    });

    assert.equal(await store.isLocalCodexSessionFileStale(transcriptPath, statSync(transcriptPath).mtime), true);
    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    const liveTurn = await store.getSessionTurn(managerTurnId);
    assert.equal(liveTurn?.status, "running");
    assert.equal(liveTurn?.runnerPid, process.pid);

    const deadRunnerPid = 2_000_000_000;
    await store.markSessionTurnRunning({
      id: managerTurnId,
      runnerPid: deadRunnerPid,
      runnerLogPath: resolve(root, "manager-runner.ndjson")
    });
    assert.equal(await store.linkManagedRunnerNativeTurn({
      sessionId: "local_managed-session",
      managerTurnId,
      nativeTurnId,
      transcriptPath
    }), true);
    assert.equal(await store.updateSessionTurn({
      id: managerTurnId,
      agentResponse: "Prompt runner had no new events. Saved as stopped pending turn.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      runnerExitCode: null,
      pendingReason: "stopped",
      expectedStatus: "running",
      expectedRunnerPid: deadRunnerPid
    }), true);
    const result = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.deepEqual(result, {
      path: transcriptPath,
      sessionId: "local_managed-session",
      threadId,
      turns: 2,
      events: 3,
      skipped: false
    });

    const turns = await store.listSessionTurns("local_managed-session");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.id, historicalTurnId);
    assert.equal(turns[0]?.userInput, "keep this external history");
    assert.equal(turns[1]?.id, managerTurnId);
    assert.equal(turns[1]?.userInput, "solve it");
    assert.equal(turns[1]?.agentResponse, "native final");
    assert.equal(turns[1]?.status, "done");
    assert.equal(turns[1]?.lastEventName, "local.manager_reconciled");
    assert.equal(await store.isLocalCodexSessionFileStale(transcriptPath, statSync(transcriptPath).mtime), false);

    appendFileSync(
      transcriptPath,
      [
        { timestamp: at(120_000), type: "event_msg", payload: { type: "task_started", turn_id: retryTurnId } },
        {
          timestamp: at(121_000),
          type: "event_msg",
          payload: { type: "user_message", turn_id: retryTurnId, message: "Retry the turn and force a Todo plan." }
        },
        {
          timestamp: at(122_000),
          type: "event_msg",
          payload: { type: "agent_message", turn_id: retryTurnId, phase: "final_answer", message: "retry final" }
        },
        { timestamp: at(123_000), type: "event_msg", payload: { type: "task_complete", turn_id: retryTurnId } }
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    const changedMtime = new Date(statSync(transcriptPath).mtime.getTime() + 2_000);
    utimesSync(transcriptPath, changedMtime, changedMtime);
    assert.equal(await store.isLocalCodexSessionFileStale(transcriptPath, statSync(transcriptPath).mtime), true);
    const importedRetry = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.deepEqual(importedRetry, {
      path: transcriptPath,
      sessionId: "local_managed-session",
      threadId,
      turns: 2,
      events: 6,
      skipped: false
    });
    assert.deepEqual(
      (await store.listSessionTurns("local_managed-session")).map((turn) => turn.id),
      [historicalTurnId, managerTurnId, retryTurnId]
    );
    assert.equal(await store.isLocalCodexSessionFileStale(transcriptPath, statSync(transcriptPath).mtime), false);
  } finally {
    await store.close();
  }
});

test("server-side local Codex import skips a context-fork duplicate of the final manager turn", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-context-fork-dedupe-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "09", "01");
  const dbPath = resolve(root, "context-fork-dedupe.postgres");
  const threadId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const nativeTurnId = "native-context-fork-turn";
  const managerTurnId = "manager-context-fork-turn";
  const userRequest = "add an end-to-end test beside the duration configuration test";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-09-01T10-00-00-${threadId}.jsonl`);
  const nowMs = Date.now();
  const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: at(1_000), type: "session_meta", payload: { id: threadId, cwd: root } },
      { timestamp: at(2_000), type: "event_msg", payload: { type: "task_started", turn_id: nativeTurnId } },
      {
        timestamp: at(3_000),
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: nativeTurnId,
          message: `${userRequest}\n\n${CONTEXT_FORK_USER_SUFFIX}`
        }
      },
      {
        timestamp: at(4_000),
        type: "event_msg",
        payload: { type: "agent_message", turn_id: nativeTurnId, phase: "final_answer", message: "Created the child task." }
      },
      { timestamp: at(5_000), type: "event_msg", payload: { type: "task_complete", turn_id: nativeTurnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "local_context-fork-manager-session",
      threadId,
      workspaceId: "default",
      cwd: root,
      title: "Context-fork manager session"
    });
    await store.recordSessionTurn({
      id: managerTurnId,
      sessionId: "local_context-fork-manager-session",
      userInput: userRequest,
      agentResponse: "Created the child task.",
      tokenIn: 0,
      tokenOut: 0,
      status: "running"
    });
    await store.markSessionTurnRunning({
      id: managerTurnId,
      runnerPid: process.pid,
      runnerLogPath: resolve(root, "manager-runner.ndjson")
    });
    await store.updateSessionTurn({
      id: managerTurnId,
      agentResponse: "Created the child task.",
      tokenIn: 0,
      tokenOut: 0,
      status: "done",
      runnerExitCode: 0
    });

    const imported = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.deepEqual(imported, {
      path: transcriptPath,
      sessionId: "local_context-fork-manager-session",
      threadId,
      turns: 0,
      events: 0,
      skipped: true
    });
    const turns = await store.listSessionTurns("local_context-fork-manager-session");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.id, managerTurnId);
    assert.equal(turns[0]?.userInput, userRequest);
  } finally {
    await store.close();
  }
});

test("server-side local Codex import does not duplicate an interrupted stopped turn with managed task framing", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-stopped-managed-import-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "08", "27");
  const dbPath = resolve(root, "stopped-managed-import.postgres");
  const threadId = "88888888-9999-4aaa-bbbb-dddddddddddd";
  const nativeTurnId = "native-stopped-managed-turn";
  const managerTurnId = "manager-stopped-turn";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-08-27T10-00-00-${threadId}.jsonl`);
  const nowMs = Date.now();
  const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  const originalRequest = "add E2E coverage for the hard gate";
  const managedPrompt = [
    "Implement the requested browser hard-gate coverage.",
    "",
    `User request: ${originalRequest}`,
    "",
    "Use the existing deterministic local test harness."
  ].join("\n");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: at(1_000), type: "session_meta", payload: { id: threadId, cwd: root } },
      { timestamp: at(2_000), type: "event_msg", payload: { type: "task_started", turn_id: nativeTurnId } },
      {
        timestamp: at(3_000),
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: nativeTurnId,
          message: `<environment_context>native context</environment_context>\nUser request: ${originalRequest}\n\nUse the existing deterministic local test harness.`
        }
      },
      {
        timestamp: at(4_000),
        type: "event_msg",
        payload: { type: "agent_message", turn_id: nativeTurnId, message: "I will inspect the harness first." }
      },
      { timestamp: at(5_000), type: "event_msg", payload: { type: "turn_aborted", turn_id: nativeTurnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "local_stopped-managed-session",
      threadId,
      workspaceId: "default",
      cwd: root,
      title: "Stopped managed session"
    });
    await store.recordSessionTurn({
      id: managerTurnId,
      sessionId: "local_stopped-managed-session",
      userInput: managedPrompt,
      agentResponse: "Agent stopped. Turn saved as todo and can be retried.",
      tokenIn: 0,
      tokenOut: 0,
      status: "running"
    });
    await store.markSessionTurnRunning({
      id: managerTurnId,
      runnerPid: process.pid,
      runnerLogPath: resolve(root, "manager-runner.ndjson")
    });
    await store.updateSessionTurn({
      id: managerTurnId,
      agentResponse: "Agent stopped. Turn saved as todo and can be retried.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "stopped"
    });

    const imported = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.deepEqual(imported, {
      path: transcriptPath,
      sessionId: "local_stopped-managed-session",
      threadId,
      turns: 0,
      events: 0,
      skipped: true
    });
    const turns = await store.listSessionTurns("local_stopped-managed-session");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.id, managerTurnId);
    assert.equal(turns[0]?.status, "todo");
    assert.equal(turns[0]?.pendingReason, "stopped");
    assert.equal(turns[0]?.userInput, managedPrompt);
  } finally {
    await store.close();
  }
});

test("server-side local Codex import can use the source workspace instead of cwd heuristic", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-workspace-override-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "15");
  const dbPath = resolve(root, "workspace-override.postgres");
  const sessionId = "88888888-9999-4aaa-8bbb-cccccccccccc";
  const turnId = "turn-workspace-override-1";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-07-15T09-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-15T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: resolve(import.meta.dirname, "../..") } },
      { timestamp: "2026-07-15T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-15T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: "workspace override sync" } },
      { timestamp: "2026-07-15T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "done" } },
      { timestamp: "2026-07-15T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const imported = await store.importLocalCodexSessionFile({
      path: transcriptPath,
      codexHome,
      workspaceId: "default"
    });
    assert.equal(imported.skipped, false);
    const session = await store.getSession(`tx_${sessionId}`);
    assert.equal(session?.workspaceId, "default");
  } finally {
    await store.close();
  }
});

test("local-session CLI import stores only the real user request from context-wrapped transcripts", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-import-context-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "07", "16");
  const dbPath = resolve(root, "context-import.postgres");
  const sessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const turnId = "turn-context-import-1";
  const objective = "dedupe importer content";
  const wrappedPrompt = [
    "<codex_internal_context source=\"goal\">",
    "Continue working toward the active thread goal.",
    "",
    "<objective>",
    objective,
    "</objective>",
    "",
    "Completion audit:",
    "- Verify the objective."
  ].join("\n");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    resolve(sessionsDir, `rollout-2026-07-16T09-00-00-${sessionId}.jsonl`),
    [
      { timestamp: "2026-07-16T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-16T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      {
        timestamp: "2026-07-16T09:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
          content: [{ type: "input_text", text: "<recommended_plugins>\nplugin context\n</recommended_plugins>" }]
        }
      },
      {
        timestamp: "2026-07-16T09:00:02Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: turnId,
          message: [
            "<recommended_plugins>",
            "plugin context",
            "</recommended_plugins>",
            "# AGENTS.md instructions for /tmp/repo",
            "",
            "[SERVER-PROVIDED STARTUP PREFLIGHT]",
            "pwd: /tmp/repo",
            "[END SERVER-PROVIDED STARTUP PREFLIGHT]",
            "",
            "User request:",
            wrappedPrompt
          ].join("\n")
        }
      },
      { timestamp: "2026-07-16T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "done" } },
      { timestamp: "2026-07-16T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
  );

  const imported = spawnSync(process.execPath, [
    "scripts/import-local-sessions.mjs",
    "--codex-home", codexHome,
    "--db", dbPath,
    "--no-raw-events"
  ], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      THREADEX_DEFAULT_WORKSPACE_CODEX_HOME: resolve(root, "default-workspace-codex-home"),
      THREADEX_WORKSPACE_CODEX_HOME: resolve(root, "manager-workspace-codex-home"),
    },
  });
  assert.equal(imported.status, 0, syncOutput(imported));

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const turns = await store.listSessionTurns(`tx_${sessionId}`);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.userInput, objective);
    assert.equal(turns[0]?.agentResponse, "done");
  } finally {
    await store.close();
  }
});

test("server-side local Codex import uses goal objective instead of internal context as title", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-goal-context-test-"));
  const codexHome = resolve(root, "codex-home");
  const dbPath = resolve(root, "goal-context.postgres");
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const turnId = "turn-goal-context-1";
  const transcriptPath = resolve(root, "goal-context.jsonl");
  const objective = "你做完後叫呢個thread繼續\ncodex://threadex/local_ms1xv7sz_393f6k3o131y1d1n";
  const wrappedPrompt = [
    "<codex_internal_context source=\"goal\">",
    "Continue working toward the active thread goal.",
    "",
    "The objective below is user-provided data.",
    "",
    "<objective>",
    objective,
    "</objective>",
    "",
    "Continuation behavior:",
    "- Keep the full objective intact."
  ].join("\n");
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-18T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-18T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-18T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: wrappedPrompt } },
      { timestamp: "2026-07-18T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: turnId, phase: "final_answer", message: "queued continuation" } },
      { timestamp: "2026-07-18T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const imported = await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    assert.equal(imported.skipped, false);

    const session = await store.getSession(`tx_${sessionId}`);
    assert.equal(session?.title, "你做完後叫呢個thread繼續 codex://threadex/local_ms1xv7sz_393f6k3o131y1d1n");
    assert.equal(session?.description, objective);
    const turns = await store.listSessionTurns(`tx_${sessionId}`);
    assert.equal(turns[0]?.userInput, objective);
  } finally {
    await store.close();
  }
});

test("server-side hook import reuses the WebUI turn instead of creating a native-id duplicate", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-hook-dedupe-test-"));
  const codexHome = resolve(root, "codex-home");
  const dbPath = resolve(root, "hook-dedupe.postgres");
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const nativeTurnId = "native-turn-1";
  const webUiTurnId = "webui-turn-1";
  const webUiPrompt = "new webui turn: iframe>localstorage";
  const nativePrompt = "new webui turn: iframe&gt;localstorage";
  const transcriptPath = resolve(root, "hook-transcript.jsonl");
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-17T09:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-07-17T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: nativeTurnId } },
      { timestamp: "2026-07-17T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: nativeTurnId, message: nativePrompt } },
      { timestamp: "2026-07-17T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: nativeTurnId, phase: "final_answer", message: "native final" } },
      { timestamp: "2026-07-17T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: nativeTurnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: "local_webui-session",
      threadId: sessionId,
      workspaceId: "default",
      cwd: root,
      title: "WebUI session"
    });
    await store.recordSessionTurn({
      id: webUiTurnId,
      sessionId: "local_webui-session",
      userInput: webUiPrompt,
      agentResponse: "streamed final",
      tokenIn: 1,
      tokenOut: 2,
      status: "done"
    });
    await store.recordSessionTurnEvent({
      id: "webui-result-event",
      turnId: webUiTurnId,
      sessionId: "local_webui-session",
      eventName: "result",
      payload: { reply: "streamed final" }
    });

    // Model a legacy hook row already written beside the managed WebUI turn.
    // (A session_turn id is globally unique, so importing the transcript into
    // its own local session first cannot construct this same-session case.)
    await store.recordSessionTurn({
      id: nativeTurnId,
      sessionId: "local_webui-session",
      userInput: `${nativePrompt}\n\n${CONTEXT_FORK_USER_SUFFIX}`,
      agentResponse: "native final",
      tokenIn: 1,
      tokenOut: 1,
      status: "done"
    });
    await store.recordSessionTurnEvent({
      id: "native-imported-event",
      turnId: nativeTurnId,
      sessionId: "local_webui-session",
      eventName: "local.hook_imported",
      payload: {}
    });
    assert.equal(await store.dedupeImportedTurnRows(), 1);

    const turns = await store.listSessionTurns("local_webui-session");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.id, webUiTurnId);
    assert.equal(turns[0]?.agentResponse, "native final");
    assert.equal(turns[0]?.lastEventName, "result");
    const duplicateRows = await store.runSqlQuery({
      sql: "SELECT count(*) AS count FROM session_turn WHERE session_id = $sessionId AND id = $nativeTurnId",
      params: { sessionId: "local_webui-session", nativeTurnId }
    });
    assert.deepEqual(duplicateRows.rows, [{ count: 0 }]);
  } finally {
    await store.close();
  }
});

test("server-side local import uses the managed native turn link before prompt matching", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "local-session-managed-native-link-test-"));
  const codexHome = resolve(root, "codex-home");
  const dbPath = resolve(root, "managed-native-link.postgres");
  const nativeSessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const nativeTurnId = "native-turn-linked";
  const externalNativeTurnId = "native-turn-external";
  const managerSessionId = "local_managed-native-link";
  const managerTurnId = "manager-turn-linked";
  const transcriptPath = resolve(root, "managed-native-link.jsonl");
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-07-18T09:00:00Z", type: "session_meta", payload: { id: nativeSessionId, cwd: root } },
      { timestamp: "2026-07-18T09:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: nativeTurnId } },
      { timestamp: "2026-07-18T09:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: nativeTurnId, message: "Native transcript text does not match the manager prompt." } },
      { timestamp: "2026-07-18T09:00:03Z", type: "event_msg", payload: { type: "agent_message", turn_id: nativeTurnId, phase: "final_answer", message: "native final" } },
      { timestamp: "2026-07-18T09:00:04Z", type: "event_msg", payload: { type: "task_complete", turn_id: nativeTurnId } },
      { timestamp: "2026-07-18T09:00:05Z", type: "event_msg", payload: { type: "task_started", turn_id: externalNativeTurnId } },
      { timestamp: "2026-07-18T09:00:06Z", type: "event_msg", payload: { type: "user_message", turn_id: externalNativeTurnId, message: "A native Codex follow-up after Threadex completed." } },
      { timestamp: "2026-07-18T09:00:07Z", type: "event_msg", payload: { type: "agent_message", turn_id: externalNativeTurnId, phase: "final_answer", message: "external native final" } },
      { timestamp: "2026-07-18T09:00:08Z", type: "event_msg", payload: { type: "task_complete", turn_id: externalNativeTurnId } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    await store.upsertSession({
      id: managerSessionId,
      threadId: nativeSessionId,
      workspaceId: "default",
      cwd: root,
      title: "Managed session"
    });
    await store.recordSessionTurn({
      id: managerTurnId,
      sessionId: managerSessionId,
      userInput: "Threadex runner prompt that intentionally differs.",
      agentResponse: "streamed final",
      tokenIn: 1,
      tokenOut: 2,
      status: "running"
    });
    await store.markSessionTurnRunning({
      id: managerTurnId,
      runnerPid: 99_999_999,
      runnerLogPath: resolve(root, "manager-runner.ndjson")
    });
    await store.updateSessionTurn({
      id: managerTurnId,
      agentResponse: "streamed final",
      tokenIn: 1,
      tokenOut: 2,
      status: "done"
    });
    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    let turns = await store.listSessionTurns(managerSessionId);
    // Before the native-id link arrives, both the runner's native turn and an
    // unrelated native follow-up are imported. This is the poller race we
    // must recover from once the exact link is persisted.
    assert.equal(turns.length, 3);
    assert.equal(turns.some((turn) => turn.id === nativeTurnId), true);

    // This is the persisted runner update: it must serve both as durable
    // provenance for later imports and as the signal to clean a duplicate
    // which the poller imported before the update arrived.
    await store.recordSessionTurnEvent({
      id: "runner-native-turn-link-event",
      turnId: managerTurnId,
      sessionId: managerSessionId,
      eventName: "runner.native_turn_link",
      payload: { nativeTurnId, nativeSessionId, transcriptPath }
    });
    assert.equal(await store.linkManagedRunnerNativeTurn({
      sessionId: managerSessionId,
      managerTurnId,
      nativeSessionId,
      nativeTurnId,
      transcriptPath,
      eventAlreadyRecorded: true
    }), true);

    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });

    turns = await store.listSessionTurns(managerSessionId);
    assert.equal(turns.length, 2);
    const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
    assert.equal(turnsById.has(nativeTurnId), false);
    assert.equal(turnsById.get(managerTurnId)?.agentResponse, "streamed final");
    assert.equal(turnsById.get(externalNativeTurnId)?.agentResponse, "external native final");
  } finally {
    await store.close();
  }
});

test("Codex stop hook queues external imports and managed native-turn links", () => {
  const root = mkdtempSync(resolve(tmpdir(), "codex-stop-hook-script-test-"));
  const transcriptPath = resolve(root, "rollout-2026-07-15T09-00-00-88888888-9999-4aaa-bbbb-cccccccccccc.jsonl");
  const queuePath = resolve(root, "queue.ndjson");
  writeFileSync(transcriptPath, "\n");

  const queued = spawnSync(process.execPath, ["scripts/codex-stop-sync.mjs"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "88888888-9999-4aaa-bbbb-cccccccccccc",
      turn_id: "turn-hook-script-1",
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      cwd: root,
    }),
    env: {
      ...process.env,
      THREADEX_MANAGED_RUNNER: "0",
      THREADEX_HOOK_SERVER_URL: "http://127.0.0.1:1",
      SESSION_CODEX_HOOK_QUEUE_PATH: queuePath,
      CODEX_HOME: resolve(root, "codex-home"),
    },
  });
  assert.equal(queued.status, 0, queued.stderr);
  const queuedRecord = JSON.parse(readFileSync(queuePath, "utf8").trim());
  assert.equal(queuedRecord.transcriptPath, transcriptPath);
  assert.equal(queuedRecord.turnId, "turn-hook-script-1");

  const managedQueuePath = resolve(root, "managed.ndjson");
  const managed = spawnSync(process.execPath, ["scripts/codex-stop-sync.mjs"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "native-manager-session",
      turn_id: "native-manager-turn",
      transcript_path: transcriptPath,
      hook_event_name: "Stop",
      cwd: root,
    }),
    env: {
      ...process.env,
      THREADEX_MANAGED_RUNNER: "1",
      THREADEX_SESSION_ID: "local-manager-session",
      THREADEX_TURN_ID: "threadex-manager-turn",
      THREADEX_HOOK_SERVER_URL: "http://127.0.0.1:1",
      SESSION_CODEX_HOOK_QUEUE_PATH: managedQueuePath,
    },
  });
  assert.equal(managed.status, 0, managed.stderr);
  const managedRecord = JSON.parse(readFileSync(managedQueuePath, "utf8").trim());
  assert.equal(managedRecord.managedByThreadex, true);
  assert.equal(managedRecord.sessionId, "native-manager-session");
  assert.equal(managedRecord.turnId, "native-manager-turn");
  assert.equal(managedRecord.managerSessionId, "local-manager-session");
  assert.equal(managedRecord.managerTurnId, "threadex-manager-turn");
  assert.equal(readFileSync(queuePath, "utf8").trim().split(/\r?\n/).length, 1);
});

function syncOutput(result: ReturnType<typeof spawnSync>) {
  return ["stdout:", result.stdout, "stderr:", result.stderr].join("\n");
}
