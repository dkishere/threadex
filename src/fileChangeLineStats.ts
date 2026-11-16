// @ts-nocheck
export function fileChangeLineStats(change) {
    const explicitAdditions = validLineCount(change?.additions);
    const explicitDeletions = validLineCount(change?.deletions);
    if (explicitAdditions !== undefined || explicitDeletions !== undefined) {
        return {
            additions: explicitAdditions ?? 0,
            deletions: explicitDeletions ?? 0
        };
    }
    const diff = firstChangeText(change, ["unifiedDiff", "patch", "diff"]);
    if (diff !== undefined) {
        return lineStatsFromDiff(diff);
    }
    const before = firstChangeText(change, ["before", "beforeText", "beforeContent", "oldContent", "previousContent", "original"]);
    const after = firstChangeText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]);
    if (change?.kind === "add") {
        return { additions: textLineCount(after ?? ""), deletions: 0 };
    }
    if (change?.kind === "delete") {
        return { additions: 0, deletions: textLineCount(before ?? "") };
    }
    if (before !== undefined && after !== undefined) {
        return lineStatsFromTextPair(before, after);
    }
    return { additions: 0, deletions: 0 };

}

function validLineCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

}

function firstChangeText(change, keys) {
    for (const key of keys) {
        if (typeof change?.[key] === "string") {
            return change[key];
        }
    }
    return undefined;

}

function lineStatsFromDiff(diff) {
    let additions = 0;
    let deletions = 0;
    for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) {
            continue;
        }
        if (line.startsWith("+")) {
            additions += 1;
        }
        else if (line.startsWith("-")) {
            deletions += 1;
        }
    }
    return { additions, deletions };

}

function textLineCount(text) {
    if (!text) {
        return 0;
    }
    const lines = text.split(/\r?\n/);
    return /\r?\n$/.test(text) ? Math.max(0, lines.length - 1) : lines.length;

}

function lineStatsFromTextPair(before, after) {
    const beforeLines = before ? before.split(/\r?\n/) : [];
    const afterLines = after ? after.split(/\r?\n/) : [];
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
        prefix += 1;
    }
    let suffix = 0;
    while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) {
        suffix += 1;
    }
    return {
        additions: Math.max(0, afterLines.length - prefix - suffix),
        deletions: Math.max(0, beforeLines.length - prefix - suffix)
    };

}


