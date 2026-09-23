import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptLoopTodos, loopStopReason, loopTodoId, loopTodoIssues, loopWorkInstructions, loopWorkIssues, shouldAutoGrillTurn, turnHasLoopActivity } from "./loopMode";
import { SessionStore } from "./sessionStore";
import type { TurnGrill } from "../turnGrill";

test("Loop checks turns with a command or a file change", () => {
  assert.equal(turnHasLoopActivity([{ itemType: "agent_message" }]), false);
  assert.equal(turnHasLoopActivity([{ itemType: "command_execution", command: "npm test" }]), true);
  assert.equal(turnHasLoopActivity([{ itemType: "file_change", changes: [{ path: "src/a.ts" }] }]), true);
  assert.equal(turnHasLoopActivity([{ itemType: "file_change", changes: [] }]), false);
  assert.equal(shouldAutoGrillTurn([], false), false);
  assert.equal(shouldAutoGrillTurn([], true), true);
});

test("Loop starts work only for selected unresolved Grill issues", () => {
  const review: TurnGrill = {
    revision: 2, status: "ready", updated: "2026-01-01", error: null, rounds: [],
    issues: [
      { id: "open", md: "Fix this", responseMd: "", status: "open", selected: true },
      { id: "later", md: "Can be deferred", responseMd: "", status: "open", selected: true, impact: "non_blocking" },
      { id: "resolved", md: "Done", responseMd: "", status: "resolved", selected: true },
      { id: "dropped", md: "Ignore", responseMd: "", status: "open", selected: false, dropped: true }
    ]
  };
  assert.deepEqual(loopWorkIssues(review).map((issue) => issue.id), ["open"]);
  assert.deepEqual(loopTodoIssues(review).map((issue) => issue.id), ["later"]);
  assert.deepEqual(loopWorkIssues({ ...review, status: "running" }), []);
});

test("agent can stop only after two completed Start work cycles with an explicit final line", () => {
  const final = "Tried the migration twice.\nLoop stopped: database schema remains incompatible";
  assert.equal(loopStopReason(final, 1), null);
  assert.equal(loopStopReason(final, 2), "database schema remains incompatible");
  assert.equal(loopStopReason(`${final}\nContinuing work.`, 2), null);
  assert.equal(loopStopReason("Loop stopped: \n", 2), null);
  assert.doesNotMatch(loopWorkInstructions(1), /you may terminate this Loop/);
  assert.match(loopWorkInstructions(2), /you may terminate this Loop/);
});

test("Auto Grill accepts non-blocking issues as persistent Todo without resetting later progress", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-todo-"));
  const store = new SessionStore(join(root, "test.postgres"));
  try {
    await store.ready();
    await store.upsertWorkspace({ id: "loop-workspace", name: "Loop", cwd: root, codexHome: join(root, "home") });
    await store.upsertSession({ id: "loop-session", workspaceId: "loop-workspace", cwd: root, title: "Loop" });
    await store.recordSessionTurn({ id: "one-turn", sessionId: "loop-session", userInput: "Check", agentResponse: "Done", tokenIn: 0, tokenOut: 0, status: "done" });
    const review: TurnGrill = { revision: 1, status: "ready", updated: "2026-01-01", error: null, rounds: [], automatic: true,
      issues: [
        { id: "later", md: "Document the fallback", responseMd: "", status: "open", selected: true, impact: "non_blocking" },
        { id: "blocker", md: "Repair data loss", responseMd: "", status: "open", selected: true, impact: "blocking" }
      ] };
    assert.equal(await store.saveTurnGrill("loop-session", "one-turn", 0, review), true);
    const first = await acceptLoopTodos(store, "loop-session", "one-turn", review);
    const id = loopTodoId("loop-session", "one-turn", "later");
    assert.equal(first.todoChanged, true);
    assert.equal(first.review.issues[0].todoId, id);
    assert.equal(first.review.issues[1].todoId, undefined);
    assert.deepEqual((await store.getSessionTodo("loop-session")).items.map((item) => item.id), [id]);
    await store.updateTodoItem({ sessionId: "loop-session", id, status: "done", actor: "user" });
    const second = await acceptLoopTodos(store, "loop-session", "one-turn", review);
    assert.equal(second.todoChanged, false);
    assert.equal((await store.getSessionTodo("loop-session")).items[0].status, "done");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("global and per-turn Loop settings survive a store restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-mode-"));
  const id = join(root, "test.postgres");
  let store = new SessionStore(id);
  try {
    await store.ready();
    assert.equal(await store.getGlobalLoopMode(), false);
    await store.upsertWorkspace({ id: "loop-workspace", name: "Loop", cwd: root, codexHome: join(root, "home") });
    await store.upsertSession({ id: "loop-session", workspaceId: "loop-workspace", cwd: root, title: "Loop" });
    await store.recordSessionTurn({ id: "one-turn", sessionId: "loop-session", userInput: "Check", agentResponse: "Done", tokenIn: 0, tokenOut: 0, status: "done" });
    await store.setGlobalLoopMode(true);
    await store.enableTurnLoopMode("one-turn");
    await store.recordLoopWorkTurn("work-one", "one-turn", 1);
    await store.recordLoopWorkTurn("work-two", "one-turn", 2);
    assert.equal((await store.listSessionTurns("loop-session"))[0].loopMode, true);
    await store.close();
    store = new SessionStore(id);
    await store.ready();
    assert.equal(await store.getGlobalLoopMode(), true);
    assert.equal(await store.isTurnLoopModeEnabled("one-turn"), true);
    assert.equal((await store.getSessionTurn("one-turn"))?.loopMode, true);
    assert.equal(await store.isTurnLoopModeEnabled("other-turn"), false);
    assert.deepEqual(await store.getLoopWorkTurn("work-one"), { rootTurnId: "one-turn", workCycle: 1 });
    assert.deepEqual(await store.getLoopWorkTurn("work-two"), { rootTurnId: "one-turn", workCycle: 2 });
    await store.setGlobalLoopMode(false);
    assert.equal(await store.getGlobalLoopMode(), false);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
