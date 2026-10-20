export function isAccountLoginRequiredMessage(value: string | null | undefined) {
  const message = value?.toLowerCase() ?? "";
  const refreshTokenRejected =
    message.includes("refresh token") &&
    (message.includes("revoked") || message.includes("already used"));
  const expiredCodexToken = message.includes("token_expired") || (
    message.includes("401 unauthorized") && (
      message.includes("chatgpt.com/backend-api/wham/usage") || message.includes("rate limit")
    )
  );
  const accountAuthMismatch =
    message.includes("auth mismatch") ||
    (message.includes("saved auth belongs to") && (message.includes("account") || message.includes("user")));
  // Turn runners start a fresh app-server and isolated runners retry once with a
  // new process, so this rejection is not stale routing state: the account's
  // workspace credentials are unusable until it signs in again.
  const workspaceRoutingRejected = message.includes("workspace routing discovery unauthorized");

  return refreshTokenRejected || expiredCodexToken || accountAuthMismatch || workspaceRoutingRejected;
}
