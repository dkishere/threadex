import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { Router, type Request, type Response } from "express";
import type { ClaudeAccountRecord, ClaudeAccountStatusUpdate, ClaudeQuotaSnapshot } from "./claudeAccountStore";
import {
  claudeLoginOutputTail,
  logoutClaude,
  fetchClaudeUsage,
  finishClaudeLogin,
  getClaudeLogin,
  manualLoginCommand,
  quotaFromRateLimitInfo,
  readClaudeAuthStatus,
  sendClaudeLoginCode,
  startClaudeLogin,
  type ClaudeAuthStatus,
  type ClaudeLogin
} from "./claudeAccounts";

export type ClaudeAccountStoreApi = {
  listClaudeAccounts(): Promise<ClaudeAccountRecord[]>;
  getClaudeAccount(id: string): Promise<ClaudeAccountRecord | null>;
  createClaudeAccount(input: { id: string; name: string; configDir: string }): Promise<ClaudeAccountRecord>;
  renameClaudeAccount(id: string, name: string): Promise<ClaudeAccountRecord | null>;
  updateClaudeAccountStatus(id: string, update: ClaudeAccountStatusUpdate): Promise<ClaudeAccountRecord | null>;
  mergeClaudeAccountQuota(id: string, patch: ClaudeQuotaSnapshot, quotaError?: string | null): Promise<ClaudeAccountRecord | null>;
  deleteClaudeAccount(id: string): Promise<boolean>;
  getWorkspaceClaudeAccountId(workspaceId: string): Promise<string | null>;
  setWorkspaceClaudeAccount(workspaceId: string, accountId: string | null): Promise<void>;
  getSessionClaudeAccountId(sessionId: string): Promise<string | null>;
  setSessionClaudeAccount(sessionId: string, accountId: string | null): Promise<void>;
  resolveClaudeAccount(input: { workspaceId: string; sessionId?: string | null }): Promise<ClaudeAccountRecord | null>;
  getActiveWorkspace(): Promise<{ id: string }>;
};

/** CLI/SDK operations, injectable for tests. */
export type ClaudeAccountOps = {
  readStatus(configDir: string): Promise<ClaudeAuthStatus>;
  fetchUsage: typeof fetchClaudeUsage;
  startLogin(accountId: string, configDir: string): ClaudeLogin;
  getLogin(loginId: string): ClaudeLogin | null;
  finishLogin(loginId: string): void;
  sendLoginCode(loginId: string, code: string): void;
  logout(configDir: string): Promise<void>;
};

const defaultOps: ClaudeAccountOps = {
  readStatus: readClaudeAuthStatus,
  fetchUsage: fetchClaudeUsage,
  startLogin: startClaudeLogin,
  getLogin: getClaudeLogin,
  finishLogin: finishClaudeLogin,
  sendLoginCode: sendClaudeLoginCode,
  logout: logoutClaude
};

export function createClaudeAccountRouter(input: {
  store: ClaudeAccountStoreApi;
  dataDir: string;
  ops?: Partial<ClaudeAccountOps>;
  /** Called after an account's limit clears or login succeeds, to retry waiting turns. */
  onAccountAvailable?: (account: ClaudeAccountRecord) => void;
}) {
  const { store } = input;
  const ops: ClaudeAccountOps = { ...defaultOps, ...input.ops };
  const homesDir = resolve(input.dataDir, "account-claude-homes");
  const router = Router();

  async function listing(workspaceId?: string | null, sessionId?: string | null) {
    const resolvedWorkspaceId = workspaceId || (await store.getActiveWorkspace()).id;
    const [accounts, workspaceAccountId, sessionAccountId, effective] = await Promise.all([
      store.listClaudeAccounts(),
      store.getWorkspaceClaudeAccountId(resolvedWorkspaceId),
      sessionId ? store.getSessionClaudeAccountId(sessionId) : Promise.resolve(null),
      store.resolveClaudeAccount({ workspaceId: resolvedWorkspaceId, sessionId })
    ]);
    return {
      accounts,
      workspaceId: resolvedWorkspaceId,
      workspaceAccountId,
      sessionAccountId,
      effectiveAccountId: effective?.id ?? null
    };
  }

  async function applyStatus(account: ClaudeAccountRecord, status: ClaudeAuthStatus) {
    return store.updateClaudeAccountStatus(account.id, {
      loggedIn: status.loggedIn,
      email: status.email,
      organization: status.organization,
      subscriptionType: status.subscriptionType,
      authMethod: status.authMethod,
      quotaError: status.loggedIn ? null : status.error ?? "Not logged in."
    });
  }

  async function refreshUsage(account: ClaudeAccountRecord) {
    try {
      const usage = await ops.fetchUsage(account.configDir);
      if (usage.email || usage.subscriptionType || usage.organization) {
        await store.updateClaudeAccountStatus(account.id, {
          loggedIn: true,
          email: usage.email,
          subscriptionType: usage.subscriptionType,
          organization: usage.organization
        });
      }
      // Fresh windows supersede the last run-time limit; without them keep it.
      const hasWindows = Boolean(usage.quota.fiveHour || usage.quota.weekly);
      const updated = await store.mergeClaudeAccountQuota(account.id, hasWindows ? { ...usage.quota, status: "allowed", limitResetsAt: null } : usage.quota, null);
      if (updated && hasWindows) input.onAccountAvailable?.(updated);
      return updated;
    } catch (error) {
      return store.mergeClaudeAccountQuota(account.id, {}, errorMessage(error));
    }
  }

  function loginPayload(login: ClaudeLogin) {
    return {
      loginId: login.id,
      loginUrl: login.loginUrl,
      manualCommand: manualLoginCommand(login.configDir),
      output: claudeLoginOutputTail(login),
      exited: login.exited
    };
  }

  router.get("/api/claude-accounts", handle(async (req, res) => {
    res.json(await listing(queryString(req.query.workspaceId), queryString(req.query.sessionId)));
  }));

  router.post("/api/claude-accounts", handle(async (req, res) => {
    const name = bodyString(req.body?.name);
    if (!name) return void res.status(400).json({ error: "Account name is required." });
    const id = `${slug(name)}-${randomUUID().slice(0, 8)}`;
    const account = await store.createClaudeAccount({ id, name, configDir: resolve(homesDir, id) });
    const workspaceId = bodyString(req.body?.workspaceId) || (await store.getActiveWorkspace()).id;
    if (!(await store.getWorkspaceClaudeAccountId(workspaceId))) {
      await store.setWorkspaceClaudeAccount(workspaceId, account.id);
    }
    const login = ops.startLogin(account.id, account.configDir);
    res.json({ account, login: loginPayload(login), ...(await listing(workspaceId, bodyString(req.body?.sessionId))) });
  }));

  router.post("/api/claude-accounts/select", handle(async (req, res) => {
    const workspaceId = bodyString(req.body?.workspaceId) || (await store.getActiveWorkspace()).id;
    const sessionId = bodyString(req.body?.sessionId);
    const accountId = bodyString(req.body?.accountId);
    const scope = req.body?.scope === "session" ? "session" : "workspace";
    if (accountId && !(await store.getClaudeAccount(accountId))) {
      return void res.status(404).json({ error: `Claude account not found: ${accountId}` });
    }
    if (scope === "session") {
      if (!sessionId) return void res.status(400).json({ error: "sessionId is required for a session selection." });
      await store.setSessionClaudeAccount(sessionId, accountId);
    } else {
      await store.setWorkspaceClaudeAccount(workspaceId, accountId);
    }
    res.json(await listing(workspaceId, sessionId));
  }));

  router.post("/api/claude-accounts/report", handle(async (req, res) => {
    const accountId = bodyString(req.body?.accountId);
    const account = accountId ? await store.getClaudeAccount(accountId) : null;
    if (!account) return void res.status(404).json({ error: "Claude account not found." });
    const info = req.body?.info && typeof req.body.info === "object" ? req.body.info as Record<string, unknown> : {};
    if (req.body?.kind === "auth_failed") {
      await store.updateClaudeAccountStatus(account.id, { loggedIn: false, quotaError: `Login failed (${String(info.error ?? "authentication_failed")}). Log in again.` });
    } else {
      await store.mergeClaudeAccountQuota(account.id, quotaFromRateLimitInfo(info), null);
    }
    res.json({ ok: true });
  }));

  router.get("/api/claude-accounts/login/:loginId", handle(async (req, res) => {
    const login = ops.getLogin(String(req.params.loginId));
    if (!login) return void res.status(404).json({ error: "Login session not found or expired." });
    const account = await store.getClaudeAccount(login.accountId);
    if (!account) {
      ops.finishLogin(login.id);
      return void res.status(404).json({ error: "Claude account was deleted." });
    }
    // Existing credentials can still report loggedIn while a replacement login
    // is waiting for browser approval. Never kill that login based on old auth.
    if (!login.exited || login.exitCode !== 0) {
      return void res.json({ complete: false, account, ...loginPayload(login) });
    }
    const status = await ops.readStatus(account.configDir);
    if (status.loggedIn) {
      ops.finishLogin(login.id);
      const updated = await applyStatus(account, status);
      const withUsage = updated ? await refreshUsage(updated) : null;
      if (updated) input.onAccountAvailable?.(withUsage ?? updated);
      return void res.json({ complete: true, account: withUsage ?? updated, ...loginPayload(login) });
    }
    res.json({ complete: false, account, ...loginPayload(login) });
  }));

  router.post("/api/claude-accounts/login/:loginId/code", handle(async (req, res) => {
    const code = bodyString(req.body?.code);
    if (!code) return void res.status(400).json({ error: "code is required." });
    ops.sendLoginCode(String(req.params.loginId), code);
    res.json({ ok: true });
  }));

  router.post("/api/claude-accounts/:id/login", handle(async (req, res) => {
    const account = await store.getClaudeAccount(String(req.params.id));
    if (!account) return void res.status(404).json({ error: "Claude account not found." });
    res.json({ account, login: loginPayload(ops.startLogin(account.id, account.configDir)) });
  }));

  router.post("/api/claude-accounts/:id/refresh", handle(async (req, res) => {
    const account = await store.getClaudeAccount(String(req.params.id));
    if (!account) return void res.status(404).json({ error: "Claude account not found." });
    const status = await ops.readStatus(account.configDir);
    const updated = await applyStatus(account, status);
    const refreshed = status.loggedIn && updated ? await refreshUsage(updated) : updated;
    res.json({ account: refreshed });
  }));

  router.post("/api/claude-accounts/:id/rename", handle(async (req, res) => {
    const name = bodyString(req.body?.name);
    if (!name) return void res.status(400).json({ error: "Account name is required." });
    const account = await store.renameClaudeAccount(String(req.params.id), name);
    if (!account) return void res.status(404).json({ error: "Claude account not found." });
    res.json({ account });
  }));

  router.delete("/api/claude-accounts/:id", handle(async (req, res) => {
    const account = await store.getClaudeAccount(String(req.params.id));
    if (!account) return void res.status(404).json({ error: "Claude account not found." });
    await ops.logout(account.configDir).catch(() => undefined);
    await store.deleteClaudeAccount(account.id);
    if (account.configDir.startsWith(`${homesDir}/`)) rmSync(account.configDir, { recursive: true, force: true });
    res.json(await listing(queryString(req.query.workspaceId), queryString(req.query.sessionId)));
  }));

  return router;
}

function handle(operation: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    operation(req, res).catch((error) => {
      if (!res.headersSent) res.status(500).json({ error: errorMessage(error) });
    });
  };
}

function bodyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function queryString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "claude";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
