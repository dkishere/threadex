import { useEffect, useState, type FormEvent } from "react";

type Settings = { apiKeyConfigured: boolean; selectorModel: string };
const endpoint = "/api/settings/auto-model";

export function AutoModelSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Unable to load Auto model settings.");
      const body = await response.json();
      if (!controller.signal.aborted) setSettings(body);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);

  async function save(event?: FormEvent, clear = false) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, clear ? { method: "DELETE" } : {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key.trim() })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save Auto model settings.");
      setSettings(body);
      setKey("");
      setNotice(clear ? "Key removed. Auto uses the original model-upgrade logic." : "Key saved. Auto will use Jev from the next turn.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Auto model settings.");
    } finally { setBusy(false); }
  }

  return <div className="settings-content auto-model-settings" role="tabpanel" aria-label="Auto model">
    <div className="settings-section-heading"><div><h2>Auto model</h2><p>Choose Auto as a gear's model in gearbox configuration to select a model for each turn.</p></div></div>
    <section className="settings-card auto-model-settings-card">
      <h3>TypeSafe Jev</h3>
      <p>Jev selects Luna, Terra, Sol, or Astra and reasoning effort using your prompt and summarized conversation. Long input is truncated before it is sent to TypeSafe.</p>
      <p>Without a key, Auto starts at Luna/high and lets the agent upgrade when needed. If Jev is unavailable, the existing Auto setting is kept.</p>
      <p>This key applies to all workspaces on this Threadex server.</p>
      <form className="account-login-form" onSubmit={event => void save(event)}>
        <label><span>TypeSafe API key</span><input type="password" value={key} autoComplete="new-password" spellCheck={false}
          placeholder={settings?.apiKeyConfigured ? "Key saved — enter a replacement" : "Enter API key"}
          onChange={event => setKey(event.target.value)} disabled={busy || !settings} /></label>
        <p>{settings ? settings.apiKeyConfigured ? "API key configured. Jev routing is enabled for Auto turns." : "No key configured. Auto uses the original upgrade logic." : "Loading settings…"}</p>
        <div className="account-login-actions">
          <button className="secondary primary" type="submit" disabled={busy || !settings || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
          <button className="secondary" type="button" disabled={busy || !settings?.apiKeyConfigured} onClick={() => void save(undefined, true)}>Remove key</button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </div>;
}
