import type { AccountRecord } from "./sessionStore";

const fiveHourCooldownMs = 5 * 60 * 60 * 1000;
const weeklyQuotaWindowMs = 7 * 24 * 60 * 60 * 1000;
const weeklyToFiveHourLimitRatio = 6.5;

type QuotaWindow = {
  remaining: number;
  resetAt: number;
  windowDurationMins: number | null;
  manualResetCount: number | null;
};

export type AccountPickerOptions = {
  nowMs?: number;
  hasSavedAuth?: (account: AccountRecord) => boolean;
};

export type AccountLoadBalanceScore = {
  usable: boolean;
  hasQuotaInfo: boolean;
  creditPoolExhausted: boolean;
  inFiveHourCooldown: boolean;
  cooldownUntil: number;
  lastUsedAt: number;
  fiveHourRemaining: number;
  sevenDayRemaining: number;
  sevenDayResetAt: number;
  weeklySurplusScore: number;
  manualResetScore: number;
};

export function chooseLoadBalancedAccount(
  accounts: AccountRecord[],
  options: AccountPickerOptions = {}
): AccountRecord | null {
  const scored = accounts
    .map((account) => ({ account, score: loadBalanceScore(account, options) }))
    .filter(({ score }) => score.usable);

  if (scored.length === 0) {
    return null;
  }

  scored.sort((first, second) => compareLoadBalanceScores(first, second));
  return scored[0]?.account ?? null;
}

export function loadBalanceScore(
  account: AccountRecord,
  options: AccountPickerOptions = {}
): AccountLoadBalanceScore {
  const nowMs = options.nowMs ?? Date.now();
  const hasSavedAuth = options.hasSavedAuth ? options.hasSavedAuth(account) : account.hasAuth;
  const quota = account.quotaSnapshot && typeof account.quotaSnapshot === "object"
    ? (account.quotaSnapshot as Record<string, unknown>)
    : null;
  const primary = readQuotaWindow(quota?.primary);
  const secondary = readQuotaWindow(quota?.secondary);
  const fiveHourWindow = pickFiveHourWindow(primary, secondary);
  const sevenDayWindow = pickSevenDayWindow(primary, secondary);
  const creditPoolExhausted = hasExhaustedWorkspaceCreditPool(quota);
  const lastUsedAt = account.lastUsed ? parseAccountTimestampMs(account.lastUsed) : 0;
  // Prefer the actual reported 5-hour remaining quota. `lastUsed` is updated
  // when the active account changes, including a preselection that may never
  // handle a turn, so treating it as usage can incorrectly sideline a 100%
  // account for five hours. Keep the timestamp only as a fallback when no
  // quota information is available at all.
  const useFiveHourCooldown = !primary && !secondary;
  const cooldownUntil = useFiveHourCooldown && lastUsedAt > 0
    ? lastUsedAt + fiveHourCooldownMs
    : 0;
  const inFiveHourCooldown = cooldownUntil > nowMs;
  const fiveHourRemaining = fiveHourWindow?.remaining ?? 50;
  const sevenDayRemaining = sevenDayWindow?.remaining ?? 50;
  const hasFiveHourCapacity = !fiveHourWindow || fiveHourRemaining > 0;
  const hasSevenDayCapacity = !sevenDayWindow || sevenDayRemaining > 0;
  const sevenDayResetAt = sevenDayWindow?.resetAt ?? Number.MAX_SAFE_INTEGER;
  const sevenDayResetDistance = Number.isFinite(sevenDayResetAt)
    ? Math.max(0, Math.min(weeklyQuotaWindowMs, sevenDayResetAt - nowMs))
    : weeklyQuotaWindowMs;
  const manualResetCount = Math.max(fiveHourWindow?.manualResetCount ?? 0, sevenDayWindow?.manualResetCount ?? 0);
  const hasQuotaInfo = Boolean(primary || secondary);

  return {
    usable: hasSavedAuth &&
      !(account.quotaError && !hasQuotaInfo) &&
      !creditPoolExhausted &&
      hasFiveHourCapacity &&
      hasSevenDayCapacity,
    hasQuotaInfo,
    creditPoolExhausted,
    inFiveHourCooldown,
    cooldownUntil,
    lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
    fiveHourRemaining,
    sevenDayRemaining,
    sevenDayResetAt,
    weeklySurplusScore: sevenDayRemaining - fiveHourRemaining / weeklyToFiveHourLimitRatio,
    manualResetScore: manualResetCount > 0
      ? manualResetCount * (sevenDayResetDistance / weeklyQuotaWindowMs) * 100
      : 0
  };
}

function hasExhaustedWorkspaceCreditPool(quota: Record<string, unknown> | null) {
  const reachedType = readStringField(quota, ["rateLimitReachedType", "rate_limit_reached_type"])
    ?.toLowerCase();
  const spendControlReached = readBooleanField(quota, ["spendControlReached", "spend_control_reached"]);

  // `credits.hasCredits === false` only means that the account has no extra
  // flexible credits. Included 5-hour/weekly allowance can still be healthy,
  // so filtering Team accounts on that field makes load balancing reject an
  // account that a manual selection can use. Only explicit spend/credit limit
  // signals make the account unavailable here.
  return spendControlReached === true || Boolean(
    reachedType && /credit|spend/.test(reachedType)
  );
}

function compareLoadBalanceScores(
  first: { account: AccountRecord; score: AccountLoadBalanceScore },
  second: { account: AccountRecord; score: AccountLoadBalanceScore }
) {
  if (first.score.inFiveHourCooldown !== second.score.inFiveHourCooldown) {
    return first.score.inFiveHourCooldown ? 1 : -1;
  }
  if (first.score.inFiveHourCooldown && first.score.cooldownUntil !== second.score.cooldownUntil) {
    return first.score.cooldownUntil - second.score.cooldownUntil;
  }
  if (Math.abs(first.score.weeklySurplusScore - second.score.weeklySurplusScore) > 0.5) {
    return second.score.weeklySurplusScore - first.score.weeklySurplusScore;
  }
  if (Math.abs(first.score.manualResetScore - second.score.manualResetScore) > 0.5) {
    return second.score.manualResetScore - first.score.manualResetScore;
  }
  if (first.score.fiveHourRemaining !== second.score.fiveHourRemaining) {
    return second.score.fiveHourRemaining - first.score.fiveHourRemaining;
  }
  if (first.score.sevenDayRemaining !== second.score.sevenDayRemaining) {
    return second.score.sevenDayRemaining - first.score.sevenDayRemaining;
  }
  return first.account.id.localeCompare(second.account.id);
}

function pickFiveHourWindow(primary: QuotaWindow | null, secondary: QuotaWindow | null) {
  return [primary, secondary].find((window) => {
    const duration = window?.windowDurationMins;
    return typeof duration === "number" && duration > 0 && duration <= 6 * 60;
  }) ?? null;
}

function pickSevenDayWindow(primary: QuotaWindow | null, secondary: QuotaWindow | null) {
  return [primary, secondary].find((window) => {
    const duration = window?.windowDurationMins;
    return typeof duration === "number" && duration >= 6 * 24 * 60;
  }) ?? null;
}

function readQuotaWindow(value: unknown): QuotaWindow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const window = value as Record<string, unknown>;
  const usedPercent = readNumberField(window, ["usedPercent", "used_percent"]);
  if (usedPercent === null) {
    return null;
  }

  const resetRaw = readNumberField(window, ["resetsAt", "resets_at"]) ?? Number.MAX_SAFE_INTEGER;
  return {
    remaining: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetAt: resetRaw > 10_000_000_000 ? resetRaw : resetRaw * 1000,
    windowDurationMins: readNumberField(window, [
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes"
    ]),
    manualResetCount: readNumberField(window, [
      "manualResetCount",
      "manual_reset_count",
      "manualResets",
      "manual_resets",
      "manualResetsRemaining",
      "manual_resets_remaining"
    ])
  };
}

function readNumberField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function readBooleanField(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function readStringField(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function parseAccountTimestampMs(value: string) {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  const normalized = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})$/,
    "$1T$2$3:00"
  );
  return Date.parse(normalized);
}
