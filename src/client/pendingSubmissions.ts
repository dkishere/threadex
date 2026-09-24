const PREFIX = "threadex.pending-submission.v1:";
export const PENDING_SUBMISSIONS_CHANGED = "threadex-pending-submissions-changed";
const sendingSubmissions = new Map<string, string | null>();

export function isSubmissionSending(sessionId: string | null) {
    return [...sendingSubmissions.values()].includes(sessionId);
}

export function beginSubmission(id: string, sessionId: string | null) {
    sendingSubmissions.set(id, sessionId);
    changed();
}

// Delivery failure releases the composer while retaining the durable backup.
export function finishSubmission(id: string) {
    if (sendingSubmissions.delete(id)) changed();
}

export type PendingSubmission = {
    id: string;
    sessionId: string;
    turnId: string;
    workspaceId: string | null;
    kind: "prompt" | "steer";
    createdAt: string;
    message: string;
    attachments: unknown[];
    settings: Record<string, unknown>;
};

function changed() {
    window.dispatchEvent(new Event(PENDING_SUBMISSIONS_CHANGED));
}

// One key per submission avoids overwriting another tab's pending input.
// Write synchronously, before clearing the composer or removing a queue item.
export function savePendingSubmission(submission: PendingSubmission) {
    window.localStorage.setItem(PREFIX + submission.id, JSON.stringify(submission));
    changed();
}

export function readPendingSubmissions(): PendingSubmission[] {
    const entries: PendingSubmission[] = [];
    try {
        for (let index = 0; index < window.localStorage.length; index++) {
            const key = window.localStorage.key(index);
            if (!key?.startsWith(PREFIX)) continue;
            try {
                const entry = JSON.parse(window.localStorage.getItem(key) ?? "null");
                if (entry && typeof entry.id === "string" && typeof entry.sessionId === "string" &&
                    typeof entry.turnId === "string" && typeof entry.createdAt === "string" &&
                    (entry.kind === "prompt" || entry.kind === "steer") &&
                    entry.settings && typeof entry.settings === "object" &&
                    typeof entry.message === "string" && Array.isArray(entry.attachments)) entries.push(entry);
            } catch { /* Keep a damaged entry; never discard other submissions. */ }
        }
    } catch { /* Storage can be disabled by the browser. */ }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function removePendingSubmission(id: string) {
    finishSubmission(id);
    try {
        window.localStorage.removeItem(PREFIX + id);
        changed();
    } catch { /* Retain the backup if storage becomes unavailable. */ }
}

const STARTED_MESSAGES = new Set([
    "Prompt runner started", "Codex session ready", "Retrying pending Codex turn",
    "Reconnected to prompt runner", "Reconnected to pending prompt runner", "Loaded prompt runner log"
]);

export function acknowledgeSubmissionEvent(event: { type: string; data: any }, originalTurnId?: string) {
    if (event.type !== "session" && event.type !== "result") return;
    const { sessionId, turnId } = event.data ?? {};
    if (!sessionId || !turnId) return;
    for (const entry of readPendingSubmissions()) {
        if (entry.kind !== "prompt" ||
            !((entry.turnId === turnId && entry.sessionId === sessionId) || entry.id === originalTurnId)) continue;
        if (event.type === "result" || STARTED_MESSAGES.has(event.data.message)) {
            removePendingSubmission(entry.id);
        } else if (entry.sessionId !== sessionId || entry.turnId !== turnId) {
            // A session/queued event can remap IDs without acknowledging a start.
            try { savePendingSubmission({ ...entry, sessionId, turnId }); } catch { /* Keep original. */ }
        }
    }
}

export function reconcilePendingSubmissions(sessionId: string, turns: Array<{
    id: string; status: string; runnerStarted?: string | null; runnerPid?: number | null;
}>) {
    for (const entry of readPendingSubmissions()) {
        if (entry.sessionId !== sessionId || entry.kind !== "prompt") continue;
        const turn = turns.find(turn => turn.id === entry.turnId);
        if (turn && (turn.status === "done" || turn.runnerStarted || turn.runnerPid)) {
            removePendingSubmission(entry.id);
        }
    }
}
