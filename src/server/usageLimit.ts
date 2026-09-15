export function isCreditExhaustionError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("workspace_member_credits_depleted") ||
    normalized.includes("out of credit") ||
    normalized.includes("insufficient credit") ||
    normalized.includes("credits depleted") ||
    normalized.includes("credit balance exhausted");
}

export function isUsageLimitError(message: string) {
  const normalized = message.toLowerCase();
  if (isCreditExhaustionError(normalized)) {
    return true;
  }

  const hasLimitSignal =
    normalized.includes("usage limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("out of usage") ||
    normalized.includes("exceeded") ||
    normalized.includes("limit reached");
  const hasResetSignal =
    normalized.includes("reset") ||
    normalized.includes("try again") ||
    normalized.includes("retry") ||
    normalized.includes("later");

  return hasLimitSignal && (hasResetSignal || normalized.includes("usage") || normalized.includes("quota"));
}
