import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeSubmissionEvent, readPendingSubmissions, reconcilePendingSubmissions, savePendingSubmission, recordSubmissionError, unconfirmedPrompts, type PendingSubmission } from "./pendingSubmissions";
import { mockSubmissionStorage } from "./pendingSubmissions.testSupport";

const entry: PendingSubmission = {
    id: "client-turn", turnId: "client-turn", sessionId: "session", workspaceId: "workspace",
    kind: "prompt", createdAt: "2026-09-23T12:00:00Z", message: "Keep my prompt",
    attachments: [{ name: "image.png", data: "data:image/png;base64,abc" }], settings: { forcePlan: true }
};

test("full input survives a fresh read, pending/error/done events, and a different turn's ack", t => {
    mockSubmissionStorage(t);
    savePendingSubmission(entry);
    for (const type of ["pending", "error", "done"]) {
        acknowledgeSubmissionEvent({ type, data: { sessionId: "session", turnId: entry.turnId, ok: true } });
    }
    acknowledgeSubmissionEvent({ type: "session", data: { sessionId: "session", turnId: "other", message: "Prompt runner started" } });
    assert.deepEqual(readPendingSubmissions(), [entry]);
});

test("session allocation and queue ack retain the backup; mapped runner start removes only its backup", t => {
    mockSubmissionStorage(t);
    savePendingSubmission(entry);
    savePendingSubmission({ ...entry, id: "other", turnId: "other" });
    acknowledgeSubmissionEvent({ type: "session", data: { sessionId: "resolved", turnId: "resolved-turn", message: "Queued behind the active turn" } }, entry.id);
    assert.equal(readPendingSubmissions().length, 2);
    acknowledgeSubmissionEvent({ type: "session", data: { sessionId: "resolved", turnId: "resolved-turn", message: "Prompt runner started" } });
    assert.deepEqual(readPendingSubmissions().map(e => e.id), ["other"]);
});

test("a fresh snapshot reconciles a missed start ack but preserves unstarted input and steering", t => {
    mockSubmissionStorage(t);
    savePendingSubmission(entry);
    savePendingSubmission({ ...entry, id: "steer", kind: "steer" });
    reconcilePendingSubmissions("other-session", [{ id: entry.id, status: "done" }]);
    reconcilePendingSubmissions("session", [{ id: entry.id, status: "running" }]);
    assert.equal(readPendingSubmissions().length, 2);
    reconcilePendingSubmissions("session", [{ id: entry.id, status: "running", runnerPid: 123 }]);
    assert.deepEqual(readPendingSubmissions().map(e => e.id), ["steer"]);
});

test("completed result confirms delivery when start was missed", t => {
    mockSubmissionStorage(t);
    savePendingSubmission(entry);
    acknowledgeSubmissionEvent({ type: "result", data: { sessionId: "session", turnId: entry.id } });
    assert.equal(readPendingSubmissions().length, 0);
});

test("reload exposes only this session's prompts missing from the server, retaining failure evidence", t => {
    mockSubmissionStorage(t);
    savePendingSubmission(entry);
    savePendingSubmission({ ...entry, id: "stored", turnId: "stored" });
    savePendingSubmission({ ...entry, id: "elsewhere", sessionId: "another" });
    savePendingSubmission({ ...entry, id: "steer", kind: "steer" });
    recordSubmissionError(entry.id, "API returned 503");
    const recovered = unconfirmedPrompts("session", ["stored"]);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].message, entry.message);
    assert.deepEqual(recovered[0].attachments, entry.attachments);
    assert.equal(recovered[0].lastError, "API returned 503");
    acknowledgeSubmissionEvent({ type: "result", data: { sessionId: "session", turnId: entry.id } });
    recordSubmissionError(entry.id, "late stream failure");
    assert.deepEqual(unconfirmedPrompts("session", ["stored"]), []);
});
