import type { CollaborationView } from "../collaboration";

export function ForkedTurns({ sessionId, group, onOpen }: {
  sessionId: string;
  group: CollaborationView | null;
  onOpen: (sessionId: string) => void;
}) {
  const workers = group?.members.filter(member => member.localId !== "main" &&
    (group.mainSessionId === sessionId || member.sourceSessionId === sessionId)) ?? [];
  if (!workers.length) return null;
  return <section className="forked-turns" aria-label="Forked turns">
    <h3>Forked turns <span>{workers.length}</span></h3>
    {workers.map(member => {
      const prompt = group!.messages.find(message => message.to === member.localId && message.kind === "task")?.text ?? member.task;
      const status = group!.activity[member.localId]?.status ?? "creating";
      return <article key={member.sessionId} className="forked-turn" data-session-id={member.sessionId}>
        <div className="forked-turn-heading">
          <button type="button" onClick={() => onOpen(member.sessionId)} aria-label={`Open Concurrent ${member.localId}`}>{member.localId} · Concurrent</button>
          <span>{status}</span>
        </div>
        <details>
          <summary>User prompt</summary>
          <div className="forked-turn-prompt">{prompt}</div>
        </details>
      </article>;
    })}
  </section>;
}
