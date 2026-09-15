import assert from "node:assert/strict";
import test from "node:test";
import { shouldChooseAccountForNewLoadBalancedThread } from "./loadBalanceRouting";

test("chooses a load-balanced account only for a new thread", () => {
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
