import { useEffect, useState } from "react";
import { isSubmissionSending, PENDING_SUBMISSIONS_CHANGED, unconfirmedPrompts, type PendingSubmission } from "./pendingSubmissions";
import "./UnconfirmedPrompts.css";

export function UnconfirmedPrompts({ sessionId, storedTurnIds, busy, onRetry }: {
    sessionId: string | null;
    storedTurnIds: string[];
    busy: boolean;
    onRetry: (entry: PendingSubmission) => Promise<unknown>;
}) {
    const [, refresh] = useState(0);
    const [retrying, setRetrying] = useState(false);
    const [error, setError] = useState("");
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
        <strong>Delivery not confirmed</strong>
        <p>These prompts are saved in this browser. You can retry them here.</p>
        {entries.map(entry => <div key={entry.id}>
            <p className="unconfirmed-prompt-text">{entry.message}</p>
            {entry.attachments.length > 0 && <small>{entry.attachments.length} attachment(s) saved</small>}
            {entry.lastError && <p role="alert">{entry.lastError}</p>}
            <button type="button" disabled={busy || retrying} onClick={async () => {
                setRetrying(true); setError("");
                try { await onRetry(entry); }
                catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                finally { setRetrying(false); }
            }}>Retry saved prompt</button>
        </div>)}
        {error && <p role="alert">{error}</p>}
    </section>;
}
