import { useEffect, useState, type FormEvent } from "react";

const endpoint = "/api/settings/global-instructions";

export function GlobalInstructionsSettingsPanel() {
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load global instructions.");
      if (!controller.signal.aborted) {
        setInstructions(body.instructions);
        setSavedInstructions(body.instructions);
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load global instructions.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save global instructions.");
      setInstructions(body.instructions);
      setSavedInstructions(body.instructions);
      setNotice(body.instructions ? "Saved. These instructions apply from the next turn." : "Global instructions cleared.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save global instructions.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-content global-instructions-settings" role="tabpanel" aria-label="Global instructions">
    <div className="settings-section-heading">
      <div><h2>Global instructions</h2><p>Set reusable guidance for Codex in every Threadex workspace.</p></div>
    </div>
    <form className="settings-card global-instructions-card" onSubmit={event => void save(event)}>
      <label htmlFor="global-agent-instructions">AGENTS.md style instructions</label>
      <p>Added to each new turn, including turns in existing sessions. Project AGENTS.md files still apply. Clear the text and save to remove this guidance.</p>
      <textarea id="global-agent-instructions" value={instructions} onChange={event => { setInstructions(event.target.value); setNotice(""); }}
        placeholder="Write your working preferences and instructions here…" spellCheck={false} disabled={loading || saving} />
      <div className="global-instructions-actions">
        <span>{new TextEncoder().encode(instructions).length.toLocaleString()} / 32,768 bytes</span>
        <button className="secondary primary" type="submit" disabled={loading || saving || instructions === savedInstructions || new TextEncoder().encode(instructions).length > 32768}>
          {saving ? "Saving…" : "Save instructions"}
        </button>
      </div>
      {loading ? <p role="status">Loading instructions…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  </div>;
}
