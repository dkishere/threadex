import assert from "node:assert/strict";
import test from "node:test";
import { combinedQuotaPercent, formatAccountTier, formatLoadBalanceAccountLabel, formatQuotaWindowReset } from "./accountFormatters";
import { formatTimestamp } from "./formatters";

function quotaWindow(windowDurationMins: number, remaining: number) {
  return {
    usedPercent: 100 - remaining,
    resetsAt: 1_800_000_000,
    windowDurationMins
  };
}

function account(name: string, planType: string, primary: object | null, secondary: object | null = null) {
  return {
    id: name.toLowerCase(),
    name,
    quotaSnapshot: {
      planType,
      primary,
      secondary
    }
  };
}

test("combines load-balance remaining quota with plan capacity multipliers", () => {
  const accounts = [
    account("Team", "team", quotaWindow(300, 100)),
    account("Plus", "plus", quotaWindow(300, 50)),
    account("Pro Lite", "self_serve_business_prolite", quotaWindow(300, 25)),
    account("Pro", "pro", quotaWindow(300, 100))
  ];

    assert.equal(combinedQuotaPercent(accounts, "fiveHour"), 2275 / 27);
});

test("hides the load-balance 5hr total when any account lacks a 5hr window", () => {
  const activeAccount = account("Team", "team", quotaWindow(300, 100), quotaWindow(10_080, 50));
  const weeklyOnlyAccount = account("Weekly", "plus", quotaWindow(10_080, 100));

  assert.equal(combinedQuotaPercent([activeAccount, weeklyOnlyAccount], "fiveHour"), null);
    assert.equal(formatLoadBalanceAccountLabel(activeAccount, [activeAccount, weeklyOnlyAccount]), "LB: Team W 75%");
});

test("does not present a manually active non-candidate as the load-balanced account", () => {
  const workspaceCandidate = account("Workspace account", "team", quotaWindow(300, 100));
  const manuallyActiveElsewhere = account("Elsewhere", "plus", quotaWindow(300, 100));

  assert.equal(
    formatLoadBalanceAccountLabel(manuallyActiveElsewhere, [workspaceCandidate]),
    "LB: 5hr 100%"
  );
});

test("formats 5hr reset times relatively and weekly reset times as a date and time", () => {
  const resetAt = Date.parse("2026-08-26T14:30:00Z");
  const now = Date.parse("2026-08-26T12:00:00Z");
  const window = { resetAt };

  assert.equal(formatQuotaWindowReset(window, "relative", now), "2h 30m");
  assert.equal(formatQuotaWindowReset(window, "dateTime", now), formatTimestamp(new Date(resetAt).toISOString()));
});

test("formats account tiers from current and legacy quota snapshots", () => {
  assert.equal(formatAccountTier({ quotaSnapshot: { planType: "prolite" } }), "Pro Lite");
  assert.equal(formatAccountTier({ quotaSnapshot: { planType: "self_serve_business_prolite" } }), "self_serve_business_prolite");
  assert.equal(formatAccountTier({ quotaSnapshot: { plan_type: "TEAM" } }), "Team");
  assert.equal(formatAccountTier({ quotaSnapshot: null }), null);
});
