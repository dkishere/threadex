import assert from "node:assert/strict";
import test from "node:test";

import {
  pendingLoadBalanceForUpdate,
  pendingRetryAt,
  pendingTurnRunsAutomatically,
  pendingUsesWorkspaceAccountPool
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
