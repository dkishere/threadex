import { useId, useState } from "react";
import { MessageCircle, Check, Loader2 } from "lucide-react";
import { inputQuestions, inputResponse } from "../userInputRequest";
import type { LiveItem } from "./appTypes";
import "./styles/userInputRequest.css";

export function UserInputRequestCard({ item, onDecisionSubmitted }: {
  item: Extract<LiveItem, { itemType: "approval" }>;
  onDecisionSubmitted?: (id: string) => void;
}) {
  const questions = inputQuestions(item.params);
  const instanceId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const resolved = item.status === "resolved" || submitted || stale;
  const saved = inputResponse(item.decision, item.params);
  const response = inputResponse({ answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [values[q.id] ?? ""] }])) }, item.params);
  const blocking = (item.params as { isBlocking?: boolean })?.isBlocking !== false;
  async function submit() {
    if (busy || resolved || !response) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(item.approvalId)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: response })
      });
      if (res.status === 409) { setStale(true); throw new Error("This question is no longer waiting for an answer."); }
      if (!res.ok) throw new Error("Could not send your answer. Please retry.");
      setSubmitted(true); onDecisionSubmitted?.(item.approvalId);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section className="user-input-card" data-resolved={resolved} data-approval-id={item.approvalId} aria-label="Agent questions">
    <header><MessageCircle size={17} /><strong>Your input</strong><span className="user-input-status">{resolved && (saved || submitted) && <Check size={12} />}{resolved ? saved || submitted ? "Answered" : "Closed" : blocking ? "Waiting for you" : "Agent is continuing"}</span></header>
    {questions.map((q, index) => <fieldset key={q.id} disabled={busy || resolved}>
      <legend><small>{index + 1} · {q.header}</small><span>{q.question}</span></legend>
      {resolved ? <div className="user-input-answer"><span className="user-input-answer-label">Your answer</span><p>{q.isSecret ? "••••••••" : saved?.answers[q.id]?.answers.join(", ") || (submitted ? values[q.id] : "No answer submitted")}</p></div> : <>
        {q.options?.map((option, optionIndex) => <label className="user-input-option" key={optionIndex}>
          <input type="radio" name={`${instanceId}-${q.id}`} checked={!custom[q.id] && values[q.id] === option.label}
            onChange={() => { setCustom((v) => ({ ...v, [q.id]: false })); setValues((v) => ({ ...v, [q.id]: option.label })); }} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
        </label>)}
        {q.isOther && !!q.options?.length && <label className="user-input-option"><input type="radio" name={`${instanceId}-${q.id}`} checked={!!custom[q.id]}
          onChange={() => { setCustom((v) => ({ ...v, [q.id]: true })); setValues((v) => ({ ...v, [q.id]: "" })); }} /><span>Write my own answer</span></label>}
        {(!q.options?.length || custom[q.id]) && <input className="user-input-text" type={q.isSecret ? "password" : "text"} aria-label={`Answer: ${q.header}`} placeholder="Your answer…" value={values[q.id] ?? ""}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
          onChange={(event) => setValues((v) => ({ ...v, [q.id]: event.target.value }))} />}
      </>}
    </fieldset>)}
    {!questions.length && <p role="alert">This question could not be displayed.</p>}
    {(error || item.error) && <p role="alert">{error || item.error}</p>}
    {!resolved && <footer><span>Choose or write an answer, then send.</span><button type="button" disabled={busy || !response} onClick={() => void submit()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} {busy ? "Sending…" : "Send answers"}</button></footer>}
  </section>;
}
