// @ts-nocheck
import { isAccountLoginRequiredMessage } from "../codexAuth";
import { formatTimestamp, formatTimestampShort } from "./formatters";

export function accountIdentityLabel(account) {
    return account.name || account.email || account.externalAccountId || account.id;
}

export function formatAccountOptionLabel(account) {
    return `${accountIdentityLabel(account)} - ${formatAccountQuotaPair(account)}`;
}

export function formatAccountSelectLabel(account) {
    return accountNeedsLogin(account) ? `${accountIdentityLabel(account)} - needs login` : formatAccountOptionLabel(account);
}

export function accountNeedsLogin(account) {
    return !account.hasAuth || isAccountLoginRequiredMessage(account.quotaError);
}

function normalizePlanType(value) {
    const normalized = typeof value === "string"
        ? value.trim().toLowerCase().replace(/[\s_-]+/g, "")
        : "";
    return normalized.endsWith("prolite") ? "prolite" : normalized;
}

export function formatAccountTier(account) {
    const quota = account?.quotaSnapshot && typeof account.quotaSnapshot === "object"
        ? account.quotaSnapshot
        : null;
    const rawTier = typeof quota?.planType === "string"
        ? quota.planType.trim()
        : typeof quota?.plan_type === "string"
            ? quota.plan_type.trim()
            : "";
    if (!rawTier)
        return null;
    const normalized = rawTier.toLowerCase().replace(/[\s_-]+/g, "");
    const knownTiers = {
        free: "Free",
        plus: "Plus",
        pro: "Pro",
        prolite: "Pro Lite",
        team: "Team",
        business: "Business",
        enterprise: "Enterprise",
        edu: "Edu"
    };
    return knownTiers[normalized] ?? rawTier;
}

export function formatAccountQuotaPair(account) {
    const windows = quotaWindowsByDuration(account);
    const parts = [
        windows.fiveHour ? `5hr ${formatQuotaPercent(windows.fiveHour)}` : null,
        windows.weekly ? `W ${formatQuotaPercent(windows.weekly)}` : null
    ].filter((part) => part !== null);
    return parts.join(" ") || "Usage unknown";
}

export function formatLoadBalanceAccountLabel(activeAccount, accounts) {
    const candidates = Array.isArray(accounts) ? accounts : [];
    const activeCandidate = candidates.find((account) => account.id === activeAccount?.id) ?? null;
    const fiveHourPercent = combinedQuotaPercent(candidates, "fiveHour");
    const weeklyPercent = combinedQuotaPercent(candidates, "weekly");
    const quotaLabel = [
        fiveHourPercent === null ? null : `5hr ${Math.round(fiveHourPercent)}%`,
        weeklyPercent === null ? null : `W ${Math.round(weeklyPercent)}%`
    ].filter((part) => part !== null).join(" ");
    if (!activeCandidate) {
        if (quotaLabel) {
            return `LB: ${quotaLabel}`;
        }
        return candidates.length === 0
            ? "LB: No accounts"
            : `LB: ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}`;
    }
    return `LB: ${accountIdentityLabel(activeCandidate)}${quotaLabel ? ` ${quotaLabel}` : " ?%"}`;
}

export function combinedQuotaPercent(accounts, key) {
    const accountWindows = accounts.map((account) => ({
        account,
        window: quotaWindowsByDuration(account)[key]
    }));
    if (key === "fiveHour" && accountWindows.some(({ window }) => window === null)) {
        return null;
    }
    const windows = accountWindows.filter(({ window }) => window !== null);
    if (windows.length === 0) {
        return null;
    }
    const totalCapacity = windows.reduce((sum, { account }) => sum + loadBalanceQuotaWeight(account), 0);
    if (totalCapacity <= 0) {
        return null;
    }
    const weightedRemaining = windows.reduce((sum, { account, window }) => sum + window.remaining * loadBalanceQuotaWeight(account), 0);
    return weightedRemaining / totalCapacity;
}

function loadBalanceQuotaWeight(account) {
    const quota = account.quotaSnapshot && typeof account.quotaSnapshot === "object"
        ? account.quotaSnapshot
        : null;
    const rawPlanType = typeof quota?.planType === "string"
        ? quota.planType.trim().toLowerCase()
        : typeof quota?.plan_type === "string"
            ? quota.plan_type.trim().toLowerCase()
            : "";
    const planType = normalizePlanType(rawPlanType);
    if (["team", "plus"].includes(planType)) {
        return 1;
    }
    if (planType === "prolite") {
        return 5;
    }
    if (planType === "pro") {
        return 20;
    }
    return 1;
}

export function formatQuotaPercent(window) {
    return window ? `${Math.round(window.remaining)}%` : "?%";
}

export function formatQuotaRemaining(account) {
    const windows = quotaWindows(account);
    if (windows.length === 0) {
        return account.quotaError ? "Error" : "Unknown";
    }
    return `${Math.round(Math.min(...windows.map((window) => window.remaining)))}%`;
}

export function formatQuotaStatus(account, activeAccountId) {
    if (account.quotaError) {
        return quotaWindows(account).length > 0 ? "Stale" : "Error";
    }
    return account.id === activeAccountId ? "Active" : "Ready";
}

export function accountResetCredits(account) {
    const quota = account.quotaSnapshot && typeof account.quotaSnapshot === "object"
        ? account.quotaSnapshot
        : null;
    const rawSummary = quota?.rateLimitResetCredits;
    const summary = rawSummary && typeof rawSummary === "object" ? rawSummary : null;
    const availableCount = summary ? readNumberField(summary, ["availableCount", "available_count"]) ?? 0 : 0;
    const credits = Array.isArray(summary?.credits)
        ? summary.credits.flatMap((value) => {
            if (!value || typeof value !== "object")
                return [];
            const credit = value;
            const id = typeof credit.id === "string" ? credit.id : "";
            if (!id)
                return [];
            return [{
                    id,
                    status: typeof credit.status === "string" ? credit.status : "unknown",
                    expiresAt: readNumberField(credit, ["expiresAt", "expires_at"])
                }];
        })
        : null;
    return { availableCount, credits };
}

export function earliestExpiringResetCredit(credits) {
    const available = credits?.filter((credit) => credit.status === "available") ?? [];
    return available.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
}

export function formatResetCreditExpiry(credit, availableCount) {
    if (availableCount <= 0)
        return "—";
    if (!credit)
        return "Details unavailable";
    if (credit.expiresAt === null)
        return "No expiry";
    const milliseconds = credit.expiresAt > 10_000_000_000 ? credit.expiresAt : credit.expiresAt * 1000;
    return formatTimestamp(new Date(milliseconds).toISOString());
}

export function resetOutcomeLabel(outcome) {
    if (outcome === "reset")
        return "Rate limit reset successfully";
    if (outcome === "nothingToReset")
        return "Nothing currently needs resetting";
    if (outcome === "noCredit")
        return "No reset credit available";
    if (outcome === "alreadyRedeemed")
        return "That reset was already used";
    return "Reset request completed";
}

export function formatQuotaWindowReset(window, format = "relative", now = Date.now()) {
    const resetAt = window?.resetAt;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
        return "Unknown";
    }
    const resetDate = new Date(resetAt);
    if (Number.isNaN(resetDate.getTime())) {
        return "Unknown";
    }
    if (format === "dateTime") {
        return formatTimestamp(resetDate.toISOString());
    }
    const remainingMinutes = Math.ceil((resetAt - now) / 60_000);
    if (remainingMinutes <= 0) {
        return "now";
    }
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    if (hours === 0) {
        return `${minutes}m`;
    }
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatQuotaReset(account) {
    const windows = quotaWindows(account);
    if (windows.length === 0) {
        return account.quotaUpdatedAt ? formatTimestampShort(account.quotaUpdatedAt) : "Unknown";
    }
    const resetAt = Math.min(...windows.map((window) => window.resetAt));
    if (!Number.isFinite(resetAt)) {
        return "Unknown";
    }
    return formatTimestampShort(new Date(resetAt).toISOString());
}

export function quotaWindowPair(account) {
    const quota = account.quotaSnapshot && typeof account.quotaSnapshot === "object"
        ? account.quotaSnapshot
        : null;
    return {
        primary: readQuotaWindow(quota?.primary),
        secondary: readQuotaWindow(quota?.secondary)
    };
}

export function quotaWindows(account) {
    const windows = quotaWindowPair(account);
    return [windows.primary, windows.secondary].filter((window) => window !== null);
}

export function quotaWindowsByDuration(account) {
    const windows = quotaWindows(account);
    return {
        fiveHour: windows.find((window) => isFiveHourQuotaWindow(window)) ?? null,
        weekly: windows.find((window) => isWeeklyQuotaWindow(window)) ?? null
    };
}

export function isFiveHourQuotaWindow(window) {
    return typeof window.windowDurationMins === "number"
        && window.windowDurationMins > 0
        && window.windowDurationMins <= 6 * 60;
}

export function isWeeklyQuotaWindow(window) {
    return typeof window.windowDurationMins === "number"
        && window.windowDurationMins >= 6 * 24 * 60;
}

export function readQuotaWindow(value) {
    if (!value || typeof value !== "object") {
        return null;
    }
    const window = value;
    const usedPercent = typeof window.usedPercent === "number" ? window.usedPercent : null;
    if (usedPercent === null) {
        return null;
    }
    const resetRaw = typeof window.resetsAt === "number" ? window.resetsAt : Number.MAX_SAFE_INTEGER;
    return {
        remaining: Math.max(0, Math.min(100, 100 - usedPercent)),
        resetAt: resetRaw > 10_000_000_000 ? resetRaw : resetRaw * 1000,
        windowDurationMins: readNumberField(window, ["windowDurationMins", "window_duration_mins", "windowMinutes", "window_minutes"]),
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

export function readNumberField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}
