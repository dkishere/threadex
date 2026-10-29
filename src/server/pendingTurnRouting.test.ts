import assert from "node:assert/strict";
import test from "node:test";

import {
  codexQuotaRetryAt,
  isClaudePendingTurn,
  pendingInLimitWaitScope,
  pendingLoadBalanceForUpdate,
  pendingRetryAt,
  pendingTurnRunsAutomatically,
  pendingUsesWorkspaceAccountPool,
  rateLimitFallbackDelayMs
} from "./pendingTurnRouting";

test("keeps a rate-limited load-balanced turn routable when workspace LB is enabled", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: true,
    workspaceLoadBalanceEnabled: true
  }), true);
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-a",
    turnAccountId: "account-a",
    pendingLoadBalance: true,
    workspaceLoadBalanceEnabled: true
  }), true);
});

test("keeps an explicitly selected account after a usage limit", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: false,
    workspaceLoadBalanceEnabled: false
  }), false);
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: false,
    workspaceLoadBalanceEnabled: true
  }), false);
});

test("disabling workspace LB overrides a pending turn's saved LB setting", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), false);
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-a",
    turnAccountId: "account-a",
    pendingLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), false);
});

test("a manual account rebind does not enable automatic account selection", () => {
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-manually-selected",
    turnAccountId: "account-original",
    pendingLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), false);
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-manually-selected",
    turnAccountId: "account-original",
    pendingLoadBalance: false,
    workspaceLoadBalanceEnabled: true
  }), false);
});

test("legacy turns follow the workspace LB setting when no turn setting was saved", () => {
  for (const enabled of [false, true]) {
    assert.equal(pendingLoadBalanceForUpdate({
      pendingReason: "rate_limit",
      persistedLoadBalance: null,
      workspaceLoadBalanceEnabled: enabled
    }), enabled);
    assert.equal(pendingUsesWorkspaceAccountPool({
      sessionAccountId: "account-a",
      turnAccountId: "account-a",
      pendingLoadBalance: null,
      workspaceLoadBalanceEnabled: enabled
    }), enabled);
  }
});

test("does not turn ordinary pending work into load-balanced retries", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "queued",
    persistedLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), false);
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-a",
    turnAccountId: "account-a",
    pendingLoadBalance: false,
    workspaceLoadBalanceEnabled: false
  }), false);
});

test("keeps a stopped Todo for manual retry without blocking later automatic work", () => {
  assert.equal(pendingTurnRunsAutomatically("stopped"), false);
  assert.equal(pendingTurnRunsAutomatically("auth"), false);
  assert.equal(pendingTurnRunsAutomatically("queued"), true);
  assert.equal(pendingTurnRunsAutomatically("rate_limit"), true);
});

test("retries immediately when another workspace account is available", () => {
  assert.equal(pendingRetryAt({
    alternateAccountAvailable: true,
    resetTimes: [999_999],
    nowMs: 123
  }), 123);
  assert.equal(pendingRetryAt({
    alternateAccountAvailable: false,
    resetTimes: [900, 400],
    nowMs: 123
  }), 400);
});

test("ignores stale reset timestamps instead of immediately retrying forever", () => {
  assert.equal(pendingRetryAt({
    alternateAccountAvailable: false,
    resetTimes: [100, 122],
    nowMs: 123
  }), null);
});

const nowMs = 1_790_000_000_000;

test("does not hold a Codex turn until the reset of a window that is not exhausted", () => {
  // Observed snapshot: weekly window 1% used, resetting days later.
  assert.equal(codexQuotaRetryAt({
    primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: nowMs / 1000 + 7 * 86_400 },
    secondary: null,
    rateLimitReachedType: null
  }, nowMs), null);
});

test("waits for the exhausted Codex window, in seconds or milliseconds", () => {
  const fiveHour = nowMs + 3_600_000;
  const weekly = nowMs + 5 * 86_400_000;
  assert.equal(codexQuotaRetryAt({
    primary: { usedPercent: 100, resetsAt: fiveHour / 1000 },
    secondary: { usedPercent: 40, resetsAt: weekly / 1000 }
  }, nowMs), fiveHour);
  assert.equal(codexQuotaRetryAt({
    primary: { used_percent: 100, resets_at: fiveHour },
    secondary: { usedPercent: 100, resetsAt: weekly }
  }, nowMs), weekly);
});

test("uses the earliest reset when Codex reports a limit without an exhausted window", () => {
  const fiveHour = nowMs + 3_600_000;
  assert.equal(codexQuotaRetryAt({
    primary: { usedPercent: 97, resetsAt: fiveHour },
    secondary: { usedPercent: 50, resetsAt: nowMs + 86_400_000 },
    rateLimitReachedType: "primary"
  }, nowMs), fiveHour);
});

test("treats missing, past or malformed Codex reset data as unknown", () => {
  assert.equal(codexQuotaRetryAt(null, nowMs), null);
  assert.equal(codexQuotaRetryAt({ primary: { usedPercent: 100, resetsAt: nowMs - 1 } }, nowMs), null);
  assert.equal(codexQuotaRetryAt({ primary: { usedPercent: 100, resetsAt: "soon" } }, nowMs), null);
  assert.equal(codexQuotaRetryAt({ primary: "bad", rateLimitReachedType: "primary" }, nowMs), null);
});

test("backs off unknown-reset retries up to a cap", () => {
  assert.equal(rateLimitFallbackDelayMs(0, 30_000), 30_000);
  assert.equal(rateLimitFallbackDelayMs(1, 30_000), 60_000);
  assert.equal(rateLimitFallbackDelayMs(3, 30_000), 240_000);
  assert.equal(rateLimitFallbackDelayMs(50, 30_000), 30 * 60_000);
  assert.equal(rateLimitFallbackDelayMs(-1, 30_000), 30_000);
});

test("identifies Claude pending turns by provider before model", () => {
  const isClaudeModel = (model: string | null | undefined) => Boolean(model?.startsWith("claude-"));
  // Pending rows carry no usage-derived model; the provider must decide.
  assert.equal(isClaudePendingTurn({ provider: "claude", model: null }, isClaudeModel), true);
  assert.equal(isClaudePendingTurn({ provider: "codex", model: "claude-fable-5-1" }, isClaudeModel), false);
  assert.equal(isClaudePendingTurn({ provider: null, model: null, requestMetadata: { model: "claude-fable-5-1" } }, isClaudeModel), true);
  assert.equal(isClaudePendingTurn({ provider: null, model: "gpt-6-astra" }, isClaudeModel), false);
});

test("scopes a cleared limit wait to the reset or switched account", () => {
  const codexTurn = { provider: "codex" as const, workspaceId: "w1", sessionId: "s1", accountIds: ["acct-a"] };
  const claudeTurn = { provider: "claude" as const, workspaceId: "w1", sessionId: "s2", accountIds: ["claude-a"] };
  assert.equal(pendingInLimitWaitScope(codexTurn, { provider: "codex", accountId: "acct-a" }), true);
  // Another account's wait is untouched.
  assert.equal(pendingInLimitWaitScope(codexTurn, { provider: "codex", accountId: "acct-b" }), false);
  assert.equal(pendingInLimitWaitScope(claudeTurn, { provider: "codex", accountId: "claude-a" }), false);
  assert.equal(pendingInLimitWaitScope(claudeTurn, { provider: "claude", workspaceId: "w1" }), true);
  assert.equal(pendingInLimitWaitScope(codexTurn, { workspaceId: "w2" }), false);
  assert.equal(pendingInLimitWaitScope(codexTurn, { sessionId: "s1" }), true);
  // A scope without filters must not release every waiting turn.
  assert.equal(pendingInLimitWaitScope(codexTurn, {}), false);
});
