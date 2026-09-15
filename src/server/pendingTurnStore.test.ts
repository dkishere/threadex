import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { SessionStore } from "./sessionStore";

test("automatic Todo selection skips a stopped turn but keeps it stored", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "pending-turn-store-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  try {
    await store.upsertSession({ id: "session-1" });
    await store.recordSessionTurn({
      id: "turn-a-stopped",
      sessionId: "session-1",
      userInput: "stopped work",
      agentResponse: "Agent stopped. Turn saved as todo and can be retried.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "stopped"
    });
    await store.recordSessionTurn({
      id: "turn-b-rate-limit",
      sessionId: "session-1",
      userInput: "later work",
      agentResponse: "Usage limit reached.",
      tokenIn: 0,
      tokenOut: 0,
      status: "todo",
      pendingReason: "rate_limit",
      pendingLoadBalance: true
    });

    assert.equal((await store.getNextTodoTurn("session-1"))?.id, "turn-b-rate-limit");
    assert.deepEqual(
      (await store.listPendingSessionTurns())
        .filter((candidate) => candidate.session.id === "session-1")
        .map((candidate) => candidate.turn.id),
      ["turn-a-stopped", "turn-b-rate-limit"]
    );
  } finally {
    await store.close();
  }
});
