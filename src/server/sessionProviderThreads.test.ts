import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionStore, type SessionTurnRecord } from "./sessionStore";
import { openPostgresSessionConnection, postgresSchemaFromStoreId } from "./sessionDb";
import { buildProviderHandoff, withProviderHandoff, type ProviderThreadScope } from "./sessionProviderThreads";

const codex: ProviderThreadScope = { provider: "codex", nativeHome: "/codex", cwd: "/repo", accountId: "codex-account" };
const claude: ProviderThreadScope = { provider: "claude", nativeHome: "/claude", cwd: "/repo", accountId: "claude-account" };

async function start(store: SessionStore, id: string, scope: ProviderThreadScope) {
  await store.recordSessionTurn({ id, sessionId: "session", userInput: `Request ${id}`, agentResponse: "",
    status: "running", tokenIn: 0, tokenOut: 0,
    requestMetadata: { model: scope.provider === "claude" ? "claude-opus-5-5" : "gpt-6-sol" } });
}

async function finish(store: SessionStore, id: string, scope: ProviderThreadScope, threadId: string) {
  await store.recordSessionProviderThread({ ...scope, sessionId: "session", turnId: id, threadId, completed: false });
  await store.upsertSession({ id: "session", threadId });
  await store.recordSessionProviderThread({ ...scope, sessionId: "session", turnId: id, threadId, completed: true });
  await store.updateSessionTurn({ id, agentResponse: `Result ${id}`, status: "done", tokenIn: 0, tokenOut: 0, runnerExitCode: 0 });
}

test("Codex → Claude → Codex → Claude retains both threads and hands off only intervening turns across restart", async () => {
  const db = resolve(mkdtempSync(resolve(tmpdir(), "threadex-provider-threads-")), "db");
  let store = new SessionStore(db);
  await store.ready();
  try {
    await store.upsertSession({ id: "session", cwd: "/repo" });
    await start(store, "t1", codex);
    await finish(store, "t1", codex, "codex-a");
    assert.equal(await store.getSessionProviderThread({ ...claude, sessionId: "session", legacyThreadId: "codex-a" }), null);
    await start(store, "t2", claude);
    await finish(store, "t2", claude, "claude:b");
    await start(store, "t3", claude);
    const same = await store.getSessionProviderThread({ ...claude, sessionId: "session" });
    assert.equal(buildProviderHandoff({ thread: same!, turns: await store.listSessionTurns("session"), currentTurnId: "t3" }), undefined);
    await finish(store, "t3", claude, "claude:b");
    await store.close();
    store = new SessionStore(db);
    await store.ready();
    await start(store, "t4", codex);
    const a = await store.getSessionProviderThread({ ...codex, sessionId: "session", legacyThreadId: "claude:b" });
    assert.equal(a?.threadId, "codex-a");
    assert.equal(a?.syncedThroughTurnId, "t1");
    const handoff = buildProviderHandoff({ thread: a!, turns: await store.listSessionTurns("session"), currentTurnId: "t4" });
    assert.match(handoff!, /turnId=t2; agent=Claude Code/);
    assert.match(handoff!, /turnId=t3; agent=Claude Code/);
    assert.match(handoff!, /nativeThreadId=claude:b/);
    assert.doesNotMatch(handoff!, /Request t1|Request t4/);
    assert.match(withProviderHandoff("continue", handoff), /Current user request:\ncontinue$/);
    assert.equal((await store.getSessionByThreadId("codex-a"))?.id, "session");
    assert.equal((await store.resolveSession({ threadId: "codex-a" }))?.id, "session");
    await finish(store, "t4", codex, "codex-a");
    assert.equal((await store.getSessionTurn("t4"))?.nativeThreadId, "codex-a");
    assert.equal((await store.getSessionTurn("t4"))?.provider, "codex");
    await start(store, "t5", claude);
    const b = await store.getSessionProviderThread({ ...claude, sessionId: "session", legacyThreadId: "codex-a" });
    assert.equal(b?.threadId, "claude:b");
    assert.equal((await store.getSessionProviderThread({ ...claude, sessionId: "session", allowLegacy: false }))?.threadId, "claude:b");
    const back = buildProviderHandoff({ thread: b!, turns: await store.listSessionTurns("session"), currentTurnId: "t5" });
    assert.match(back!, /turnId=t4; agent=Codex/);
    assert.doesNotMatch(back!, /Request t[1235]/);
    await finish(store, "t5", claude, "claude:b");
    // A replay cannot roll the saved pointer or checkpoint back to a finished turn.
    await store.recordSessionProviderThread({ ...codex, sessionId: "session", turnId: "t1", threadId: "stale", completed: true });
    assert.equal((await store.getSessionProviderThread({ ...codex, sessionId: "session" }))?.threadId, "codex-a");
    assert.equal((await store.getSessionTurn("t1"))?.nativeThreadId, "codex-a");
    assert.equal(await store.getSessionProviderThread({ ...claude, sessionId: "session", nativeHome: "/other-account", legacyThreadId: "claude:b" }), null);
    assert.equal(await store.getSessionProviderThread({ ...codex, sessionId: "session", cwd: "/other-project", legacyThreadId: "codex-a" }), null);
  } finally { await store.close(); }
});

test("starting and failing a resumed turn preserves its checkpoint; a replacement native thread resets it", async () => {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "threadex-provider-retry-")), "db"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session" });
    await start(store, "t1", codex);
    await finish(store, "t1", codex, "codex-a");
    await start(store, "t2", claude);
    await finish(store, "t2", claude, "claude:b");
    await start(store, "t3", codex);
    await store.recordSessionProviderThread({ ...codex, sessionId: "session", turnId: "t3", threadId: "codex-a", completed: false });
    await store.updateSessionTurn({ id: "t3", agentResponse: "failed", status: "todo", tokenIn: 0, tokenOut: 0, runnerExitCode: 1 });
    const saved = await store.getSessionProviderThread({ ...codex, sessionId: "session" });
    assert.equal(saved?.syncedThroughTurnId, "t1");
    assert.match(buildProviderHandoff({ thread: saved!, turns: await store.listSessionTurns("session"), currentTurnId: "t3" })!, /Result t2/);
    await start(store, "t4", codex);
    await store.recordSessionProviderThread({ ...codex, sessionId: "session", turnId: "t4", threadId: "codex-new", completed: false });
    assert.equal((await store.getSessionProviderThread({ ...codex, sessionId: "session" }))?.syncedThroughTurnId, null);
    await finish(store, "t4", codex, "codex-new");
    assert.equal((await store.getSessionProviderThread({ ...codex, sessionId: "session" }))?.syncedThroughTurnId, "t4");
  } finally { await store.close(); }
});

test("legacy saved events recover the older provider thread without changing the active provider", async () => {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "threadex-provider-legacy-")), "db"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session", threadId: "claude:b" });
    assert.equal(await store.getSessionProviderThread({ ...claude, sessionId: "session", legacyThreadId: "claude:b", allowLegacy: false }), null);
    await store.recordSessionTurn({ id: "old-turn", sessionId: "session", userInput: "before switch", agentResponse: "done", status: "done", tokenIn: 0, tokenOut: 0 });
    await store.recordSessionTurnEvent({ id: "old-result", sessionId: "session", turnId: "old-turn", eventName: "result", payload: { threadId: "codex-a" } });
    const restored = await store.getSessionProviderThread({ ...codex, sessionId: "session", legacyThreadId: "claude:b" });
    assert.equal(restored?.threadId, "codex-a");
    assert.equal(restored?.syncedThroughTurnId, "old-turn");
    assert.equal((await store.getSessionTurn("old-turn"))?.nativeThreadId, "codex-a");
    assert.equal((await store.getSession("session"))?.threadId, "claude:b");
  } finally { await store.close(); }
});

test("a workspace Claude home never adopts a legacy thread from the shared account home", async () => {
  const store = new SessionStore(resolve(mkdtempSync(resolve(tmpdir(), "threadex-claude-home-migration-")), "db"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session", threadId: "claude:legacy" });
    const workspace = { ...claude, nativeHome: "/workspace-claude-home" };
    assert.equal(await store.getSessionProviderThread({ ...workspace, sessionId: "session", legacyThreadId: "claude:legacy", allowLegacy: false }), null);
    await start(store, "fresh", workspace);
    await finish(store, "fresh", workspace, "claude:workspace");
    assert.equal((await store.getSessionProviderThread({ ...workspace, sessionId: "session", allowLegacy: false }))?.threadId, "claude:workspace");
    assert.equal(await store.getSessionProviderThread({ ...workspace, nativeHome: "/other-workspace-home", sessionId: "session", allowLegacy: false }), null);
  } finally { await store.close(); }
});

test("upgrade from the old schema backfills both providers, preserves history and is idempotent", async () => {
  const db = resolve(mkdtempSync(resolve(tmpdir(), "threadex-provider-upgrade-")), "db");
  let store = new SessionStore(db);
  await store.ready();
  try {
    await store.upsertSession({ id: "session", threadId: "claude:old", cwd: "/repo" });
    for (const id of ["old-codex", "old-claude", "no-evidence", "malformed"]) {
      await store.recordSessionTurn({ id, sessionId: "session", userInput: `Saved request ${id}`,
        agentResponse: `Saved result ${id}`, status: "done", tokenIn: 3, tokenOut: 4 });
    }
    await store.recordSessionTurnEvent({ id: "before-replacement", sessionId: "session", turnId: "old-codex",
      eventName: "session", payload: { threadId: "codex-before-replacement" } });
    await store.recordSessionTurnEvent({ id: "codex-result", sessionId: "session", turnId: "old-codex",
      eventName: "result", payload: { threadId: "codex-migrated" } });
    await store.recordSessionTurnEvent({ id: "claude-result", sessionId: "session", turnId: "old-claude",
      eventName: "result", payload: { threadId: "claude:old" } });
    await store.recordSessionTurnEvent({ id: "malformed-result", sessionId: "session", turnId: "malformed",
      eventName: "result", payload: { threadId: 123 } });
    await store.close();
    // Remove only this feature's schema in the isolated test database, retaining
    // the old session/turn/event data as it existed before the upgrade.
    const connection = await openPostgresSessionConnection(undefined, postgresSchemaFromStoreId(db));
    try {
      await connection.run("DROP TABLE session_provider_thread");
      await connection.run("ALTER TABLE session_turn DROP COLUMN native_thread_id, DROP COLUMN provider, DROP COLUMN native_updated_at");
      await connection.run("UPDATE session_turn_event SET created = '2026-01-01T00:00:00Z' WHERE id = 'before-replacement'");
    } finally { await connection.close(); }

    store = new SessionStore(db);
    await store.ready();
    const turns = await store.listSessionTurns("session");
    assert.equal(turns.length, 4);
    assert.equal(turns.find(turn => turn.id === "old-codex")?.nativeThreadId, "codex-migrated");
    assert.equal(turns.find(turn => turn.id === "old-codex")?.provider, "codex");
    assert.equal(turns.find(turn => turn.id === "old-claude")?.nativeThreadId, "claude:old");
    assert.equal(turns.find(turn => turn.id === "old-claude")?.provider, "claude");
    assert.equal(turns.find(turn => turn.id === "no-evidence")?.nativeThreadId, null);
    assert.equal(turns.find(turn => turn.id === "malformed")?.nativeThreadId, null);
    for (const turn of turns) {
      assert.equal(turn.userInput, `Saved request ${turn.id}`);
      assert.equal(turn.agentResponse, `Saved result ${turn.id}`);
      assert.equal(turn.tokenIn, 3);
      assert.equal(turn.tokenOut, 4);
    }
    const saved = await store.getSessionProviderThread({ ...codex, sessionId: "session", legacyThreadId: "claude:old" });
    assert.equal(saved?.threadId, "codex-migrated");
    assert.equal(await store.getSessionProviderThread({ ...claude, sessionId: "session", legacyThreadId: "claude:old", allowLegacy: false }), null,
      "historical Claude turn metadata must not bind an old native session into a different storage home");
    await store.recordSessionTurnEvent({ id: "late-replay", sessionId: "session", turnId: "old-codex",
      eventName: "result", payload: { threadId: "must-not-replace-existing-metadata" } });
    await store.close();
    store = new SessionStore(db);
    await store.ready();
    assert.equal((await store.getSessionTurn("old-codex"))?.nativeThreadId, "codex-migrated");
    assert.equal((await store.getSessionTurn("old-claude"))?.nativeThreadId, "claude:old");
    assert.equal((await store.getSessionProviderThread({ ...codex, sessionId: "session" }))?.threadId, "codex-migrated");
    assert.equal((await store.getSession("session"))?.threadId, "claude:old");
  } finally { await store.close(); }
});

test("handoff uses execution order for queued turns and preserves incomplete-attempt status", () => {
  const make = (id: string, extra: Partial<SessionTurnRecord>) => ({ id, sessionId: "session", userInput: id, agentResponse: `result ${id}`,
    status: "done", runnerExitCode: 0, created: "2026-10-01T00:00:00Z", ...extra } as SessionTurnRecord);
  const turns = [
    make("queued-claude", { provider: "claude", runnerStarted: "2026-10-01T03:00:00Z" }),
    make("codex-before", { provider: "codex", runnerStarted: "2026-10-01T02:00:00Z" }),
    make("failed", { provider: "claude", runnerStarted: "2026-10-01T04:00:00Z", status: "todo", runnerExitCode: 1 }),
    make("not-run", { status: "todo", runnerExitCode: null }),
    make("current", { status: "running" })
  ];
  const handoff = buildProviderHandoff({ thread: { ...codex, sessionId: "session", threadId: "codex-a", syncedThroughTurnId: "codex-before" }, turns, currentTurnId: "current" });
  assert.match(handoff!, /queued-claude/);
  assert.match(handoff!, /Interrupted attempt/);
  assert.doesNotMatch(handoff!, /result failed|not-run|result codex-before/);
});

test("a retried older turn is handed off when it changed after the provider checkpoint, including user steers", () => {
  const turns = [
    { id: "older", userInput: "original", agentResponse: "now completed", status: "done", runnerExitCode: 0,
      runnerStarted: "2026-10-01T01:00:00Z", nativeUpdatedAt: "2026-10-01T04:00:00Z", provider: "claude" },
    { id: "checkpoint", status: "done", runnerExitCode: 0, runnerStarted: "2026-10-01T02:00:00Z" }
  ] as SessionTurnRecord[];
  const handoff = buildProviderHandoff({ thread: { ...codex, sessionId: "session", threadId: "codex-a",
    syncedThroughTurnId: "checkpoint", syncedAt: "2026-10-01T03:00:00Z" }, turns, currentTurnId: "current",
    steerMessagesByTurn: { older: [{ content: "Correction: preserve the public API" }] } });
  assert.match(handoff!, /now completed/);
  assert.match(handoff!, /Correction: preserve the public API/);
  assert.doesNotMatch(handoff!, /turnId=checkpoint/);
});
