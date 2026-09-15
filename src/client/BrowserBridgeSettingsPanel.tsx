import { Loader2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type BrowserContextValueMapping = {
  urlPrefix: string;
  values: Record<string, unknown>;
};

type EditableMapping = BrowserContextValueMapping & { id: string; valuesText: string };

export function BrowserBridgeSettingsPanel() {
  const [mappings, setMappings] = useState<EditableMapping[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ kind: "success" | "warning"; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError("");
    setNotice(null);
    try {
      const response = await fetch("/api/browser-context/value-mappings", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Browser Bridge API returned ${response.status}`);
      setMappings(Array.isArray(payload.mappings) ? payload.mappings.map(editableMapping) : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const update = (id: string, patch: Partial<EditableMapping>) => {
    setMappings((current) => current.map((mapping) => mapping.id === id ? { ...mapping, ...patch } : mapping));
  };

  const addMapping = () => {
    setMappings((current) => [...current, {
      id: newMappingId(),
      urlPrefix: "https://",
      values: {},
      valuesText: '{\n  "project": "example"\n}'
    }]);
  };

  const save = async () => {
    setError("");
    setNotice(null);
    let nextMappings: BrowserContextValueMapping[];
    try {
      nextMappings = mappings.map((mapping, index) => {
        const urlPrefix = mapping.urlPrefix.trim();
        let values: unknown;
        try {
          values = JSON.parse(mapping.valuesText);
        } catch {
          throw new Error(`Values JSON for mapping ${index + 1} is invalid.`);
        }
        if (!values || typeof values !== "object" || Array.isArray(values)) {
          throw new Error(`Values JSON for mapping ${index + 1} must be an object.`);
        }
        return { urlPrefix, values: values as Record<string, unknown> };
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/browser-context/value-mappings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mappings: nextMappings })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Browser Bridge API returned ${response.status}`);
      setMappings(Array.isArray(payload.mappings) ? payload.mappings.map(editableMapping) : []);
      setNotice({ kind: "success", text: "Saved to Local Browser Bridge." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="settings-content browser-bridge-settings" role="tabpanel" aria-label="Browser Bridge">
      <div className="settings-section-heading">
        <div>
          <h2>Browser Bridge context values</h2>
          <p>Manage the Local Browser Bridge values attached when a captured page URL starts with a matching prefix.</p>
        </div>
        <div className="browser-bridge-settings-actions">
          <button className="secondary" type="button" onClick={() => void load()} disabled={isLoading || isSaving}>
            <RotateCcw aria-hidden="true" /> Refresh
          </button>
          <button className="secondary primary" type="button" onClick={() => void save()} disabled={isLoading || isSaving}>
            {isSaving ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
            Save mappings
          </button>
        </div>
      </div>

      <section className="settings-card browser-bridge-info" aria-label="How URL prefix values work">
        <p>One prefix can contain any number of JSON key/value pairs. If more than one prefix matches, all values are merged and the most specific prefix wins for duplicate keys. Add project and source-root hints for local apps when they help Codex locate the rendered control's source.</p>
        <code>{'"page-values": { "project": "demo", "projectRoot": "/workspace/demo", "sourceRoot": "/workspace/demo/src" }, "match-by-url": ["https://example.com/"]'}</code>
      </section>

      {error ? <div className="browser-bridge-settings-error">{error}</div> : null}
      {notice ? <div className={`browser-bridge-settings-notice ${notice.kind}`}>{notice.text}</div> : null}
      {isLoading ? <div className="browser-bridge-settings-loading"><Loader2 className="spin" aria-hidden="true" /> Loading Browser Bridge mappings…</div> : null}

      {!isLoading && mappings.map((mapping, index) => (
        <section className="settings-card browser-bridge-mapping" key={mapping.id}>
          <div className="settings-card-header">
            <div>
              <h3>URL prefix {index + 1}</h3>
              <p>Use the exact prefix to match, including its path where needed.</p>
            </div>
            <button
              className="ghost-icon"
              type="button"
              title="Remove mapping"
              aria-label={`Remove URL prefix ${index + 1}`}
              onClick={() => setMappings((current) => current.filter((candidate) => candidate.id !== mapping.id))}
              disabled={isSaving}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
          <div className="browser-bridge-mapping-fields">
            <label>
              <span>URL prefix</span>
              <input
                value={mapping.urlPrefix}
                onChange={(event) => update(mapping.id, { urlPrefix: event.target.value })}
                placeholder="https://example.com/projects/"
                spellCheck={false}
                disabled={isSaving}
              />
            </label>
            <label>
              <span>Values JSON</span>
              <textarea
                value={mapping.valuesText}
                onChange={(event) => update(mapping.id, { valuesText: event.target.value })}
                placeholder={'{\n  "project": "demo",\n  "environment": "staging"\n}'}
                spellCheck={false}
                disabled={isSaving}
              />
            </label>
          </div>
        </section>
      ))}

      {!isLoading && mappings.length === 0 ? <p className="settings-empty">No URL prefix mappings yet.</p> : null}
      <button className="secondary browser-bridge-add-mapping" type="button" onClick={addMapping} disabled={isLoading || isSaving}>
        <Plus aria-hidden="true" /> Add URL prefix
      </button>
    </div>
  );
}

function editableMapping(mapping: BrowserContextValueMapping): EditableMapping {
  return {
    id: newMappingId(),
    urlPrefix: typeof mapping?.urlPrefix === "string" ? mapping.urlPrefix : "",
    values: mapping?.values && typeof mapping.values === "object" && !Array.isArray(mapping.values) ? mapping.values : {},
    valuesText: JSON.stringify(mapping?.values ?? {}, null, 2)
  };
}

function newMappingId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
