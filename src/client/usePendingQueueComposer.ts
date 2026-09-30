import { useEffect, useRef, useState } from "react";
import type { MessageAttachment } from "./appTypes";

type Edit = {
  sessionId: string;
  turnId: string;
  editToken: string;
  value: string;
  attachments: MessageAttachment[];
  held: boolean;
};
const key = (sessionId: string) => `threadex.pending-composer-edit:${sessionId}`;
function readEdit(sessionId: string | null): Edit | null {
  if (!sessionId) return null;
  try {
    const edit = JSON.parse(localStorage.getItem(key(sessionId)) ?? "null");
    return edit?.sessionId === sessionId && typeof edit.turnId === "string" &&
      typeof edit.editToken === "string" && typeof edit.value === "string" && Array.isArray(edit.attachments)
      ? edit : null;
  } catch { return null; }
}

// The edit has its own durable draft. The ordinary composer draft, links,
// attachments and execution settings are never displaced or submitted by Edit.
export function usePendingQueueComposer(sessionId: string | null, onUpdated: (sessionId: string, turnId: string) => void,
  onError: (message: string) => void) {
  const [record, setRecord] = useState<Edit | null>(() => readEdit(sessionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const edit = record?.sessionId === sessionId ? record : readEdit(sessionId);
  useEffect(() => { setRecord(readEdit(sessionId)); setError(""); }, [sessionId]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (sessionId && event.key === key(sessionId)) setRecord(readEdit(sessionId));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [sessionId]);

  function store(next: Edit) {
    // Persist before acquiring a server hold, so reload/navigation can recover it.
    localStorage.setItem(key(next.sessionId), JSON.stringify(next));
    if (activeSession.current === next.sessionId) setRecord(next);
  }
  async function request(edit: Edit, body: object, save = false) {
    const response = await fetch(`/api/pending-turns/${encodeURIComponent(edit.turnId)}${save ? "" : "/edit"}`, {
      method: save ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: edit.sessionId, editToken: edit.editToken, ...body })
    });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload.error || `Edit failed (${response.status})`),
      { rejected: response.status >= 400 && response.status < 500 });
    return payload;
  }
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(message); onError(message);
    }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function acquire(next: Edit) {
    store(next);
    let payload;
    try { payload = await request(next, {}); }
    catch (error) {
      if (!next.held && error instanceof Error && "rejected" in error && error.rejected) {
        localStorage.removeItem(key(next.sessionId));
        if (activeSession.current === next.sessionId) setRecord(null);
      }
      throw error;
    }
    store({ ...next, held: true, value: next.held ? next.value : payload.message ?? next.value,
      attachments: payload.attachments });
    onUpdated(next.sessionId, next.turnId);
  }
  function begin(turnId: string, value: string, attachments: MessageAttachment[]) {
    if (!sessionId || edit) return;
    return run(() => acquire({ sessionId, turnId, value, attachments,
      editToken: crypto.randomUUID(), held: false }));
  }
  function change(value: string) {
    if (!edit || busy) return;
    try { store({ ...edit, value }); }
    catch {
      const message = "Draft could not be saved. Free browser storage before continuing.";
      setError(message); onError(message);
    }
  }
  function finish(cancel = false) {
    if (!edit || (!cancel && (!edit.held || !edit.value.trim()))) return;
    return run(async () => {
      await request(edit, cancel ? { cancel: true } : { message: edit.value }, !cancel);
      localStorage.removeItem(key(edit.sessionId));
      if (activeSession.current === edit.sessionId) setRecord(null);
      onUpdated(edit.sessionId, edit.turnId);
    });
  }
  return { edit, busy, error, begin, change, submit: () => finish(), cancel: () => finish(true),
    retry: () => edit && run(() => acquire(edit)) };
}
