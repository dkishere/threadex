import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SessionStore } from "./sessionStore.js";

async function withParentSession(run: (store: SessionStore) => Promise<void>) {
  const root = mkdtempSync(resolve(tmpdir(), "session-fork-at-turn-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "parent", threadId: "codex-parent-thread", cwd: root, title: "Parent" });
    await store.recordSessionTurn({ id: "turn-1", sessionId: "parent", userInput: "first",
      agentResponse: "first answer", tokenIn: 0, tokenOut: 0, status: "done" });
    await store.recordSessionTurnEvent({ id: "link-1", turnId: "turn-1", sessionId: "parent",
      eventName: "runner.native_turn_link", payload: { threadId: "codex-parent-thread", nativeTurnId: "native-turn-1" } });
    await run(store);
  } finally {
    await store.close();
  }
}

test("a completed turn forks while a later parent turn is still running", async () => {
  await withParentSession(async (store) => {
    await store.recordSessionTurn({ id: "turn-2", sessionId: "parent", userInput: "second",
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });

    const fork = await store.forkSessionAtTurn({ id: "fork", parentSessionId: "parent", targetTurnId: "turn-1" });

    assert.equal(fork.session.threadId, null, "the fork must not resume the parent's running native thread");
    assert.equal(fork.session.forkedFromTurnId, "turn-1");
    assert.deepEqual(fork.turns.map(turn => [turn.userInput, turn.status]), [["first", "done"]]);
    assert.equal((await store.getSessionTurn("turn-2"))?.status, "running", "the parent's running turn is untouched");
    assert.equal((await store.getSession("parent"))?.threadId, "codex-parent-thread");
    assert.deepEqual(await store.sessionForkNativeSource("fork", "fork-first-turn"),
      { threadId: "codex-parent-thread", lastTurnId: "native-turn-1" });
  });
});

test("a running turn cannot be forked", async () => {
  await withParentSession(async (store) => {
    await store.recordSessionTurn({ id: "turn-2", sessionId: "parent", userInput: "second",
      agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    await assert.rejects(store.forkSessionAtTurn({ id: "fork", parentSessionId: "parent", targetTurnId: "turn-2" }),
      /Only completed agent messages can be forked/);
    assert.equal(await store.getSession("fork"), null);
  });
});

test("an idle session still forks, and the native fork source ends once the fork has run", async () => {
  await withParentSession(async (store) => {
    await store.recordSessionTurn({ id: "turn-2", sessionId: "parent", userInput: "second",
      agentResponse: "second answer", tokenIn: 0, tokenOut: 0, status: "done" });

    const fork = await store.forkSessionAtTurn({ id: "fork", parentSessionId: "parent", targetTurnId: "turn-1" });
    assert.deepEqual(fork.turns.map(turn => turn.userInput), ["first"]);
    assert.ok(await store.sessionForkNativeSource("fork", "fork-first-turn"));

    // The first fork turn records its own native thread from the runner's session event.
    await store.upsertSession({ id: "fork", threadId: "codex-fork-thread", cwd: fork.session.cwd, title: fork.session.title });
    assert.equal(await store.sessionForkNativeSource("fork", "fork-second-turn"), null);
    assert.equal(await store.sessionForkNativeSource("parent", "turn-3"), null, "ordinary sessions have no fork source");
  });
});
