import { useState } from "react";
import type { ActorDialogConclusion, ActorRoom, DomainActor } from "../domainActors";
import { apiJson } from "./apiClient";
import { DomainActorIdentity } from "./DomainActorIdentity";
import { MarkdownContent } from "./MarkdownContent";
import { notifyActorRoomChanged } from "./actorRoomState";
import { ChatMessageActions } from "./ChatMessageActions";

export function ActorConclusionMessages({ workspaceId, actor, conclusions, onRoom, onOpenSession, onReply }: {
  workspaceId: string; actor: DomainActor; conclusions: ActorDialogConclusion[];
  onRoom: (room: ActorRoom) => void; onOpenSession: (sessionId: string) => void;
  onReply: (conclusion: ActorDialogConclusion) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function acknowledge(conclusion: ActorDialogConclusion) {
    if (saving) return;
    setSaving(conclusion.id); setError("");
    try {
      const room = await apiJson<ActorRoom>(`/api/domain-actors/${encodeURIComponent(workspaceId)}/actors/${encodeURIComponent(actor.id)}/conclusions/${encodeURIComponent(conclusion.id)}/ack`,
        { method: "POST", body: {} });
      onRoom(room);
      notifyActorRoomChanged(workspaceId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(null); }
  }
  return <div className="actor-conclusions" aria-live="polite" aria-relevant="additions" aria-label="Reviewed conclusions">
    {conclusions.map(conclusion => <article key={conclusion.id} className="side-chat-bubble actor-conclusion"
      data-conclusion-id={conclusion.id} data-unacknowledged={!conclusion.acknowledgedAt || undefined} aria-label={`${actor.name} conclusion`}>
      <header><DomainActorIdentity actor={actor} detail="Conclusion · Review passed" /></header>
      <div className="side-chat-answer"><MarkdownContent>{conclusion.text}</MarkdownContent></div>
      <ChatMessageActions text={conclusion.text} onReply={() => onReply(conclusion)} replyLabel={`Reply to ${actor.name}`} />
      <div className="actor-conclusion-actions">
        <button type="button" className="secondary" onClick={() => onOpenSession(conclusion.taskSessionId)}>Open task</button>
        {conclusion.acknowledgedAt ? <small>Acknowledged</small> : <button type="button" className="secondary" disabled={saving !== null}
          onClick={() => void acknowledge(conclusion)}>{saving === conclusion.id ? "Acknowledging…" : "Ack"}</button>}
      </div>
    </article>)}
    {error && <p role="alert" className="actor-room-error">Could not acknowledge conclusion. {error} Try Ack again.</p>}
  </div>;
}
