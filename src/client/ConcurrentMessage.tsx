import { ArrowRight, GitPullRequestCreateArrow } from "lucide-react";
import type { ReactNode } from "react";
import "./ConcurrentPanel.css";

export function parseConcurrentMessage(text: string) {
  // Support saved envelopes from before the Concurrent rename.
  const match = /^\[Threadex (?:Concurrent|collaboration) ([^;\n]+); message ([^;\n]+); (\S+) → ([^\]\n]+)\]\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const split = match[5].indexOf("\n\n");
  if (split < 0) return null;
  const reason = match[5].slice(0, split);
  const body = match[5].slice(split + 2);
  const result = /^(\S+) (completed|failed|stopped)\. Session: ([^;\n]+); turn: ([^.\n]+)\.\nConclusion:\n([\s\S]*?)\n\nChange list \(recorded edits\):\n([\s\S]*?)\n\nIntegrate this result using your existing context\./.exec(body);
  return { groupId: match[1], from: match[3], to: match[4], reason, body, result: result ? {
    status: result[2], conclusion: result[5], changes: result[6]
  } : null };
}

export function ConcurrentMessage({ text, renderContent }: { text: string; renderContent: (text: string) => ReactNode }) {
  const message = parseConcurrentMessage(text);
  if (!message) return <>{renderContent(text)}</>;
  return <section className="concurrent-message" aria-label="Concurrent message">
    <header><GitPullRequestCreateArrow aria-hidden="true" /><strong>Concurrent</strong>
      <span className="concurrent-message-route">{message.from}<ArrowRight aria-hidden="true" />{message.to}</span>
      <span className="concurrent-status" data-status={message.result?.status}>{message.result?.status ?? "Message"}</span>
    </header>
    {!message.result && <p className="concurrent-message-reason">{/^User requested (?:parallel collaboration|Concurrent work)$/.test(message.reason) ? "New worker" : message.reason.replace(/^\[[^\]]+\]\s*/, "")}</p>}
    <div className="concurrent-message-content">{renderContent(message.result?.conclusion ?? message.body)}</div>
    {message.result && <details className="concurrent-message-changes"><summary>Change list</summary>{renderContent(message.result.changes)}</details>}
    <details className="concurrent-message-details"><summary>Delivery details</summary><pre>{text}</pre></details>
  </section>;
}
