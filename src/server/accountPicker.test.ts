import assert from "node:assert/strict";
import test from "node:test";
import { chooseLoadBalancedAccount, loadBalanceScore } from "./accountPicker";
import type { AccountRecord } from "./sessionStore";

const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

test("prefers the account with more reported quota despite its recent last use", () => {
  const recent = account("recent", {
    lastUsedMs: nowMs - hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  const ready = account("ready", {
    lastUsedMs: nowMs - 6 * hourMs,
    fiveHourRemaining: 50,
    sevenDayRemaining: 50
  });

  assert.equal(pick([recent, ready]), "recent");
});

test("prefers full 5hr and weekly capacity over a weekly-only account", () => {
  const fullCapacity = account("full-capacity", {
    lastUsedMs: nowMs - hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  const weeklyOnly = account("weekly-only", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 69
  });
  weeklyOnly.quotaSnapshot = {
    primary: {
      usedPercent: 31,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: Math.floor((nowMs + 4 * dayMs) / 1000)
    },
    secondary: null
  };

  assert.equal(pick([weeklyOnly, fullCapacity]), "full-capacity");
});

test("uses accounts with 7d quota that would otherwise be left unused", () => {
  const weeklyConstrained = account("weekly-constrained", {
    lastUsedMs: nowMs - 6 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 20
  });
  const weeklySurplus = account("weekly-surplus", {
    lastUsedMs: nowMs - 6 * hourMs,
    fiveHourRemaining: 70,
    sevenDayRemaining: 90
  });

  assert.equal(pick([weeklyConstrained, weeklySurplus]), "weekly-surplus");
});

test("prefers manual reset value when the 7d reset is later", () => {
  const soonWeeklyReset = account("soon-weekly-reset", {
    lastUsedMs: nowMs - 6 * hourMs,
    fiveHourRemaining: 90,
    sevenDayRemaining: 70,
    sevenDayResetMs: nowMs + dayMs,
    manualResetCount: 1
  });
  const lateWeeklyReset = account("late-weekly-reset", {
    lastUsedMs: nowMs - 6 * hourMs,
    fiveHourRemaining: 90,
    sevenDayRemaining: 70,
    sevenDayResetMs: nowMs + 6 * dayMs,
    manualResetCount: 1
  });

  assert.equal(pick([soonWeeklyReset, lateWeeklyReset]), "late-weekly-reset");
});

test("breaks comparable ties by 5hr remaining before 7d remaining", () => {
  const higherSevenDay = account("higher-seven-day", {
    lastUsedMs: nowMs - 20 * hourMs,
    fiveHourRemaining: 80,
    sevenDayRemaining: 80.1
  });
  const higherFiveHour = account("higher-five-hour", {
    lastUsedMs: nowMs - 8 * hourMs,
    fiveHourRemaining: 81,
    sevenDayRemaining: 80
  });

  assert.equal(pick([higherSevenDay, higherFiveHour]), "higher-five-hour");
});

test("breaks comparable 5hr ties by 7d remaining", () => {
  const lowerSevenDay = account("lower-seven-day", {
    lastUsedMs: nowMs - 20 * hourMs,
    fiveHourRemaining: 80,
    sevenDayRemaining: 80
  });
  const higherSevenDay = account("higher-seven-day", {
    lastUsedMs: nowMs - 8 * hourMs,
    fiveHourRemaining: 80,
    sevenDayRemaining: 80.1
  });

  assert.equal(pick([lowerSevenDay, higherSevenDay]), "higher-seven-day");
});

test("filters accounts without saved auth", () => {
  const missingAuth = account("missing-auth", {
    lastUsedMs: nowMs - 20 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  const usable = account("usable", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 50,
    sevenDayRemaining: 50
  });

  const selected = chooseLoadBalancedAccount([missingAuth, usable], {
    nowMs,
    hasSavedAuth: (candidate) => candidate.id !== "missing-auth"
  });

  assert.equal(selected?.id, "usable");
});

test("filters accounts with exhausted known quota windows", () => {
  const exhaustedFiveHour = account("exhausted-five-hour", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 0,
    sevenDayRemaining: 100
  });
  const exhaustedWeekly = account("exhausted-weekly", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 0
  });
  const usable = account("usable", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 1,
    sevenDayRemaining: 1
  });

  assert.equal(pick([exhaustedFiveHour, exhaustedWeekly, usable]), "usable");
});

test("keeps Team included allowance usable without flexible credits", () => {
  const teamWithoutFlexibleCredits = account("team", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  teamWithoutFlexibleCredits.quotaSnapshot = {
    ...(teamWithoutFlexibleCredits.quotaSnapshot as Record<string, unknown>),
    planType: "team",
    credits: { hasCredits: false, unlimited: false, balance: null }
  };
  const plusWithoutPurchasedCredits = account("plus", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 50,
    sevenDayRemaining: 50
  });
  plusWithoutPurchasedCredits.quotaSnapshot = {
    ...(plusWithoutPurchasedCredits.quotaSnapshot as Record<string, unknown>),
    planType: "plus",
    credits: { hasCredits: false, unlimited: false, balance: "0" }
  };

  assert.equal(loadBalanceScore(teamWithoutFlexibleCredits, { nowMs, hasSavedAuth: () => true }).usable, true);
  assert.equal(loadBalanceScore(plusWithoutPurchasedCredits, { nowMs, hasSavedAuth: () => true }).usable, true);
  assert.equal(pick([teamWithoutFlexibleCredits, plusWithoutPurchasedCredits]), "team");
});

test("filters accounts only on explicit spend or credit limit signals", () => {
  const spendLimited = account("spend-limited", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  spendLimited.quotaSnapshot = {
    ...(spendLimited.quotaSnapshot as Record<string, unknown>),
    spendControlReached: true
  };
  const creditLimited = account("credit-limited", {
    lastUsedMs: nowMs - 10 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 100
  });
  creditLimited.quotaSnapshot = {
    ...(creditLimited.quotaSnapshot as Record<string, unknown>),
    rateLimitReachedType: "workspace_credits_depleted"
  };

  assert.equal(loadBalanceScore(spendLimited, { nowMs, hasSavedAuth: () => true }).creditPoolExhausted, true);
  assert.equal(loadBalanceScore(creditLimited, { nowMs, hasSavedAuth: () => true }).creditPoolExhausted, true);
  assert.equal(pick([spendLimited, creditLimited]), null);
});

test("does not infer a 5hr cooldown when the account reports its quota", () => {
  const score = loadBalanceScore(
    account("cooling", {
      lastUsedMs: nowMs - 2 * hourMs,
      fiveHourRemaining: 100,
      sevenDayRemaining: 100
    }),
    { nowMs, hasSavedAuth: () => true }
  );

  assert.equal(score.inFiveHourCooldown, false);
  assert.equal(score.cooldownUntil, 0);
});

test("does not treat a weekly-only quota window as a 5hr limit", () => {
  const weeklyOnly = account("weekly-only", {
    lastUsedMs: nowMs - 8 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 37
  });
  weeklyOnly.quotaSnapshot = {
    primary: {
      usedPercent: 63,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: Math.floor((nowMs + 4 * dayMs) / 1000)
    },
    secondary: null
  };

  const score = loadBalanceScore(weeklyOnly, { nowMs, hasSavedAuth: () => true });

  assert.equal(score.hasQuotaInfo, true);
  assert.equal(score.inFiveHourCooldown, false);
  assert.equal(score.fiveHourRemaining, 50);
  assert.equal(score.sevenDayRemaining, 37);
});

test("weekly-only accounts rebalance toward the account with more weekly capacity", () => {
  const externallyConsumed = account("externally-consumed", {
    lastUsedMs: nowMs - 2 * hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 91
  });
  const localAccount = account("local-account", {
    lastUsedMs: nowMs - hourMs,
    fiveHourRemaining: 100,
    sevenDayRemaining: 99
  });
  for (const candidate of [externallyConsumed, localAccount]) {
    const remaining = candidate.id === "externally-consumed" ? 91 : 99;
    candidate.quotaSnapshot = {
      primary: {
        usedPercent: 100 - remaining,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: Math.floor((nowMs + 4 * dayMs) / 1000)
      },
      secondary: null
    };
  }

  assert.equal(pick([externallyConsumed, localAccount]), "local-account");
});

function pick(accounts: AccountRecord[]) {
  return chooseLoadBalancedAccount(accounts, { nowMs, hasSavedAuth: () => true })?.id ?? null;
}

function account(
  id: string,
  input: {
    lastUsedMs: number;
    fiveHourRemaining: number;
    sevenDayRemaining: number;
    sevenDayResetMs?: number;
    manualResetCount?: number;
  }
): AccountRecord {
  return {
    id,
    name: id,
    externalAccountId: null,
    externalUserId: null,
    email: null,
    hasAuth: true,
    authVersion: 1,
    quotaSnapshot: {
      primary: {
        usedPercent: 100 - input.fiveHourRemaining,
        windowDurationMins: 5 * 60,
        resetsAt: Math.floor((input.lastUsedMs + 5 * hourMs) / 1000),
        manualResetCount: input.manualResetCount ?? 0
      },
      secondary: {
        usedPercent: 100 - input.sevenDayRemaining,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: Math.floor((input.sevenDayResetMs ?? nowMs + 4 * dayMs) / 1000),
        manualResetCount: input.manualResetCount ?? 0
      }
    },
    quotaUpdatedAt: new Date(nowMs).toISOString(),
    quotaError: null,
    created: new Date(nowMs).toISOString(),
    updated: new Date(nowMs).toISOString(),
    lastUsed: new Date(input.lastUsedMs).toISOString()
  };
}
