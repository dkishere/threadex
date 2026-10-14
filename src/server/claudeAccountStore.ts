import type { SessionDbConnection } from "./sessionDb";

/**
 * Claude accounts live in their own tables so the Codex account machinery
 * (auth.json sync, Codex quota refresh, load balancing, identity checks) never
 * sees them. Each Claude account owns a CLAUDE_CONFIG_DIR holding its login.
 */

export type ClaudeAccountRecord = {
  id: string;
  name: string;
  configDir: string;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
  loggedIn: boolean;
  quotaSnapshot: ClaudeQuotaSnapshot | null;
  quotaUpdatedAt: string | null;
  quotaError: string | null;
  created: string;
  updated: string;
  lastUsed: string | null;
};

export type ClaudeQuotaWindow = {
  /** 0-100 when known. */
  usedPercent: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
};

export type ClaudeQuotaSnapshot = {
  fiveHour?: ClaudeQuotaWindow;
  weekly?: ClaudeQuotaWindow;
  /** Latest limit state reported during a run ("allowed", "allowed_warning", "rejected"). */
  status?: string;
  /** Epoch milliseconds when the currently limiting window resets. */
  limitResetsAt?: number | null;
  limitType?: string | null;
  /** Plain /usage report text, kept when it cannot be parsed into windows. */
  reportText?: string;
  source?: "usage" | "run";
};

export type ClaudeAccountStatusUpdate = {
  loggedIn: boolean;
  email?: string | null;
  organization?: string | null;
  subscriptionType?: string | null;
  authMethod?: string | null;
  quotaError?: string | null;
};

const ACCOUNT_COLUMNS = `
  id, name, config_dir, email, organization, subscription_type, auth_method, logged_in,
  CAST(quota_snapshot AS VARCHAR) AS quota_snapshot,
  CAST(quota_updated_at AS VARCHAR) AS quota_updated_at,
  quota_error,
  CAST(created AS VARCHAR) AS created,
  CAST(updated AS VARCHAR) AS updated,
  CAST(last_used AS VARCHAR) AS last_used
`;

export async function ensureClaudeAccountSchema(connection: SessionDbConnection) {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS claude_accounts (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      config_dir VARCHAR NOT NULL,
      email VARCHAR,
      organization VARCHAR,
      subscription_type VARCHAR,
      auth_method VARCHAR,
      logged_in BOOLEAN NOT NULL DEFAULT FALSE,
      quota_snapshot JSON,
      quota_updated_at TIMESTAMPTZ,
      quota_error VARCHAR,
      created TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used TIMESTAMPTZ
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS workspace_claude_account (
      workspace_id VARCHAR PRIMARY KEY,
      account_id VARCHAR,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS session_claude_account (
      session_id VARCHAR PRIMARY KEY,
      account_id VARCHAR NOT NULL,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function listClaudeAccounts(connection: SessionDbConnection): Promise<ClaudeAccountRecord[]> {
  const result = await connection.run(`SELECT ${ACCOUNT_COLUMNS} FROM claude_accounts ORDER BY lower(name), id`);
  return (await result.getRowObjectsJS()).map(toClaudeAccountRecord);
}

export async function getClaudeAccount(connection: SessionDbConnection, id: string): Promise<ClaudeAccountRecord | null> {
  const result = await connection.run(`SELECT ${ACCOUNT_COLUMNS} FROM claude_accounts WHERE id = $id`, { id });
  const row = (await result.getRowObjectsJS())[0];
  return row ? toClaudeAccountRecord(row) : null;
}

export async function createClaudeAccount(
  connection: SessionDbConnection,
  input: { id: string; name: string; configDir: string }
): Promise<ClaudeAccountRecord> {
  await connection.run(
    `INSERT INTO claude_accounts (id, name, config_dir, created, updated)
     VALUES ($id, $name, $configDir, now(), now())`,
    input
  );
  const account = await getClaudeAccount(connection, input.id);
  if (!account) throw new Error(`Failed to create Claude account ${input.id}.`);
  return account;
}

export async function renameClaudeAccount(connection: SessionDbConnection, id: string, name: string) {
  await connection.run("UPDATE claude_accounts SET name = $name, updated = now() WHERE id = $id", { id, name });
  return getClaudeAccount(connection, id);
}

export async function updateClaudeAccountStatus(
  connection: SessionDbConnection,
  id: string,
  update: ClaudeAccountStatusUpdate
) {
  await connection.run(
    `UPDATE claude_accounts SET
       logged_in = $loggedIn,
       email = COALESCE($email, email),
       organization = COALESCE($organization, organization),
       subscription_type = COALESCE($subscriptionType, subscription_type),
       auth_method = COALESCE($authMethod, auth_method),
       quota_error = $quotaError,
       updated = now()
     WHERE id = $id`,
    {
      id,
      loggedIn: update.loggedIn,
      email: update.email ?? null,
      organization: update.organization ?? null,
      subscriptionType: update.subscriptionType ?? null,
      authMethod: update.authMethod ?? null,
      quotaError: update.quotaError ?? null
    }
  );
  return getClaudeAccount(connection, id);
}

/** Merges a partial quota snapshot so run-time limit events keep the last /usage windows. */
export async function mergeClaudeAccountQuota(
  connection: SessionDbConnection,
  id: string,
  patch: ClaudeQuotaSnapshot,
  quotaError: string | null = null
) {
  const current = await getClaudeAccount(connection, id);
  if (!current) return null;
  const merged: ClaudeQuotaSnapshot = { ...(current.quotaSnapshot ?? {}), ...stripUndefined(patch) };
  await connection.run(
    `UPDATE claude_accounts SET quota_snapshot = $quota::JSON, quota_updated_at = now(), quota_error = $quotaError, updated = now()
     WHERE id = $id`,
    { id, quota: JSON.stringify(merged), quotaError }
  );
  return getClaudeAccount(connection, id);
}

export async function touchClaudeAccount(connection: SessionDbConnection, id: string) {
  await connection.run("UPDATE claude_accounts SET last_used = now() WHERE id = $id", { id });
}

export async function deleteClaudeAccount(connection: SessionDbConnection, id: string) {
  await connection.run("DELETE FROM session_claude_account WHERE account_id = $id", { id });
  await connection.run("UPDATE workspace_claude_account SET account_id = NULL, updated = now() WHERE account_id = $id", { id });
  const result = await connection.run("DELETE FROM claude_accounts WHERE id = $id", { id });
  return result.rowCount > 0;
}

export async function getWorkspaceClaudeAccountId(connection: SessionDbConnection, workspaceId: string) {
  const result = await connection.run("SELECT account_id FROM workspace_claude_account WHERE workspace_id = $workspaceId", { workspaceId });
  const value = (await result.getRowObjectsJS())[0]?.account_id;
  return typeof value === "string" && value ? value : null;
}

export async function setWorkspaceClaudeAccount(connection: SessionDbConnection, workspaceId: string, accountId: string | null) {
  await connection.run(
    `INSERT INTO workspace_claude_account (workspace_id, account_id, updated)
     VALUES ($workspaceId, $accountId, now())
     ON CONFLICT (workspace_id) DO UPDATE SET account_id = excluded.account_id, updated = now()`,
    { workspaceId, accountId }
  );
}

export async function getSessionClaudeAccountId(connection: SessionDbConnection, sessionId: string) {
  const result = await connection.run("SELECT account_id FROM session_claude_account WHERE session_id = $sessionId", { sessionId });
  const value = (await result.getRowObjectsJS())[0]?.account_id;
  return typeof value === "string" && value ? value : null;
}

export async function setSessionClaudeAccount(connection: SessionDbConnection, sessionId: string, accountId: string | null) {
  if (!accountId) {
    await connection.run("DELETE FROM session_claude_account WHERE session_id = $sessionId", { sessionId });
    return;
  }
  await connection.run(
    `INSERT INTO session_claude_account (session_id, account_id, updated)
     VALUES ($sessionId, $accountId, now())
     ON CONFLICT (session_id) DO UPDATE SET account_id = excluded.account_id, updated = now()`,
    { sessionId, accountId }
  );
}

/**
 * Session override, then the workspace's Claude account, then the most recently
 * used logged-in account. Null means "use the machine's default Claude login".
 */
export async function resolveClaudeAccount(
  connection: SessionDbConnection,
  input: { workspaceId: string; sessionId?: string | null }
): Promise<ClaudeAccountRecord | null> {
  const preferredIds = [
    input.sessionId ? await getSessionClaudeAccountId(connection, input.sessionId) : null,
    await getWorkspaceClaudeAccountId(connection, input.workspaceId)
  ];
  for (const id of preferredIds) {
    const account = id ? await getClaudeAccount(connection, id) : null;
    if (account) return account;
  }
  const accounts = await listClaudeAccounts(connection);
  return accounts
    .filter((account) => account.loggedIn)
    .sort((first, second) => (second.lastUsed ?? "").localeCompare(first.lastUsed ?? ""))[0] ?? null;
}

export function toClaudeAccountRecord(row: Record<string, unknown>): ClaudeAccountRecord {
  return {
    id: String(row.id ?? ""),
    name: typeof row.name === "string" && row.name ? row.name : "Claude",
    configDir: String(row.config_dir ?? ""),
    email: nullableString(row.email),
    organization: nullableString(row.organization),
    subscriptionType: nullableString(row.subscription_type),
    authMethod: nullableString(row.auth_method),
    loggedIn: row.logged_in === true,
    quotaSnapshot: parseQuota(row.quota_snapshot),
    quotaUpdatedAt: nullableString(row.quota_updated_at),
    quotaError: nullableString(row.quota_error),
    created: String(row.created ?? ""),
    updated: String(row.updated ?? ""),
    lastUsed: nullableString(row.last_used)
  };
}

function parseQuota(value: unknown): ClaudeQuotaSnapshot | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ClaudeQuotaSnapshot;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ClaudeQuotaSnapshot : null;
  } catch {
    return null;
  }
}

function nullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
