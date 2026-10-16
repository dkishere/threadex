import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { ClaudeAccountRecord, ClaudeQuotaSnapshot } from "./claudeAccountStore";
import { createClaudeAccountRouter, type ClaudeAccountStoreApi } from "./claudeAccountRoutes";
import type { ClaudeAuthStatus, ClaudeLogin } from "./claudeAccounts";

function memoryStore(): ClaudeAccountStoreApi & { accounts: Map<string, ClaudeAccountRecord>; workspace: Map<string, string | null>; session: Map<string, string> } {
  const accounts = new Map<string, ClaudeAccountRecord>();
  const workspace = new Map<string, string | null>();
  const session = new Map<string, string>();
  const store = {
    accounts, workspace, session,
    async listClaudeAccounts() { return [...accounts.values()]; },
    async getClaudeAccount(id: string) { return accounts.get(id) ?? null; },
    async createClaudeAccount(input: { id: string; name: string; configDir: string }) {
      const record: ClaudeAccountRecord = { ...input, email: null, organization: null, subscriptionType: null, authMethod: null, loggedIn: false, quotaSnapshot: null, quotaUpdatedAt: null, quotaError: null, created: "now", updated: "now", lastUsed: null };
      accounts.set(input.id, record);
      return record;
    },
    async renameClaudeAccount(id: string, name: string) {
      const account = accounts.get(id);
      if (!account) return null;
      account.name = name;
      return account;
    },
    async updateClaudeAccountStatus(id: string, update: Partial<ClaudeAccountRecord> & { loggedIn: boolean }) {
      const account = accounts.get(id);
      if (!account) return null;
      Object.assign(account, Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)), { loggedIn: update.loggedIn, quotaError: update.quotaError ?? null });
      return account;
    },
    async mergeClaudeAccountQuota(id: string, patch: ClaudeQuotaSnapshot, quotaError: string | null = null) {
      const account = accounts.get(id);
      if (!account) return null;
      account.quotaSnapshot = { ...(account.quotaSnapshot ?? {}), ...patch };
      account.quotaError = quotaError;
      return account;
    },
    async deleteClaudeAccount(id: string) { return accounts.delete(id); },
    async getWorkspaceClaudeAccountId(id: string) { return workspace.get(id) ?? null; },
    async setWorkspaceClaudeAccount(id: string, accountId: string | null) { workspace.set(id, accountId); },
    async getSessionClaudeAccountId(id: string) { return session.get(id) ?? null; },
    async setSessionClaudeAccount(id: string, accountId: string | null) { if (accountId) session.set(id, accountId); else session.delete(id); },
    async resolveClaudeAccount(input: { workspaceId: string; sessionId?: string | null }) {
      const id = (input.sessionId ? session.get(input.sessionId) : undefined) ?? workspace.get(input.workspaceId) ?? null;
      return id ? accounts.get(id) ?? null : null;
    },
    async getActiveWorkspace() { return { id: "ws-1" }; }
  };
  return store as never;
}

async function withServer(router: express.Router, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function call(base: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(init.body ? { body: JSON.stringify(init.body) } : {})
  });
  return { status: response.status, body: await response.json() as any };
}

test("add, log in, select and report on a Claude account", async () => {
  const store = memoryStore();
  let loggedIn = false;
  const logins = new Map<string, ClaudeLogin>();
  const available: string[] = [];
  const router = createClaudeAccountRouter({
    store,
    dataDir: "/data",
    onAccountAvailable: (account) => available.push(account.id),
    ops: {
      readStatus: async (): Promise<ClaudeAuthStatus> => ({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", email: loggedIn ? "dk@example.com" : null, organization: null, subscriptionType: loggedIn ? "max" : null, error: null }),
      fetchUsage: async () => ({ quota: { fiveHour: { usedPercent: 12, resetsAt: 1 }, source: "usage" as const }, email: null, subscriptionType: null, organization: null }),
      startLogin: (accountId, configDir) => {
        const login = { id: `login-${accountId}`, accountId, configDir, output: "Open https://claude.ai/oauth/x", loginUrl: "https://claude.ai/oauth/x", exited: false, exitCode: null, startedAt: Date.now() } as unknown as ClaudeLogin;
        logins.set(login.id, login);
        return login;
      },
      getLogin: (id) => logins.get(id) ?? null,
      finishLogin: (id) => { logins.delete(id); },
      sendLoginCode: () => undefined,
      logout: async () => undefined
    }
  });

  await withServer(router, async (base) => {
    assert.equal((await call(base, "/api/claude-accounts", { body: {} })).status, 400);
    const created = await call(base, "/api/claude-accounts", { body: { name: "Personal Max" } });
    assert.equal(created.status, 200);
    const id = created.body.account.id as string;
    assert.match(id, /^personal-max-/);
    assert.equal(created.body.account.configDir, `/data/account-claude-homes/${id}`);
    assert.equal(created.body.workspaceAccountId, id, "first account becomes the workspace's Claude account");
    assert.equal(created.body.login.loginUrl, "https://claude.ai/oauth/x");
    assert.match(created.body.login.manualCommand, /CLAUDE_CONFIG_DIR=.+ auth login/);

    const waiting = await call(base, `/api/claude-accounts/login/${created.body.login.loginId}`);
    assert.equal(waiting.body.complete, false);

    loggedIn = true;
    const stillAuthorizing = await call(base, `/api/claude-accounts/login/${created.body.login.loginId}`);
    assert.equal(stillAuthorizing.body.complete, false, "old credentials must not complete a new login");
    assert.equal(logins.has(created.body.login.loginId), true, "pending browser authorization must not be terminated");
    assert.equal(available.length, 0);
    const login = logins.get(created.body.login.loginId)!;
    login.exited = true;
    login.exitCode = 1;
    const failed = await call(base, `/api/claude-accounts/login/${login.id}`);
    assert.equal(failed.body.complete, false, "a failed login must not succeed using old credentials");
    login.exitCode = 0;
    const done = await call(base, `/api/claude-accounts/login/${created.body.login.loginId}`);
    assert.equal(done.body.complete, true);
    assert.equal(done.body.account.email, "dk@example.com");
    assert.equal(done.body.account.loggedIn, true);
    assert.deepEqual(done.body.account.quotaSnapshot.fiveHour, { usedPercent: 12, resetsAt: 1 });
    assert.ok(available.includes(id));

    const second = await call(base, "/api/claude-accounts", { body: { name: "Work" } });
    const secondId = second.body.account.id as string;
    assert.equal(second.body.workspaceAccountId, id, "adding another account keeps the current selection");

    const pinned = await call(base, "/api/claude-accounts/select", { body: { accountId: secondId, scope: "session", sessionId: "s-1" } });
    assert.equal(pinned.body.sessionAccountId, secondId);
    assert.equal(pinned.body.effectiveAccountId, secondId);
    assert.equal((await call(base, "/api/claude-accounts/select", { body: { accountId: "missing", scope: "workspace" } })).status, 404);

    assert.equal((await call(base, "/api/claude-accounts/report", { body: { accountId: id, kind: "rate_limit", info: { status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" } } })).status, 200);
    assert.equal(store.accounts.get(id)?.quotaSnapshot?.status, "rejected");
    assert.equal(store.accounts.get(id)?.quotaSnapshot?.limitResetsAt, 1_800_000_000_000);

    await call(base, "/api/claude-accounts/report", { body: { accountId: id, kind: "auth_failed", info: { error: "authentication_failed" } } });
    assert.equal(store.accounts.get(id)?.loggedIn, false);
    assert.match(store.accounts.get(id)?.quotaError ?? "", /Log in again/);

    const listing = await call(base, `/api/claude-accounts/${secondId}`, { method: "DELETE" });
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.accounts.map((account: ClaudeAccountRecord) => account.id), [id]);
  });
});
