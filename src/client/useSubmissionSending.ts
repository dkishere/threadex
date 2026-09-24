import { useEffect, useState } from "react";
import { isSubmissionSending, PENDING_SUBMISSIONS_CHANGED } from "./pendingSubmissions";

export function useSubmissionSending(sessionId: string | null) {
    const [, refresh] = useState(0);
    useEffect(() => {
        const changed = () => refresh(version => version + 1);
        window.addEventListener(PENDING_SUBMISSIONS_CHANGED, changed);
        changed();
        return () => window.removeEventListener(PENDING_SUBMISSIONS_CHANGED, changed);
    }, []);
    return isSubmissionSending(sessionId);
}
