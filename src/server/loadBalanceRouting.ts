export function resolveChatLoadBalance(input: {
  requestedLoadBalance: boolean | undefined;
  retryPending: boolean;
  workspaceLoadBalanceEnabled: boolean;
}) {
  // A retry can replay request metadata captured before LB was disabled.
  return input.requestedLoadBalance === true &&
    (!input.retryPending || input.workspaceLoadBalanceEnabled);
}

export function shouldChooseAccountForNewLoadBalancedThread(input: {
  loadBalanceInWorkspace: boolean;
  retryPending: boolean;
  hasStoredSession: boolean;
  hasRequestedThreadId: boolean;
}) {
  return input.loadBalanceInWorkspace
    && !input.retryPending
    && !input.hasStoredSession
    && !input.hasRequestedThreadId;
}
