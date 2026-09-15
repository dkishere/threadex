export type AccountAuthIdentity = {
  externalAccountId?: string | null;
  externalUserId?: string | null;
};

export function readAccountAuthIdentity(authRaw: string): Required<AccountAuthIdentity> {
  try {
    const parsed = JSON.parse(authRaw) as Record<string, unknown>;
    const tokens = readObject(parsed.tokens) ?? parsed;
    const accessToken = stringField(tokens, "access_token") ?? stringField(tokens, "accessToken");
    const claims = parseJwtPayload(accessToken);
    const authClaims = readObject(claims?.["https://api.openai.com/auth"]) ?? {};
    return {
      externalAccountId:
        stringField(tokens, "account_id") ??
        stringField(authClaims, "chatgpt_account_id") ??
        stringField(authClaims, "user_id"),
      externalUserId: stringField(authClaims, "user_id")
    };
  } catch {
    return { externalAccountId: null, externalUserId: null };
  }
}

export function accountAuthIdentityError(authRaw: string, expected: AccountAuthIdentity) {
  const actual = readAccountAuthIdentity(authRaw);
  if (
    expected.externalAccountId &&
    actual.externalAccountId &&
    expected.externalAccountId !== actual.externalAccountId
  ) {
    return `saved auth belongs to account ${actual.externalAccountId}, not ${expected.externalAccountId}`;
  }
  if (expected.externalUserId && actual.externalUserId && expected.externalUserId !== actual.externalUserId) {
    return `saved auth belongs to user ${actual.externalUserId}, not ${expected.externalUserId}`;
  }
  return null;
}

function parseJwtPayload(token: string | null) {
  if (!token) {
    return null;
  }
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}
