import { useEffect, useState } from "react";
import { Hourglass, Loader2, TriangleAlert } from "lucide-react";
import {
  describeSubagentActivityEvent,
  formatElapsed,
  presentSubagentActivity,
  useSubagentActivity,
  type SubagentActivityPresentation,
  type SubagentActivityView
} from "./subagentActivityStore";

const CLOCK_TICK_MS = 15_000;
const VISIBLE_EVENTS = 8;

/** Live `subagent_activity` view and liveness for a card; re-evaluates on a slow clock only while running. */
export function useSubagentActivityPresentation(agentIds: readonly string[]) {
  const view = useSubagentActivity(agentIds);
  const [now, setNow] = useState(() => Date.now());
  const running = view?.state === "running";
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, view?.lastSignalAt]);
  return view ? { view, presentation: presentSubagentActivity(view, Math.max(now, Date.parse(view.lastSignalAt))) } : null;
}

/** Inline header summary: icon plus the latest activity line, ellipsized. */
export function SubagentActivityHeadline({ presentation }: { presentation: SubagentActivityPresentation }) {
  const text = presentation.detail ?? presentation.liveness;
  if (!text && presentation.tone === "running") return null;
  const icon = presentation.tone === "stalled" ? <TriangleAlert aria-hidden="true" />
    : presentation.tone === "waiting" ? <Hourglass aria-hidden="true" />
    : presentation.tone === "running" ? <Loader2 className="spin" aria-hidden="true" /> : null;
  return (
    <span className="subagent-activity-headline" data-tone={presentation.tone} title={[presentation.detail, presentation.liveness].filter(Boolean).join("\n")}>
      {icon}
      {text && <span>{text}</span>}
    </span>
  );
}

function eventTime(at: string) {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? "" : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Body section: liveness, counters and the most recent activity lines. */
export function SubagentActivityPanel({ view, presentation }: { view: SubagentActivityView; presentation: SubagentActivityPresentation }) {
  const lines: Array<{ key: string; at: string; text: string }> = [];
  for (const event of view.events) {
    const text = describeSubagentActivityEvent(event);
    // Repeated waiting signals or identical progress lines add nothing.
    if (lines.at(-1)?.text === text) continue;
    lines.push({ key: `${event.seq}`, at: event.at, text });
  }
  const visible = lines.slice(-VISIBLE_EVENTS);
  const heartbeat = view.heartbeat;
  const latestProgress = view.events.filter((event) => event.toolUses !== undefined || event.totalTokens !== undefined).at(-1);
  const stats = [
    heartbeat?.elapsedMs !== undefined ? `Running ${formatElapsed(heartbeat.elapsedMs)}` : "",
    latestProgress?.toolUses !== undefined ? `${latestProgress.toolUses} tool uses` : "",
    latestProgress?.totalTokens !== undefined ? `${latestProgress.totalTokens.toLocaleString()} tokens` : ""
  ].filter(Boolean);
  return (
    <section className="subagent-activity" data-tone={presentation.tone} aria-label="Subagent activity">
      <div className="subagent-activity-status">
        <strong>Activity</strong>
        {presentation.liveness && <span>{presentation.liveness}</span>}
        {stats.map((stat) => <span key={stat}>{stat}</span>)}
      </div>
      {presentation.tone === "stalled" && (
        <p className="subagent-activity-warning" role="status">
          The runner has stopped reporting progress for this agent. It may be stuck; you can stop the turn if it does not recover.
        </p>
      )}
      {visible.length > 0 ? (
        <ol className="subagent-activity-events">
          {lines.length > visible.length && <li className="subagent-activity-more">{lines.length - visible.length} earlier updates</li>}
          {visible.map((line) => (
            <li key={line.key}>
              <time dateTime={line.at}>{eventTime(line.at)}</time>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <span className="subagent-activity-empty">No activity reported yet.</span>
      )}
    </section>
  );
}
