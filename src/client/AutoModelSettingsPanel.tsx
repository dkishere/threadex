import { modelLabel as catalogModelLabel, supportsAutoLowEffort } from "../modelCatalog";
import { useEffect, useState, type FormEvent } from "react";
import { AUTO_EFFORT_CHOICES, AUTO_MODEL_CHOICES, type AutoCustomRules, type AutoEffort, type AutoModel } from "../autoModelCatalog";

type Settings = {
  apiKeyConfigured: boolean;
  selectorModel: string;
  customRulesEnabled: boolean;
  customRules: AutoCustomRules;
};

type EditableRule = { enabled: boolean; efforts: AutoEffort[]; condition: string };
const endpoint = "/api/settings/auto-model";
const models = Object.keys(AUTO_MODEL_CHOICES) as AutoModel[];
const efforts = Object.keys(AUTO_EFFORT_CHOICES) as AutoEffort[];

function editableRules(saved: AutoCustomRules = {}): Record<AutoModel, EditableRule> {
  return Object.fromEntries(models.map(model => [model, saved[model] ?? {
    enabled: true,
    efforts: supportsAutoLowEffort(model) ? efforts : efforts.filter(effort => effort !== "low" && effort !== "medium"),
    condition: ""
  }])) as Record<AutoModel, EditableRule>;
}

function modelLabel(model: AutoModel): string {
  return `GPT-${catalogModelLabel(model)}`;
}

export function AutoModelSettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [customRulesEnabled, setCustomRulesEnabled] = useState(false);
  const [customRules, setCustomRules] = useState(() => editableRules());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function applySettings(body: Settings) {
    setSettings(body);
    setCustomRulesEnabled(body.customRulesEnabled === true);
    setCustomRules(editableRules(body.customRules));
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Unable to load Auto model settings.");
      const body = await response.json();
      if (!controller.signal.aborted) applySettings(body);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);

  async function saveKey(event?: FormEvent, clear = false) {
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
      applySettings(body);
      setKey("");
      setNotice(clear ? "Key removed. Auto uses the original model-upgrade logic." : "Key saved. Auto will use Jev from the next turn.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Auto model settings.");
    } finally { setBusy(false); }
  }

  async function saveCustomRules(event?: FormEvent, useDefault = false) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const enabled = useDefault ? false : customRulesEnabled;
      const rules = useDefault ? {} : customRules;
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customRulesEnabled: enabled, customRules: rules })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save custom rules.");
      applySettings(body);
      setNotice(enabled ? "Custom Jev rules saved." : "Default Jev rules restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save custom rules.");
    } finally { setBusy(false); }
  }

  function updateRule(model: AutoModel, patch: Partial<EditableRule>) {
    setCustomRules(current => ({ ...current, [model]: { ...current[model], ...patch } }));
  }

  const enabledRuleCount = models.filter(model => customRules[model].enabled).length;

  return <div className="settings-content auto-model-settings" role="tabpanel" aria-label="Auto model">
    <div className="settings-section-heading"><div><h2>Auto model</h2><p>Choose Auto as a gear's model in gearbox configuration to select a model for each turn.</p></div></div>
    <section className="settings-card auto-model-settings-card">
      <h3>TypeSafe Jev</h3>
      <p>Jev selects GPT-6 Luna, Sol, or Astra using your prompt and summarized conversation. Long input is truncated before it is sent to TypeSafe.</p>
      <p>Without a key, Auto starts at GPT-6 Luna/high and lets the agent upgrade when needed. If Jev is unavailable, the existing Auto setting is kept.</p>
      <p>This key and the custom rules apply to all workspaces on this Threadex server.</p>
      <form className="account-login-form" onSubmit={event => void saveKey(event)}>
        <label><span>TypeSafe API key</span><input type="password" value={key} autoComplete="new-password" spellCheck={false}
          placeholder={settings?.apiKeyConfigured ? "Key saved — enter a replacement" : "Enter API key"}
          onChange={event => setKey(event.target.value)} disabled={busy || !settings} /></label>
        <p>{settings ? settings.apiKeyConfigured ? "API key configured. Jev routing is enabled for Auto turns." : "No key configured. Auto uses the original upgrade logic." : "Loading settings…"}</p>
        <div className="account-login-actions">
          <button className="secondary primary" type="submit" disabled={busy || !settings || !key.trim()}>{busy ? "Saving…" : "Save key"}</button>
          <button className="secondary" type="button" disabled={busy || !settings?.apiKeyConfigured} onClick={() => void saveKey(undefined, true)}>Remove key</button>
        </div>
      </form>
      <form className="account-login-form auto-model-routing-form" onSubmit={event => void saveCustomRules(event)}>
        <label className="auto-model-custom-toggle"><input type="checkbox" checked={customRulesEnabled}
          onChange={event => setCustomRulesEnabled(event.target.checked)} disabled={busy || !settings} />
          <span>Use custom rules</span></label>
        <p>Jev chooses among enabled models and their checked effort levels. Select at least one effort per model. Blank conditions use the built-in condition.</p>
        {customRulesEnabled && <div className="auto-model-rules">
          {models.map(model => {
            const rule = customRules[model];
            const allowedEfforts = supportsAutoLowEffort(model) ? efforts : efforts.filter(effort => effort !== "low" && effort !== "medium");
            return <fieldset className="auto-model-rule" key={model} disabled={busy || !settings}>
              <div className="auto-model-rule-header">
                <label><input type="checkbox" checked={rule.enabled} onChange={event => updateRule(model, { enabled: event.target.checked })} />
                  <span>{modelLabel(model)}</span></label>
              </div>
              <fieldset className="auto-model-efforts"><legend>Allowed effort</legend>
                {allowedEfforts.map(effort => <label key={effort}><input type="checkbox" checked={rule.efforts.includes(effort)}
                  disabled={rule.efforts.length === 1 && rule.efforts.includes(effort)}
                  onChange={event => updateRule(model, { efforts: event.target.checked ? [...rule.efforts, effort] : rule.efforts.filter(value => value !== effort) })} />{effort}</label>)}
              </fieldset>
              <label><span>Condition</span><textarea value={rule.condition} spellCheck={false}
                placeholder={AUTO_MODEL_CHOICES[model]} onChange={event => updateRule(model, { condition: event.target.value })} /></label>
            </fieldset>;
          })}
        </div>}
        {customRulesEnabled && enabledRuleCount === 0 && <p role="alert">Enable at least one model rule.</p>}
        <div className="account-login-actions">
          <button className="secondary primary" type="submit" disabled={busy || !settings || (customRulesEnabled && enabledRuleCount === 0)}>{busy ? "Saving…" : "Save rules"}</button>
          <button className="secondary" type="button" disabled={busy || !settings} onClick={() => void saveCustomRules(undefined, true)}>Use default</button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </div>;
}
