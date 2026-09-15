import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingLoadBalanceForUpdate,
  pendingRetryAt,
  pendingTurnRunsAutomatically,
  pendingUsesWorkspaceAccountPool
} from "./pendingTurnRouting";

test("keeps a rate-limited load-balanced turn routable after a server restart", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), true);
  assert.equal(pendingUsesWorkspaceAccountPool({
    sessionAccountId: "account-a",
    turnAccountId: "account-a",
    pendingLoadBalance: true,
    workspaceLoadBalanceEnabled: false
  }), true);
});

test("softens an explicitly selected session account after a usage limit", () => {
  assert.equal(pendingLoadBalanceForUpdate({
    pendingReason: "rate_limit",
    persistedLoadBalance: false,
    workspaceLoadBalanceEnabled: false
  }), true);
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
