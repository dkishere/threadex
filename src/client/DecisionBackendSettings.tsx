import { useEffect, useState } from "react";
import { DECISION_BACKENDS, type DecisionPolicies, type ConfiguredDecisionBackend } from "../decisionSettings";

type Settings = { backends: Record<ConfiguredDecisionBackend, { apiKeyConfigured: boolean }>; policies: DecisionPolicies };
const labels = { jev: "Jev", openai: "OpenAI Decisions", llm: "LLM simulation (Codex / Claude Code)" };
const purposes: Record<string, string> = { model_select: "Auto model selection", sh_pick: "Actor selection", claim_tiebreak: "Claim tiebreak" };
export function DecisionBackendSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [keys, setKeys] = useState({ jev: "", openai: "", llm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/decision", { signal: controller.signal, cache: "no-store" }).then(async r => {
      if (!r.ok) throw new Error("Unable to load Decision settings.");
      const body = await r.json();
      if (!controller.signal.aborted) setSettings(body);
    }).catch(() => { if (!controller.signal.aborted) setError("Unable to load Decision settings."); });
    return () => controller.abort();
  }, []);
  async function save(body: unknown, backend?: ConfiguredDecisionBackend) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/settings/decision", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save Decision settings.");
      // Saving a key must not discard unsaved policy edits.
      setSettings(current => backend && current ? { ...result, policies: current.policies } : result);
      if (backend) setKeys(current => ({ ...current, [backend]: "" }));
      setNotice("Decision settings saved. Existing turns keep their recorded decisions.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save Decision settings."); }
    finally { setBusy(false); }
  }
  return <section className="settings-card auto-model-settings-card">
    <h3>Decision backends</h3>
    <p>Shared across this server. Each purpose tries its backends in order and uses the first valid answer. If all fail, Auto keeps its current model.</p>
    <p>LLM simulation uses your workspace’s Codex login or selected Claude Code account and inherits the summarizer and long-input models from Helper models. No API key is needed. Its probabilities are uncalibrated ranking estimates; tune their thresholds separately. Actor policies control actor routing.</p>
    {DECISION_BACKENDS.filter(id => id !== "llm").map(id => <form className="account-login-form" key={id} onSubmit={event => { event.preventDefault(); void save({ backend: id, apiKey: keys[id].trim() }, id); }}>
      <label><span>{labels[id]} API key</span><input type="password" autoComplete="new-password" spellCheck={false} value={keys[id]}
        placeholder={settings?.backends[id].apiKeyConfigured ? "Key configured — enter a replacement" : "Enter API key"}
        disabled={busy || !settings} onChange={event => setKeys(current => ({ ...current, [id]: event.target.value }))} /></label>
      <div className="account-login-actions"><button className="secondary" disabled={busy || !settings || !keys[id].trim()}>Save key</button>
        <button className="secondary" type="button" disabled={busy || !settings?.backends[id].apiKeyConfigured} onClick={() => void save({ backend: id, apiKey: "" }, id)}>Remove key</button></div>
    </form>)}
    {settings && <form className="account-login-form" onSubmit={event => { event.preventDefault(); void save({ policies: settings.policies }); }}>
      {Object.entries(settings.policies).map(([purpose, policy]) => <fieldset key={purpose} disabled={busy}>
        <legend>{purposes[purpose] ?? purpose}</legend>
        <label><span>Backend order</span><select value={policy.order.join(",")} onChange={event => {
          const order = event.target.value.split(",") as ConfiguredDecisionBackend[];
          setSettings({ ...settings, policies: { ...settings.policies, [purpose]: { ...policy, order } } });
        }}>
          {backendOrders().map(order => <option key={order.join(",")} value={order.join(",")}>{order.map(id => labels[id]).join(" → ")}</option>)}
        </select></label>
        {purpose === "model_select" ? <p>Confidence below 0.3 upgrades one model tier. Custom model rules apply below.</p> : DECISION_BACKENDS.map(id => <label key={id}><span>{labels[id]} threshold</span>
          <input type="number" min="0" max="1" step="0.01" required value={policy.threshold[id]} onChange={event => setSettings({ ...settings, policies: { ...settings.policies, [purpose]: { ...policy, threshold: { ...policy.threshold, [id]: event.target.valueAsNumber } } } })} /></label>)}
      </fieldset>)}
      <button className="secondary primary" disabled={busy}>Save backend policies</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
function backendOrders(): ConfiguredDecisionBackend[][] {
  const expand = (prefix: ConfiguredDecisionBackend[], rest: ConfiguredDecisionBackend[]): ConfiguredDecisionBackend[][] => rest.flatMap(id => {
    const next = [...prefix, id];
    return [next, ...expand(next, rest.filter(other => other !== id))];
  });
  return expand([], [...DECISION_BACKENDS]);
}
