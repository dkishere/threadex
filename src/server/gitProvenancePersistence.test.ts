import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { streamItemFromThreadItem } from "./codexEvents";
import { inspectGitProvenance, installGitProvenanceHooks, recordLiveGitProvenance } from "./gitProvenance";
import { openPostgresSessionConnection, postgresSchemaFromStoreId } from "./sessionDb";
import { SessionStore } from "./sessionStore";

const columnQuery = `SELECT udt_name, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'session_turn' AND column_name = 'changed_files'`;
const expectedColumn = [{ udt_name: "_text", is_nullable: "NO", column_default: "'{}'::text[]" }];

async function addTurn(store: SessionStore, id: string) {
  await store.upsertSession({ id: "session" });
  await store.recordSessionTurn({ id, sessionId: "session", userInput: "test", agentResponse: "",
    tokenIn: 0, tokenOut: 0, status: "done" });
}

test("turn numbers survive reopen, deletion, aliases and backdated imports", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "turn-reference-"));
  const dbPath = resolve(root, "references.postgres");
  let store = new SessionStore(dbPath);
  try {
    await store.upsertSession({ id: "local_task", workspaceId: "default" });
    const add = async (id: string) => store.recordSessionTurn({ id, sessionId: "local_task", userInput: id,
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "done" });
    await add("first"); await add("second");
    const expected = [{ turnId: "first", turnNumber: 1 }, { turnId: "second", turnNumber: 2 }];
    assert.deepEqual(await store.getSessionTurnReferences({ sessionId: "tx_task" }), expected);
    await store.close(); store = new SessionStore(dbPath);
    assert.deepEqual(await store.getSessionTurnReferences({ sessionId: "tx_task" }), expected);
    assert.deepEqual(await store.getSessionTurnReferences({ sessionId: "tx_task", workspaceId: "wrong" }), []);
    // Direct fixture changes simulate cleanup and a late import predating old turns.
    const connection = await openPostgresSessionConnection(undefined, postgresSchemaFromStoreId(dbPath));
    try {
      await connection.run("DELETE FROM session_turn WHERE id = 'first'");
      await add("backdated");
      await connection.run("UPDATE session_turn SET created = '2000-01-01' WHERE id = 'backdated'");
    } finally { await connection.close(); }
    assert.deepEqual(await store.getSessionTurnReferences({ sessionId: "tx_task" }), [
      { turnId: "second", turnNumber: 2 }, { turnId: "backdated", turnNumber: 3 }
    ]);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fresh schema creates changed_files as non-null text[] with an empty default", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "provenance-schema-"));
  const store = new SessionStore(resolve(root, "fresh.postgres"));
  try {
    // No explicit ready(): the normal write queue must wait for open().
    await addTurn(store, "fresh-turn");
    assert.deepEqual((await store.runSqlQuery({ sql: columnQuery })).rows, expectedColumn);
    assert.deepEqual((await store.runSqlQuery({ sql: "SELECT changed_files FROM session_turn" })).rows,
      [{ changed_files: [] }]);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("existing schema gains changed_files before writes; old and new rows read [] and reopen is idempotent", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "provenance-migration-"));
  const dbPath = resolve(root, "legacy.postgres");
  let store = new SessionStore(dbPath);
  try {
    await addTurn(store, "legacy-turn");
    await store.close();
    const connection = await openPostgresSessionConnection(undefined, postgresSchemaFromStoreId(dbPath));
    try {
      // Simulate the previous schema, only in this disposable test database schema.
      await connection.run("ALTER TABLE session_turn DROP COLUMN changed_files");
      assert.deepEqual(await (await connection.run(columnQuery)).getRowObjectsJS(), []);
    } finally { await connection.close(); }
    store = new SessionStore(dbPath);
    await addTurn(store, "new-turn"); // implicitly waits for the actual startup migration
    assert.deepEqual((await store.runSqlQuery({ sql: columnQuery })).rows, expectedColumn);
    assert.deepEqual((await store.runSqlQuery({ sql: "SELECT id, changed_files FROM session_turn ORDER BY id" })).rows,
      [{ id: "legacy-turn", changed_files: [] }, { id: "new-turn", changed_files: [] }]);
    await store.recordSessionTurnEvent({ id: "after-upgrade", sessionId: "session", turnId: "legacy-turn", eventName: "item",
      payload: { id: "edit", itemType: "file_change", eventType: "item.completed", status: "completed", changes: [{ path: "legacy.txt" }] } });
    await store.close();
    store = new SessionStore(dbPath);
    assert.deepEqual((await store.runSqlQuery({ sql: columnQuery })).rows, expectedColumn);
    assert.deepEqual((await store.runSqlQuery({ sql: "SELECT changed_files FROM session_turn WHERE id = 'legacy-turn'" })).rows,
      [{ changed_files: ["legacy.txt"] }]);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("raw file-change events persist rename paths and accumulate across actual commits in one running turn", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "provenance-pipeline-"));
  const dbPath = resolve(cwd, "test.postgres");
  const store = new SessionStore(dbPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const deliver = async (id: string, changes: unknown[]) => {
    // Same native-item conversion used by promptRunner's item/completed handler.
    const data = streamItemFromThreadItem({ id, type: "fileChange", status: "completed", changes }, "item.completed");
    assert.ok(data);
    const update = { id, sessionId: "session", turnId: "running-turn", event: "item", data };
    // Runner writes locally first; the server callback persists this exact item.
    const references = await store.getSessionTurnReferences({ sessionId: "session" });
    const turnNumber = references.find(turn => turn.turnId === update.turnId)?.turnNumber;
    assert.equal(turnNumber, 1);
    recordLiveGitProvenance(cwd, update, "default", turnNumber);
    await store.recordSessionTurnEvent({ ...update, eventName: update.event, payload: data });
  };
  const assertPaths = async (paths: string[]) => {
    assert.deepEqual((await store.runSqlQuery({ sql: "SELECT changed_files, status FROM session_turn WHERE id = 'running-turn'" })).rows,
      [{ changed_files: paths, status: "running" }]);
  };
  try {
    await store.upsertSession({ id: "session", cwd });
    await store.recordSessionTurn({ id: "running-turn", sessionId: "session", userInput: "edit", agentResponse: "",
      tokenIn: 0, tokenOut: 0, status: "running" });
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", ".git/hooks");
    writeFileSync(resolve(cwd, "old.txt"), "before\n");
    git("add", "old.txt"); git("commit", "-qm", "Baseline");
    installGitProvenanceHooks(cwd, fileURLToPath(new URL("../../scripts/git-provenance.ts", import.meta.url)), import.meta.resolve("tsx"));

    renameSync(resolve(cwd, "old.txt"), resolve(cwd, "new.txt"));
    await deliver("rename-1", [{ path: "old.txt", kind: { type: "update", move_path: "new.txt" }, diff: "rename evidence" }]);
    await assertPaths(["new.txt", "old.txt"]);
    git("add", "-A", "--", "old.txt", "new.txt"); git("commit", "-qm", "Rename during turn");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records.map(r => [r.sessionId, r.turnNumber]), [["session", 1]]);
    assert.equal(inspectGitProvenance(cwd, "HEAD", "new.txt").records.length, 1);
    assert.equal(inspectGitProvenance(cwd, "HEAD", "untouched.txt").records.length, 0);
    await assertPaths(["new.txt", "old.txt"]); // consuming Git records must not clear DB history

    writeFileSync(resolve(cwd, "new.txt"), "second edit\n");
    writeFileSync(resolve(cwd, "extra.txt"), "new file\n");
    await deliver("edit-2", [{ path: "new.txt", kind: "update" }, { path: "extra.txt", kind: "add", content: "excluded" }]);
    await deliver("edit-2", [{ path: "new.txt", kind: "update" }, { path: "extra.txt", kind: "add" }]); // replay
    git("add", "new.txt", "extra.txt"); git("commit", "-qm", "Second commit in same turn");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records.map(r => [r.sessionId, r.turnNumber]), [["session", 1]]);
    await assertPaths(["extra.txt", "new.txt", "old.txt"]);
    writeFileSync(resolve(cwd, "unrelated.txt"), "no task edit\n");
    git("add", "unrelated.txt"); git("commit", "-qm", "Unrelated commit after task commit");
    assert.deepEqual(inspectGitProvenance(cwd, "HEAD").records, []);
  } finally { await store.close(); rmSync(cwd, { recursive: true, force: true }); }
});
