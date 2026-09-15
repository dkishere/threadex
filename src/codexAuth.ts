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

  return refreshTokenRejected || expiredCodexToken || accountAuthMismatch;
}
