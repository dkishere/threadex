import assert from "node:assert/strict";
import test from "node:test";

import { clearLimitWaits, type LimitWaitDeps } from "./limitWait";

type Turn = {
  turnId: string;
  sessionId: string;
  workspaceId: string;
  provider: "codex" | "claude";
  rateLimited: boolean;
  accounts: string[];
};

function harness(turns: Turn[]) {
  const calls = { timers: [] as string[], cancelled: [] as string[], released: [] as string[], resumed: [] as string[] };
  const deps: LimitWaitDeps<Turn> = {
    listPending: async () => turns,
    accountIds: async (turn) => turn.accounts,
    clearTimer: (turnId) => calls.timers.push(turnId),
    listWaitingSubscriptions: async (sessionId) => turns
      .filter((turn) => turn.sessionId === sessionId)
      .flatMap((turn) => [
        { eventId: `quota:${turn.turnId}`, turnId: turn.turnId, actionType: "retry_turn" },
        { eventId: `quota:${turn.turnId}`, turnId: turn.turnId, actionType: "retry_turn" },
        { eventId: `note:${turn.turnId}`, turnId: turn.turnId, actionType: "notify" }
      ]),
    cancelTurnSubscriptions: async (turnId) => calls.cancelled.push(turnId),
    releaseQuotaEvent: async (eventId) => calls.released.push(eventId),
    resume: (turnId) => calls.resumed.push(turnId)
  };
  return { deps, calls };
}

const codexA: Turn = { turnId: "t-codex-a", sessionId: "s1", workspaceId: "w1", provider: "codex", rateLimited: true, accounts: ["acct-a"] };
const codexB: Turn = { turnId: "t-codex-b", sessionId: "s2", workspaceId: "w1", provider: "codex", rateLimited: true, accounts: ["acct-b"] };
const claudeA: Turn = { turnId: "t-claude-a", sessionId: "s3", workspaceId: "w1", provider: "claude", rateLimited: true, accounts: ["claude-a"] };
const stopped: Turn = { turnId: "t-stopped", sessionId: "s4", workspaceId: "w1", provider: "codex", rateLimited: false, accounts: ["acct-a"] };

test("a manual Codex reset releases only that account's waits and resumes them", async () => {
  const { deps, calls } = harness([codexA, codexB, claudeA, stopped]);
  const result = await clearLimitWaits({ provider: "codex", accountId: "acct-a" }, deps);
  assert.deepEqual(result.turnIds, ["t-codex-a"]);
  assert.deepEqual(calls.timers, ["t-codex-a"]);
  assert.deepEqual(calls.cancelled, ["t-codex-a"]);
  // Each quota event is released once; non-retry waiters are not treated as turn waits.
  assert.deepEqual(calls.released, ["quota:t-codex-a"]);
  assert.deepEqual(calls.resumed, ["t-codex-a"]);
});

test("a Claude account switch releases Claude waits in the workspace only", async () => {
  const { deps, calls } = harness([codexA, claudeA]);
  const result = await clearLimitWaits({ provider: "claude", workspaceId: "w1" }, deps);
  assert.deepEqual(result.turnIds, ["t-claude-a"]);
  assert.deepEqual(calls.resumed, ["t-claude-a"]);
});

test("stopped, cancelled or finished turns are never revived", async () => {
  const { deps, calls } = harness([stopped]);
  const result = await clearLimitWaits({ accountId: "acct-a" }, deps);
  assert.deepEqual(result.turnIds, []);
  assert.deepEqual(calls, { timers: [], cancelled: [], released: [], resumed: [] });
});

test("an empty scope clears nothing", async () => {
  const { deps, calls } = harness([codexA, claudeA]);
  assert.deepEqual((await clearLimitWaits({}, deps)).turnIds, []);
  assert.deepEqual(calls.resumed, []);
});

test("all waits are cleared before any turn resumes", async () => {
  const order: string[] = [];
  const { deps } = harness([codexA, { ...codexB, accounts: ["acct-a"] }]);
  const result = await clearLimitWaits({ accountId: "acct-a" }, {
    ...deps,
    cancelTurnSubscriptions: async (turnId) => order.push(`cancel:${turnId}`),
    resume: (turnId) => order.push(`resume:${turnId}`)
  });
  assert.deepEqual(result.turnIds, ["t-codex-a", "t-codex-b"]);
  assert.deepEqual(order, ["cancel:t-codex-a", "cancel:t-codex-b", "resume:t-codex-a", "resume:t-codex-b"]);
});
