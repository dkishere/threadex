import assert from "node:assert/strict";
import test from "node:test";
import { isAccountLoginRequiredMessage } from "../codexAuth";
import { accountAuthIdentityError, readAccountAuthIdentity } from "./accountAuth";

function authFor(accountId: string, userId: string, refresh = "refresh") {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: userId } })
  ).toString("base64url");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { account_id: accountId, access_token: `header.${payload}.signature`, refresh_token: refresh }
  });
}

test("recognizes rejected refresh-token errors as requiring login", () => {
  assert.equal(
    isAccountLoginRequiredMessage(
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."
    ),
    true
  );
  assert.equal(isAccountLoginRequiredMessage("refresh token was revoked"), true);
  assert.equal(
    isAccountLoginRequiredMessage(
      "Account dkishere auth mismatch: saved auth belongs to account dillion, not dkishere."
    ),
    true
  );
  assert.equal(isAccountLoginRequiredMessage("temporary network error"), false);
});

test("reads and validates the ChatGPT identity in auth.json", () => {
  const authRaw = authFor("account-a", "user-a");
  assert.deepEqual(readAccountAuthIdentity(authRaw), {
    externalAccountId: "account-a",
    externalUserId: "user-a"
  });
  assert.match(
    accountAuthIdentityError(authRaw, { externalAccountId: "account-b", externalUserId: "user-a" }) ?? "",
    /account-a.*account-b/
  );
});
