import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeAccountRows, ClaudeAccountsSection, claudeQuotaWindow, formatClaudeRemaining,formatClaudeStatus, type ClaudeAccount, type ClaudeAccounts } from "./ClaudeAccountsSection";

const now = Date.UTC(2026, 9, 13, 12);

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id: "claude-max", name: "Claude Max", configDir: "/tmp/claude-max", email: "me@example.com",
    organization: null, subscriptionType: "max", loggedIn: true,
    quotaSnapshot: { fiveHour: { usedPercent: 30, resetsAt: now + 3_600_000 }, weekly: { usedPercent: 55, resetsAt: now + 86_400_000 } },
    quotaUpdatedAt: null, quotaError: null,
    ...overrides
  };
}

test("Claude rows in the workspace account table cannot join load balancing", () => {
  const claude = {
    accounts: [account()], busyId: null, error: "",
    listing: { accounts: [account()], workspaceId: "w", workspaceAccountId: "claude-max", sessionAccountId: null, effectiveAccountId: "claude-max" }
  } as unknown as ClaudeAccounts;
  const html = renderToStaticMarkup(<ClaudeAccountRows claude={claude} onRelogin={() => undefined} />);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /can&#x27;t join load balancing/);
  assert.match(html, /Relogin Claude Max/);
  assert.match(html, /Delete Claude Max/);
});

test("Claude popover shows remaining usage per window like Codex accounts", () => {
  const listing = { accounts: [account()], workspaceId: "w", workspaceAccountId: "claude-max", sessionAccountId: null, effectiveAccountId: "claude-max" };
  const claude = { listing, accounts: listing.accounts, busyId: null, error: "", sessionId: null } as unknown as ClaudeAccounts;
  const html = renderToStaticMarkup(<ClaudeAccountsSection claude={claude} onLogin={() => undefined} />);
  assert.match(html, /5hr <strong>70%<\/strong><small>Auto reset: /);
  assert.match(html, /Weekly <strong>45%<\/strong><small>Reset: /);
  assert.equal(claudeQuotaWindow({ usedPercent: null, resetsAt: now }), null);
});

test("Claude remaining and status follow the tightest window and login state", () => {
  assert.equal(formatClaudeRemaining(account(), now), "45%");
  assert.equal(formatClaudeRemaining(account({ quotaSnapshot: { status: "rejected", limitResetsAt: now + 60_000 } }), now), "0%");
  assert.equal(formatClaudeRemaining(account({ quotaSnapshot: null, quotaError: "boom" }), now), "Error");
  assert.equal(formatClaudeStatus(account(), "claude-max", now), "Active");
  assert.equal(formatClaudeStatus(account(), null, now), "Ready");
  assert.equal(formatClaudeStatus(account({ loggedIn: false }), "claude-max", now), "Logged out");
  assert.equal(formatClaudeStatus(account({ quotaSnapshot: { status: "rejected", limitResetsAt: now + 60_000 } }), null, now), "Limited");
});
