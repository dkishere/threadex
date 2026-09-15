import assert from "node:assert/strict";
import test from "node:test";
import { sortAccountsByLoadBalanceParticipation, startChatGptLogin, switchAccount } from "./sessionActions03.js";

test("puts load-balance candidates before other selectable accounts", () => {
  const accounts = [
    { id: "alpha" },
    { id: "bravo" },
    { id: "charlie" },
    { id: "delta" }
  ];

  const sorted = sortAccountsByLoadBalanceParticipation(accounts, ["bravo", "delta"]);

  assert.deepEqual(sorted.map((account) => account.id), ["bravo", "delta", "alpha", "charlie"]);
  assert.deepEqual(accounts.map((account) => account.id), ["alpha", "bravo", "charlie", "delta"]);
});

test("account switching keeps the current Threadex session and sends its id to the server", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: unknown = null;
  const statuses: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ activeAccount: { id: "account-new" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await switchAccount({
      accountIdentityLabel: (account: { id: string }) => account.id,
      accountList: [{ id: "account-new" }],
      accountNeedsLogin: () => false,
      activeWorkspace: { id: "threadex" },
      applyAccountPayload: () => undefined,
      beginAccountRelogin: () => assert.fail("should not relogin"),
      sessionId: "local-existing",
      setIsAccountPopoverOpen: () => undefined,
      setStatus: (status: string) => statuses.push(status),
      setUseLoadBalanceInWorkspace: () => undefined
    }, "account-new");

    assert.deepEqual(requestBody, { accountId: "account-new", sessionId: "local-existing" });
    assert.equal(statuses.at(-1), "Account switched; session context preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ChatGPT relogin carries the current session through login completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let requestBody: unknown = null;
  let polledLoginId: string | null = null;
  const popup = { closed: false, location: { href: "about:blank" }, close() {} };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { open: () => popup }
  });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ loginId: "login-1", loginUrl: "https://login.example/", userCode: "ABCD" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await startChatGptLogin({
      accountLoginTargetId: "account-old",
      cleanLoginUrlValue: (value: string) => value,
      isSavingAccount: false,
      newAccountName: "Old account",
      pollChatGptLoginStatus: (loginId: string) => { polledLoginId = loginId; },
      sessionId: "local-existing",
      setIsSavingAccount: () => undefined,
      setPendingAccountLogin: () => undefined,
      setStatus: () => undefined
    }, undefined);

    assert.deepEqual(requestBody, {
      accountId: "account-old",
      name: "Old account",
      sessionId: "local-existing"
    });
    assert.equal(polledLoginId, "login-1");
    assert.equal(popup.location.href, "https://login.example/");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
