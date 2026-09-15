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
