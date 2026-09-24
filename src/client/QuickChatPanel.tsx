import { Loader2, MessageCircle, Plus, RefreshCw, Send, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { QuickChatSession, QuickChatStatus } from "../quickChat";
import { ComposerFrame, ComposerSurface, ComposerToolbar } from "./ComposerFrame";
import { InlineLinkComposer } from "./InlineLinkComposer";
import { MarkdownContent } from "./MarkdownContent";
import { apiJson } from "./apiClient";
import "./QuickChatPanel.css";

export function QuickChatPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<QuickChatStatus>({ accounts: [], models: [] });
  const [accountId, setAccountId] = useState("");
  const [sessions, setSessions] = useState<QuickChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selected = sessions.find(session => session.id === sessionId && session.accountId === accountId);

  useEffect(() => {
    if (!active || sending) return;
    const controller = new AbortController();
    setLoading(true);
    void apiJson<QuickChatStatus>("/api/quick-chat/status", { signal: controller.signal }).then(body => {
      if (controller.signal.aborted) return;
      setStatus(body);
      setAccountId(current => body.accounts.some(account => account.id === current) ? current : body.accounts[0]?.id ?? "");
      setModel(current => body.models.some(option => option.id === current) ? current : body.models[0]?.id ?? "");
      setError(body.error ?? "");
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, revision]);

  useEffect(() => {
    if (!accountId) { setSessions([]); setSessionId(""); setSessionsLoading(false); return; }
    const controller = new AbortController();
    setSessionsLoading(true);
    setSessions([]);
    setSessionId("");
    void apiJson<{ sessions: QuickChatSession[] }>(`/api/quick-chat/sessions?accountId=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then(body => { if (!controller.signal.aborted) setSessions(body.sessions); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setSessionsLoading(false); });
    return () => controller.abort();
  }, [accountId]);

  useEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active, selected, pending, sending]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending || loading || sessionsLoading || !accountId || !model || selected?.interrupted) return;
    setSending(true);
    setPending(prompt);
    setError("");
    try {
      const body = await apiJson<{ session: QuickChatSession }>("/api/quick-chat/messages", {
        method: "POST", body: { accountId, sessionId: sessionId || null, model, prompt }
      });
      setSessions(current => [body.session, ...current.filter(session => session.id !== body.session.id)]);
      setSessionId(body.session.id);
      setInput(current => current === input ? "" : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send message");
      try {
        const body = await apiJson<{sessions: QuickChatSession[]}>(`/api/quick-chat/sessions?accountId=${encodeURIComponent(accountId)}`, { fresh: true });
        setSessions(body.sessions);
      } catch { /* Retain the send error and draft when the server is unavailable. */ }
    }
    finally { setSending(false); setPending(""); }
  }

  return <aside className="side-chat-panel quick-chat-panel" aria-label="Quick Chat">
    <div className="quick-chat-selectors">
      <label>Account<select aria-label="Quick Chat account" value={accountId} disabled={loading || sending} onChange={event => { setAccountId(event.target.value); setInput(""); }}>
        {!status.accounts.length && <option value="">No connected account</option>}
        {status.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
      </select></label>
      <label>Session<select aria-label="Quick Chat session" value={sessionId} disabled={loading || sessionsLoading || sending || !accountId} onChange={event => { setSessionId(event.target.value); setInput(""); }}>
        <option value="">New chat</option>
        {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select></label>
      <button className="composer-icon" type="button" aria-label="New quick chat" disabled={sending || !accountId} onClick={() => { setSessionId(""); setInput(""); setError(""); }}><Plus /></button>
      <button className="composer-icon" type="button" aria-label="Refresh Quick Chat connection" disabled={sending || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw className={loading ? "spin" : undefined} /></button>
    </div>
    <div ref={scrollRef} className="side-chat-messages messages" aria-live="polite">
      {!selected && !pending && <div className="side-chat-empty"><MessageCircle /><strong>Quick Chat</strong><span>Start a conversation or select a previous session.</span></div>}
      {selected?.messages.map(message => <div key={message.id} className={message.role === "user" ? "side-chat-question" : "side-chat-answer message assistant"}><MarkdownContent>{message.text}</MarkdownContent></div>)}
      {pending && <div className="side-chat-question"><MarkdownContent>{pending}</MarkdownContent></div>}
      {sending && <div className="side-chat-state"><Loader2 className="spin" />Thinking…</div>}
      {selected?.interrupted && <div className="side-chat-error" role="alert">This session was interrupted. Start a new chat to continue.</div>}
      {error && <div className="side-chat-error" role="alert">{error}</div>}
    </div>
    <form className="side-chat-composer" onSubmit={event => void submit(event)}><ComposerFrame>
      <aside className="composer-gears quick-chat-gears" aria-label="ChatGPT model options">
        <div className="composer-gear-radios" role="radiogroup" aria-label="ChatGPT model">
          {status.models.map(option => <label className="composer-gear-radio" key={option.id} data-active={model === option.id ? "true" : undefined} title={option.label} onClick={event => {
            if (sending || loading) return;
            if (event.target instanceof HTMLInputElement) return;
            const editor = event.currentTarget.closest(".composer-layout")?.querySelector(".composer-editor");
            if (!editor?.contains(document.activeElement)) return;
            event.preventDefault();
            setModel(option.id);
          }}>
            <input type="radio" name="quick-chat-model" value={option.id} checked={model === option.id} disabled={sending || loading} onChange={() => setModel(option.id)} /><span>{option.label}</span>
          </label>)}
        </div>
      </aside>
      <ComposerSurface><InlineLinkComposer value={input} links={[]} placeholder="Message ChatGPT…" onChange={setInput} onPasteLink={() => null} onRemoveLink={() => undefined} onOpenLink={() => undefined} onUnhandledPaste={() => undefined} onBlur={() => undefined}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        <ComposerToolbar><span className="composer-fill" /><button type="button" className="composer-icon" aria-label="Clear quick chat draft" disabled={sending || !input} onClick={() => setInput("")}><X /></button>
          <button type="submit" className="send-button" aria-label="Send quick chat" disabled={sending || loading || sessionsLoading || !input.trim() || !accountId || !model || selected?.interrupted}>{sending ? <Loader2 className="spin" /> : <Send />}</button>
        </ComposerToolbar>
      </ComposerSurface>
    </ComposerFrame></form>
  </aside>;
}
