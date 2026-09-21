import assert from "node:assert/strict";
import test from "node:test";
import { deliverProcessWake, steerProcessWake } from "./processWakeDelivery.js";

test("a running target receives the wake prompt as a steer on its current turn", async () => {
  const delivered: unknown[] = [];
  assert.equal(await steerProcessWake("target", "process finished", {
    runningTurnId: async (sessionId) => {
      assert.equal(sessionId, "target");
      return "active-turn";
    },
    steer: async (input) => {
      delivered.push(input);
      return Response.json({ ok: true });
    }
  }), true);
  assert.deepEqual(delivered, [{ sessionId: "target", turnId: "active-turn", message: "process finished" }]);
});

test("an idle target uses the existing queued-turn path without steering", async () => {
  assert.equal(await steerProcessWake("target", "finished", {
    runningTurnId: async () => null,
    steer: async () => { throw new Error("unexpected steer"); }
  }), false);
});

test("an idle target starts a normal turn with the wake approval policy", async () => {
  const started: unknown[] = [];
  assert.equal(await deliverProcessWake({
    sessionId: "target",
    turnId: "wait_subscription-1",
    message: "finished",
    workspaceId: "default",
    approvalPolicy: "granular",
    loadBalanceInWorkspace: false
  }, {
    runningTurnId: async () => null,
    steer: async () => { throw new Error("unexpected steer"); },
    start: async (input) => {
      started.push(input);
      return Response.json({ ok: true });
    }
  }), "started");
  assert.deepEqual(started, [{
    sessionId: "target",
    turnId: "wait_subscription-1",
    message: "finished",
    workspaceId: "default",
    approvalPolicy: "granular",
    loadBalanceInWorkspace: false
  }]);
});

test("a running target keeps the current turn and does not start another", async () => {
  assert.equal(await deliverProcessWake({
    sessionId: "target",
    turnId: "wait_subscription-1",
    message: "finished",
    workspaceId: "default",
    approvalPolicy: "granular",
    loadBalanceInWorkspace: false
  }, {
    runningTurnId: async () => "active-turn",
    steer: async () => Response.json({ ok: true }),
    start: async () => { throw new Error("unexpected start"); }
  }), "steered");
});

test("a turn ending before steer submission falls back to the queued-turn path", async () => {
  for (const [status, error] of [[404, "Runner turn not found."], [409, "Agent is not running."]] as const) {
    assert.equal(await steerProcessWake("target", "finished", {
      runningTurnId: async () => "ended-turn",
      steer: async () => Response.json({ error }, { status })
    }), false);
  }
});

test("rejected or ambiguous delivery is reported instead of duplicating the wake prompt", async () => {
  for (const status of [409, 500, 504]) {
    await assert.rejects(steerProcessWake("target", "finished", {
      runningTurnId: async () => "active-turn",
      steer: async () => Response.json({ error: "delivery failed" }, { status })
    }), new RegExp(`HTTP ${status}`));
  }
});
