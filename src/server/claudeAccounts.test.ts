import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeAccountEnv,
  claudeQuotaRetryAt,
  extractLoginUrl,
  manualLoginCommand,
  parseClaudeAuthStatus,
  quotaFromRateLimitInfo,
  quotaFromUsageReport
} from "./claudeAccounts";
import { resolveClaudeAccount } from "./claudeAccountStore";
import type { SessionDbConnection } from "./sessionDb";

test("auth status JSON is read defensively", () => {
  const status = parseClaudeAuthStatus(JSON.stringify({
    authMethod: "claude.ai",
    configDirectory: "/data/acct",
    account: { email: "dk@example.com", orgName: "Personal" },
    subscriptionType: "max"
  }), 0);
  assert.deepEqual(status, { loggedIn: true, authMethod: "claude.ai", email: "dk@example.com", organization: "Personal", subscriptionType: "max", error: null });
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ authMethod: "none" }), 1).loggedIn, false);
  assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "claude.ai" }), 0).loggedIn, false);
  const garbage = parseClaudeAuthStatus("command not found", 127);
  assert.equal(garbage.loggedIn, false);
  assert.equal(garbage.error, "command not found");
});

test("account environment isolates the account's login", () => {
  const env = claudeAccountEnv("/data/acct", { CLAUDE_CODE_OAUTH_TOKEN: "global", ANTHROPIC_API_KEY: "sk", CLAUDECODE: "1", PATH: "/bin" });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/data/acct");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.PATH, "/bin");
  assert.match(manualLoginCommand("/data/it's"), /^CLAUDE_CONFIG_DIR='\/data\/it'\\''s' .+ auth login$/);
});

test("login URL is found in CLI output with ANSI noise", () => {
  const output = "\u001b[1mOpening browser\u001b[0m\nIf it did not open, visit: https://claude.ai/oauth/authorize?code=true&client_id=abc).\n";
  assert.equal(extractLoginUrl(output), "https://claude.ai/oauth/authorize?code=true&client_id=abc");
  assert.equal(extractLoginUrl("no url"), null);
});

test("rate limit events become quota patches", () => {
  const rejected = quotaFromRateLimitInfo({ status: "rejected", resetsAt: 1_800_000_000, rateLimitType: "five_hour" });
  assert.deepEqual(rejected, {
    status: "rejected",
    limitResetsAt: 1_800_000_000_000,
    limitType: "five_hour",
    source: "run",
    fiveHour: { usedPercent: 100, resetsAt: 1_800_000_000_000 }
  });
  const weekly = quotaFromRateLimitInfo({ status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "seven_day", utilization: 0.82 });
  assert.deepEqual(weekly.weekly, { usedPercent: 82, resetsAt: 1_800_000_000_000 });
  assert.equal(weekly.limitResetsAt, null);
  assert.equal(quotaFromRateLimitInfo({ status: "allowed", rateLimitType: "seven_day_opus", resetsAt: 1 }).weekly, undefined);
});

test("usage reports are parsed by window name", () => {
  const quota = quotaFromUsageReport({
    limits: {
      five_hour: { utilization: 23, resets_at: "2026-10-13T15:00:00Z" },
      seven_day: { utilization: 41.5, resets_at: "2026-10-17T09:00:00Z" },
      seven_day_opus: { utilization: 90, resets_at: "2026-10-17T09:00:00Z" }
    }
  });
  assert.deepEqual(quota, {
    fiveHour: { usedPercent: 23, resetsAt: Date.parse("2026-10-13T15:00:00Z") },
    weekly: { usedPercent: 41.5, resetsAt: Date.parse("2026-10-17T09:00:00Z") }
  });
  const list = quotaFromUsageReport({ windows: [{ name: "session", used_percentage: 0.5, resetsAt: 1_800_000_000 }] });
  assert.deepEqual(list.fiveHour, { usedPercent: 50, resetsAt: 1_800_000_000_000 });
  assert.deepEqual(quotaFromUsageReport(null), {});
});

test("retry time comes from the limiting window", () => {
  const now = 1_000_000;
  assert.equal(claudeQuotaRetryAt(null, now), null);
  assert.equal(claudeQuotaRetryAt({ status: "rejected", limitResetsAt: now + 5000 }, now), now + 5000);
  assert.equal(claudeQuotaRetryAt({ status: "rejected", limitResetsAt: now - 5000 }, now), null);
  assert.equal(claudeQuotaRetryAt({ status: "allowed", fiveHour: { usedPercent: 40, resetsAt: now + 1000 } }, now), null);
  assert.equal(claudeQuotaRetryAt({ weekly: { usedPercent: 100, resetsAt: now + 9000 }, fiveHour: { usedPercent: 100, resetsAt: now + 1000 } }, now), now + 9000);
});

test("account resolution prefers session, then workspace, then last used logged-in account", async () => {
  const rows = [
    { id: "a", name: "A", config_dir: "/a", logged_in: true, last_used: "2026-10-01" },
    { id: "b", name: "B", config_dir: "/b", logged_in: true, last_used: "2026-10-10" },
    { id: "c", name: "C", config_dir: "/c", logged_in: false, last_used: "2026-10-12" }
  ];
  const selections: { session: string | null; workspace: string | null } = { session: null, workspace: null };
  const connection = {
    backend: "postgres",
    async run(sql: string, params: Record<string, unknown> = {}) {
      let result: Record<string, unknown>[] = [];
      if (sql.includes("FROM session_claude_account")) result = selections.session ? [{ account_id: selections.session }] : [];
      else if (sql.includes("FROM workspace_claude_account")) result = selections.workspace ? [{ account_id: selections.workspace }] : [];
      else if (sql.includes("WHERE id = $id")) result = rows.filter((row) => row.id === params.id);
      else if (sql.includes("FROM claude_accounts")) result = rows;
      return { rowCount: result.length, getRowObjectsJS: async () => result };
    }
  } as unknown as SessionDbConnection;

  assert.equal((await resolveClaudeAccount(connection, { workspaceId: "w", sessionId: "s" }))?.id, "b");
  selections.workspace = "a";
  assert.equal((await resolveClaudeAccount(connection, { workspaceId: "w", sessionId: "s" }))?.id, "a");
  selections.session = "c";
  assert.equal((await resolveClaudeAccount(connection, { workspaceId: "w", sessionId: "s" }))?.id, "c");
  selections.session = "deleted";
  assert.equal((await resolveClaudeAccount(connection, { workspaceId: "w", sessionId: "s" }))?.id, "a");
});
