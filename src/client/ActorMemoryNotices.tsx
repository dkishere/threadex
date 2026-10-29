import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { ActorRoom } from "../domainActors";
import { apiJson } from "./apiClient";
import { notifyActorRoomChanged } from "./actorRoomState";

type MemoryError = ActorRoom["memoryErrors"][number];

/** Undismissed memory maintenance failures; `actorId` limits them to one actor's dialog. */
export function ActorMemoryNotices({ workspaceId, room, actorId, actorName, onRoom }: {
  workspaceId: string; room: ActorRoom; actorId?: string; actorName: (id: string) => string; onRoom: (room: ActorRoom) => void;
}) {
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const notices = room.memoryErrors.filter(entry => !entry.dismissedAt && (!actorId || entry.actorId === actorId));
  if (!notices.length && !error) return null;
  async function dismiss(entry: MemoryError) {
    const key = `${entry.actorId}:${entry.eventId}`;
    if (dismissing) return;
    setDismissing(key); setError("");
    try {
      onRoom(await apiJson<ActorRoom>(`/api/domain-actors/${encodeURIComponent(workspaceId)}/actors/${encodeURIComponent(entry.actorId)}/memory-errors/${encodeURIComponent(entry.eventId)}/dismiss`,
        { method: "POST", body: {} }));
      notifyActorRoomChanged(workspaceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDismissing(null); }
  }
  return <section className="actor-memory-notices" aria-label="Memory update notices">
    {notices.map(entry => {
      const key = `${entry.actorId}:${entry.eventId}`;
      return <div className="actor-memory-notice" key={key}>
        <AlertTriangle aria-hidden="true" />
        <div className="actor-memory-notice-body">
          <strong>{actorName(entry.actorId)} memory was not updated</strong>
          <p>{entry.error}</p>
          <small>{new Date(entry.created).toLocaleString()} · Previous memory retained</small>
        </div>
        <button type="button" className="ghost-icon" disabled={dismissing !== null} onClick={() => void dismiss(entry)}
          aria-label={`Dismiss memory notice for ${actorName(entry.actorId)}`} title="Dismiss"><X aria-hidden="true" /></button>
      </div>;
    })}
    {error && <p role="alert" className="actor-room-error">Could not dismiss notice. {error}</p>}
  </section>;
}
