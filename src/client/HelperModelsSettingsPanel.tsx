import { MODEL_OPTIONS, isClaudeModel, modelLabel } from "../modelCatalog";
import { useEffect, useState } from "react";

type HelperModels = {
  summarizerModel: string;
  summarizerLongModel: string;
  grillModel: string;
  grillLongModel: string;
};

type Settings = { models: HelperModels; defaults: HelperModels };

const endpoint = "/api/settings/helper-models";

const helpers: Array<{ title: string; description: string; base: keyof HelperModels; promoted: keyof HelperModels; promotedWhen: string }> = [
  {
    title: "Session summarizer",
    description: "Writes session titles, updates outcome status and checks Loop task health in the background.",
    base: "summarizerModel",
    promoted: "summarizerLongModel",
    promotedWhen: "Prompts of 100,000 characters or more"
  },
  {
    title: "Griller",
    description: "Reviews a finished turn and asks follow-up questions.",
    base: "grillModel",
    promoted: "grillLongModel",
    promotedWhen: "Turns with 100,000 tokens or characters or more"
  }
];

function optionLabel(model: string) {
  return isClaudeModel(model) ? modelLabel(model) : `GPT-${modelLabel(model)}`;
}

export function HelperModelsSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<HelperModels | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load helper model settings.");
      if (!controller.signal.aborted) {
        setSettings(body);
        setModels(body.models);
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load helper model settings.");
    });
    return () => controller.abort();
  }, []);

  async function save(event: { preventDefault(): void }, next = models) {
    event.preventDefault();
    if (!next) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: next })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save helper model settings.");
      setSettings(body);
      setModels(body.models);
      setNotice("Saved. New summaries and Grill reviews use these models.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save helper model settings.");
    } finally {
      setBusy(false);
    }
  }

  const changed = Boolean(settings && models && JSON.stringify(settings.models) !== JSON.stringify(models));
  const isDefault = Boolean(settings && models && JSON.stringify(settings.defaults) === JSON.stringify(models));
  const usesClaude = Boolean(models && Object.values(models).some(isClaudeModel));

  return <div className="settings-content auto-model-settings" role="tabpanel" aria-label="Helper models">
    <div className="settings-section-heading"><div><h2>Helper models</h2><p>Choose the models that run background helpers. Each helper switches to its promoted model for oversized input.</p></div></div>
    <form className="settings-card auto-model-settings-card" onSubmit={event => void save(event)}>
      {helpers.map(helper => <section key={helper.base} className="helper-models-group">
        <h3>{helper.title}</h3>
        <p>{helper.description}</p>
        <div className="account-login-form helper-models-pair">
          {([["Model", helper.base], [`Promoted model · ${helper.promotedWhen}`, helper.promoted]] as const).map(([label, key]) =>
            <label key={key}><span>{label}</span>
              <select value={models?.[key] ?? ""} disabled={busy || !models}
                onChange={event => { const value = event.target.value; setModels(current => current && { ...current, [key]: value }); setNotice(""); }}>
                {MODEL_OPTIONS.map(model => <option key={model} value={model}>{optionLabel(model)}{settings?.defaults[key] === model ? " (default)" : ""}</option>)}
              </select>
            </label>)}
        </div>
      </section>)}
      {usesClaude ? <p>Claude helpers use the session's or workspace's Claude account, falling back to the most recently used signed-in Claude account. Their usage is not counted against a Codex account.</p> : null}
      <div className="account-login-actions">
        <button className="secondary primary" type="submit" disabled={busy || !changed}>{busy ? "Saving…" : "Save models"}</button>
        <button className="secondary" type="button" disabled={busy || !settings || isDefault}
          onClick={event => { if (settings) void save(event, settings.defaults); }}>Reset to defaults</button>
      </div>
      {!settings && !error ? <p role="status">Loading settings…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  </div>;
}
