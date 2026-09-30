import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatLoadBalance, shouldChooseAccountForNewLoadBalancedThread } from "./loadBalanceRouting";

test("saved pending request metadata cannot re-enable disabled workspace LB", () => {
  assert.equal(resolveChatLoadBalance({
    requestedLoadBalance: true,
    retryPending: true,
    workspaceLoadBalanceEnabled: false
  }), false);
  assert.equal(resolveChatLoadBalance({
    requestedLoadBalance: true,
    retryPending: true,
    workspaceLoadBalanceEnabled: true
  }), true);
});

test("fresh requests can enable LB while manual and unspecified requests stay manual", () => {
  assert.equal(resolveChatLoadBalance({
    requestedLoadBalance: true,
    retryPending: false,
    workspaceLoadBalanceEnabled: false
  }), true);
  for (const requestedLoadBalance of [false, undefined]) {
    for (const retryPending of [false, true]) {
      assert.equal(resolveChatLoadBalance({
        requestedLoadBalance,
        retryPending,
        workspaceLoadBalanceEnabled: true
      }), false);
    }
  }
});

test("chooses a load-balanced account only for a new thread", () => {
  assert.equal(shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace: false,
    retryPending: false,
    hasStoredSession: false,
    hasRequestedThreadId: false
  }), false);
  assert.equal(shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace: true,
    retryPending: false,
    hasStoredSession: false,
    hasRequestedThreadId: false
  }), true);

  assert.equal(shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace: true,
    retryPending: false,
    hasStoredSession: true,
    hasRequestedThreadId: false
  }), false);
  assert.equal(shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace: true,
    retryPending: false,
    hasStoredSession: false,
    hasRequestedThreadId: true
  }), false);
  assert.equal(shouldChooseAccountForNewLoadBalancedThread({
    loadBalanceInWorkspace: true,
    retryPending: true,
    hasStoredSession: false,
    hasRequestedThreadId: false
  }), false);
});
