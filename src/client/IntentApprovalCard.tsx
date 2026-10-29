import { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { intentDecision, intentRequest, type IntentDecision } from "../intentApproval";
import type { LiveItem } from "./appTypes";
import "./styles/userInputRequest.css";
import "./styles/intentApproval.css";

export function IntentApprovalCard({ item, onDecisionSubmitted }: {
  item: Extract<LiveItem, { itemType: "approval" }>;
  onDecisionSubmitted?: (id: string) => void;
}) {
  const request = intentRequest(item.params);
  const [selected, setSelected] = useState(() => request?.actions ?? []);
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState(false);
  const [localDecision, setLocalDecision] = useState<IntentDecision | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const saved = intentDecision(item.decision, item.params) ?? localDecision;
  const expired = item.status === "expired" && !localDecision;
  const resolved = item.status === "resolved" || !!localDecision || stale || expired;
  const approved = saved && saved !== "cancel" && saved.outcome === "approved" ? saved : null;
  async function submit(decision: IntentDecision) {
    if (busy || resolved) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(item.approvalId)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision })
      });
      if (!response.ok) {
        if (response.status === 409) { setStale(true); onDecisionSubmitted?.(item.approvalId); }
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Could not submit the decision.");
      }
      setLocalDecision(decision); onDecisionSubmitted?.(item.approvalId);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section className="user-input-card intent-approval-card" data-approval-id={item.approvalId} data-resolved={resolved} aria-label="Intent approval">
    <header><ShieldCheck size={18} /><strong>Approve intention</strong><span className="user-input-status">{resolved ? approved ? "Approved" : saved && saved !== "cancel" ? "Declined" : expired ? "Expired" : "Closed" : "Waiting for you"}</span></header>
    {request ? <>
      <h3>{request.title}</h3>
      <dl><dt>Scope</dt><dd>{request.scope}</dd><dt>Not included</dt><dd>{request.exclusions}</dd><dt>Consequences</dt><dd>{request.consequences}</dd><dt>Valid until</dt><dd>This turn ends</dd></dl>
      <fieldset disabled={busy || resolved}><legend>Actions you authorize</legend>
        {request.actions.map(action => <label className="user-input-option" key={action}>
          <input type="checkbox" checked={resolved ? !!approved?.actions.includes(action) : selected.includes(action)}
            onChange={e => setSelected(current => e.target.checked ? [...current, action] : current.filter(a => a !== action))} />
          <span>{action}</span>
        </label>)}
        <label className="intent-constraints">Additional restrictions
          <textarea value={resolved ? approved?.constraints ?? "" : constraints} maxLength={2000}
            placeholder="Optional: narrow the scope further" onChange={e => setConstraints(e.target.value)} />
        </label>
      </fieldset>
      {!resolved && <footer><span>Uncheck actions to narrow approval.</span>
        <button type="button" disabled={busy} onClick={() => void submit({ outcome: "declined" })}>Decline</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => void submit({ outcome: "approved", actions: selected, constraints })}>
          {busy && <Loader2 size={15} className="spin" />} {busy ? "Sending…" : "Approve selected scope"}
        </button>
      </footer>}
    </> : <p role="alert">This intention could not be displayed.</p>}
    {(error || item.error) && <p role="alert">{error || item.error}</p>}
  </section>;
}
