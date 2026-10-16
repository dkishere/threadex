import { useEffect, useState } from "react";
import { AlertCircle, Paperclip, RotateCcw, X } from "lucide-react";
import { isSubmissionSending, PENDING_SUBMISSIONS_CHANGED, removePendingSubmission, unconfirmedPrompts, type PendingSubmission } from "./pendingSubmissions";
import "./UnconfirmedPrompts.css";

export function UnconfirmedPrompts({ sessionId, storedTurnIds, busy, running, onRetry }: {
    sessionId: string | null;
    storedTurnIds: string[];
    busy: boolean;
    running: boolean;
    onRetry: (entry: PendingSubmission) => Promise<unknown>;
}) {
    const [, refresh] = useState(0);
    const [error, setError] = useState("");
    useEffect(() => setError(""), [sessionId]);
    useEffect(() => {
        const changed = () => refresh(value => value + 1);
        window.addEventListener(PENDING_SUBMISSIONS_CHANGED, changed);
        window.addEventListener("storage", changed);
        return () => {
            window.removeEventListener(PENDING_SUBMISSIONS_CHANGED, changed);
            window.removeEventListener("storage", changed);
        };
    }, []);
    const entries = unconfirmedPrompts(sessionId, storedTurnIds);
    if (!entries.length || isSubmissionSending(sessionId)) return null;
    return <section className="unconfirmed-prompts" aria-label="Unconfirmed prompts">
        <header className="unconfirmed-prompts-header">
            <AlertCircle aria-hidden="true" />
            <div>
                <strong>Delivery not confirmed <span className="unconfirmed-prompts-count">{entries.length}</span></strong>
                <p>Saved in this browser. {running ? "Retry to queue after the current turn." : "Retry to send, or cancel to discard."}</p>
            </div>
        </header>
        <ul className="unconfirmed-prompts-list">
        {entries.map(entry => <li className="unconfirmed-prompt" key={entry.id}>
            <p className="unconfirmed-prompt-text">{entry.message || "Attachment-only prompt"}</p>
            {entry.attachments.length > 0 && <small className="unconfirmed-prompt-attachments"><Paperclip aria-hidden="true" />{entry.attachments.length} {entry.attachments.length === 1 ? "attachment" : "attachments"} saved</small>}
            {entry.lastError && <p className="unconfirmed-prompt-error" role="alert">{entry.lastError}</p>}
            <div className="unconfirmed-prompt-actions">
            <button className="unconfirmed-prompt-retry" type="button" disabled={busy} title={busy ? "Wait for the current submission or edit to finish" : running ? "Queue this saved prompt after the current turn" : "Send this saved prompt"} onClick={async () => {
                if (isSubmissionSending(sessionId)) return;
                setError("");
                try { await onRetry(entry); }
                catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            }}><RotateCcw aria-hidden="true" />Retry saved prompt</button>
            <button className="unconfirmed-prompt-cancel" type="button" title="Discard this browser's saved copy" onClick={() => {
                setError(removePendingSubmission(entry.id) ? "" : "Could not cancel the saved prompt. Browser storage is unavailable; try again.");
            }}><X aria-hidden="true" />Cancel</button>
            </div>
        </li>)}
        </ul>
        {error && <p className="unconfirmed-prompt-error" role="alert">{error}</p>}
    </section>;
}
