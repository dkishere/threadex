import { ArrowUpRight, ChevronRight, UserPlus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CollaborationView } from "../collaboration";

function MemberMarkdown({ children }: { children: string }) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown></div>;
}

function memberTone(status: string): "running" | "done" | "error" {
  if (/error|fail|stop|interrupt|cancel/i.test(status)) return "error";
  if (/complete|done|success/i.test(status)) return "done";
  return "running";
}

export function ForkedTurns({ sessionId, sourceTurnId, group, onOpen }: {
  sessionId: string;
  sourceTurnId: string;
  group: CollaborationView | null;
  onOpen: (sessionId: string) => void;
}) {
  const workers = group?.members.filter(member => member.localId !== "main" &&
    member.sourceSessionId === sessionId && (member.spawnTurnId ?? member.sourceTurnId) === sourceTurnId) ?? [];
  if (!workers.length) return null;
  return <section className="forked-turns" aria-label="Forked turns" data-source-turn-id={sourceTurnId}>
    {workers.map(member => {
      const prompt = group!.messages.find(message => message.to === member.localId && message.kind === "task")?.text ?? member.task;
      const activity = group!.activity[member.localId];
      const result = group!.results.filter(result => result.localId === member.localId)
        .sort((a, b) => b.created.localeCompare(a.created))[0];
      // A follow-up in flight outranks the previous turn's result.
      const live = ["running", "queued", "waiting"].includes(activity?.status ?? "");
      const status = member.stopped ? "stopped" : live ? activity!.status
        : result?.status ?? activity?.status ?? "creating";
      const tone = memberTone(status);
      return <details key={member.sessionId} className="subagent-event forked-turn" data-session-id={member.sessionId} data-status={tone}>
        <summary className="subagent-event-header">
          <ChevronRight className="command-chevron" aria-hidden="true" />
          <UserPlus aria-hidden="true" />
          <strong>{member.localId} · {member.model}</strong>
          {status === "running" && activity?.progress &&<span className="subagent-activity-headline" data-tone="running"><span>{activity.progress}</span></span>}
          <span className="subagent-event-status">{status.replace(/^./, letter => letter.toUpperCase())}</span>
        </summary>
        <div className="subagent-event-body">
          <div className="subagent-event-meta"><span>Model: {member.model}</span><span>Effort: {member.effort || "not reported"}</span></div>
          <div className="subagent-event-prompt"><span>{member.spawnTurnId ? "Delegated task" : "User prompt"}</span><MemberMarkdown>{prompt}</MemberMarkdown></div>
          {result && <div className="subagent-returned-content">
            <strong>Returned content</strong>
            <MemberMarkdown>{result.summary}</MemberMarkdown>
            {result.changes.length > 0 && <div className="forked-turn-changes"><strong>Changes</strong><ul>{result.changes.map((change, index) =>
              <li key={`${change.path}:${index}`}>{change.kind}: {change.path}{change.movePath ? ` → ${change.movePath}` : ""} (+{change.additions} −{change.deletions})</li>
            )}</ul></div>}
          </div>}
          <button type="button" className="forked-turn-open" onClick={() => onOpen(member.sessionId)} aria-label={`Open Concurrent ${member.localId}`}>
            <ArrowUpRight aria-hidden="true" /> Open member session
          </button>
        </div>
      </details>;
    })}
  </section>;
}
