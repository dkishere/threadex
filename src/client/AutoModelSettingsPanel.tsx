import { modelLabel as catalogModelLabel, supportsAutoLowEffort } from "../modelCatalog";
import { useEffect, useState, type FormEvent } from "react";
import { AUTO_EFFORT_CHOICES, AUTO_MODEL_CHOICES, type AutoCustomRules, type AutoEffort, type AutoModel } from "../autoModelCatalog";

import { DecisionBackendSettings } from "./DecisionBackendSettings";

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
      setNotice(enabled ? "Custom Auto model rules saved." : "Default Auto model rules restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save custom rules.");
    } finally { setBusy(false); }
  }

  function updateRule(model: AutoModel, patch: Partial<EditableRule>) {
    setCustomRules(current => ({ ...current, [model]: { ...current[model], ...patch } }));
  }

  const enabledRuleCount = models.filter(model => customRules[model].enabled).length;

  return <div className="settings-content auto-model-settings" role="tabpanel" aria-label="Decision">
    <div className="settings-section-heading"><div><h2>Decision</h2><p>Configure shared decision backends and Auto model rules.</p></div></div>
    <DecisionBackendSettings />
    <section className="settings-card auto-model-settings-card">
      <h3>Auto model rules</h3>
      <form className="account-login-form auto-model-routing-form" onSubmit={event => void saveCustomRules(event)}>
        <label className="auto-model-custom-toggle"><input type="checkbox" checked={customRulesEnabled}
          onChange={event => setCustomRulesEnabled(event.target.checked)} disabled={busy || !settings} />
          <span>Use custom rules</span></label>
        <p>The selected backend chooses among enabled models and their checked effort levels. Select at least one effort per model. Blank conditions use the built-in condition.</p>
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
