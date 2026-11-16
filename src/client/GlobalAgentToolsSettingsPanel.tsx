import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";

const endpoint = "/api/settings/global-agent-tools";
const defaultRedactedValue = "********";
const serverNamePattern = /^[A-Za-z0-9_-]{1,64}$/;

export type GlobalAgentProvider = "codex" | "claude";

export type GlobalMcpServerConfig =
  | { name: string; transport: "stdio"; enabled: boolean; providers: GlobalAgentProvider[]; command: string; args: string[]; env: Record<string, string> }
  | { name: string; transport: "http"; enabled: boolean; providers: GlobalAgentProvider[]; url: string; headers: Record<string, string> };

export type GlobalSkillSourceConfig = { path: string; enabled: boolean; providers: GlobalAgentProvider[] };
export type GlobalAgentToolsConfig = { mcpServers: GlobalMcpServerConfig[]; skills: GlobalSkillSourceConfig[] };

export type GlobalAgentToolsResponse = {
  config: GlobalAgentToolsConfig;
  redactedValue: string;
  reservedMcpServerNames: string[];
  providers: GlobalAgentProvider[];
};

type SecretEntryDraft = { entryId: number; entryKey: string; entryValue: string };

export type McpServerDraft = {
  draftId: number;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  providers: GlobalAgentProvider[];
  command: string;
  argumentsText: string;
  url: string;
  secretEntries: SecretEntryDraft[];
};

export type SkillSourceDraft = { draftId: number; path: string; enabled: boolean; providers: GlobalAgentProvider[] };

let nextDraftIdentifier = 1;
function allocateDraftIdentifier() {
  return nextDraftIdentifier++;
}

function secretEntriesFromRecord(record: Record<string, string>): SecretEntryDraft[] {
  return Object.entries(record).map(([entryKey, entryValue]) => ({ entryId: allocateDraftIdentifier(), entryKey, entryValue }));
}

function recordFromSecretEntries(secretEntries: SecretEntryDraft[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const secretEntry of secretEntries) {
    const trimmedKey = secretEntry.entryKey.trim();
    if (trimmedKey) record[trimmedKey] = secretEntry.entryValue;
  }
  return record;
}

export function draftsFromConfig(config: GlobalAgentToolsConfig): { serverDrafts: McpServerDraft[]; skillDrafts: SkillSourceDraft[] } {
  const serverDrafts = config.mcpServers.map((server): McpServerDraft => server.transport === "stdio"
    ? { draftId: allocateDraftIdentifier(), name: server.name, transport: "stdio", enabled: server.enabled, providers: [...server.providers],
        command: server.command, argumentsText: server.args.join("\n"), url: "", secretEntries: secretEntriesFromRecord(server.env) }
    : { draftId: allocateDraftIdentifier(), name: server.name, transport: "http", enabled: server.enabled, providers: [...server.providers],
        command: "", argumentsText: "", url: server.url, secretEntries: secretEntriesFromRecord(server.headers) });
  const skillDrafts = config.skills.map((skill): SkillSourceDraft => ({ draftId: allocateDraftIdentifier(), path: skill.path, enabled: skill.enabled, providers: [...skill.providers] }));
  return { serverDrafts, skillDrafts };
}

export function configFromDrafts(serverDrafts: McpServerDraft[], skillDrafts: SkillSourceDraft[]): GlobalAgentToolsConfig {
  const mcpServers = serverDrafts.map((draft): GlobalMcpServerConfig => draft.transport === "stdio"
    ? { name: draft.name.trim(), transport: "stdio", enabled: draft.enabled, providers: draft.providers, command: draft.command.trim(),
        args: draft.argumentsText.split("\n").map(line => line.trim()).filter(Boolean), env: recordFromSecretEntries(draft.secretEntries) }
    : { name: draft.name.trim(), transport: "http", enabled: draft.enabled, providers: draft.providers, url: draft.url.trim(),
        headers: recordFromSecretEntries(draft.secretEntries) });
  const skills = skillDrafts.map((draft): GlobalSkillSourceConfig => ({ path: draft.path.trim(), enabled: draft.enabled, providers: draft.providers }));
  return { mcpServers, skills };
}

function describeConfigProblem(serverDrafts: McpServerDraft[], reservedNames: string[]): string {
  const seenNames = new Set<string>();
  for (const draft of serverDrafts) {
    const name = draft.name.trim();
    if (!serverNamePattern.test(name)) return `MCP server name "${name}" must use only letters, numbers, "_" or "-" (max 64 characters).`;
    if (reservedNames.includes(name)) return `MCP server name "${name}" is reserved by Threadex.`;
    if (seenNames.has(name)) return `MCP server name "${name}" is used more than once.`;
    seenNames.add(name);
  }
  return "";
}

function ProviderCheckboxes({ providers, availableProviders, disabled, onChange }: {
  providers: GlobalAgentProvider[]; availableProviders: GlobalAgentProvider[]; disabled: boolean; onChange: (providers: GlobalAgentProvider[]) => void;
}) {
  return <span className="global-agent-tools-providers">
    {availableProviders.map(provider => <label key={provider}>
      <input type="checkbox" checked={providers.includes(provider)} disabled={disabled}
        onChange={event => onChange(event.target.checked ? [...providers, provider] : providers.filter(existing => existing !== provider))} />
      {provider === "codex" ? "Codex" : "Claude"}
    </label>)}
  </span>;
}

function SecretEntryEditor({ label, secretEntries, disabled, onChange }: {
  label: string; secretEntries: SecretEntryDraft[]; disabled: boolean; onChange: (secretEntries: SecretEntryDraft[]) => void;
}) {
  return <div className="global-agent-tools-field">
    <span>{label}</span>
    {secretEntries.map(secretEntry => <div className="global-agent-tools-entry" key={secretEntry.entryId}>
      <input type="text" aria-label={`${label} name`} placeholder="NAME" value={secretEntry.entryKey} disabled={disabled} spellCheck={false}
        onChange={event => onChange(secretEntries.map(existing => existing.entryId === secretEntry.entryId ? { ...existing, entryKey: event.target.value } : existing))} />
      <input type="password" aria-label={`${label} value`} placeholder="value" value={secretEntry.entryValue} disabled={disabled} autoComplete="off"
        onChange={event => onChange(secretEntries.map(existing => existing.entryId === secretEntry.entryId ? { ...existing, entryValue: event.target.value } : existing))} />
      <button className="ghost-icon" type="button" title={`Remove ${label} entry`} aria-label={`Remove ${label} entry`} disabled={disabled}
        onClick={() => onChange(secretEntries.filter(existing => existing.entryId !== secretEntry.entryId))}><Trash2 aria-hidden="true" /></button>
    </div>)}
    <button className="secondary global-agent-tools-add" type="button" disabled={disabled}
      onClick={() => onChange([...secretEntries, { entryId: allocateDraftIdentifier(), entryKey: "", entryValue: "" }])}>
      <Plus aria-hidden="true" />Add {label.toLowerCase()}
    </button>
  </div>;
}

export function GlobalAgentToolsSettingsPanel() {
  const [serverDrafts, setServerDrafts] = useState<McpServerDraft[]>([]);
  const [skillDrafts, setSkillDrafts] = useState<SkillSourceDraft[]>([]);
  const [reservedNames, setReservedNames] = useState<string[]>([]);
  const [availableProviders, setAvailableProviders] = useState<GlobalAgentProvider[]>(["codex", "claude"]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = loading || saving;

  function applyResponse(body: GlobalAgentToolsResponse) {
    const drafts = draftsFromConfig(body.config);
    setServerDrafts(drafts.serverDrafts);
    setSkillDrafts(drafts.skillDrafts);
    setReservedNames(body.reservedMcpServerNames ?? []);
    if (body.providers?.length) setAvailableProviders(body.providers);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to load MCP servers and skills.");
      if (!controller.signal.aborted) applyResponse(body);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load MCP servers and skills.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  function updateServerDraft(draftId: number, changes: Partial<McpServerDraft>) {
    setServerDrafts(current => current.map(draft => draft.draftId === draftId ? { ...draft, ...changes } : draft));
    setNotice("");
  }

  function updateSkillDraft(draftId: number, changes: Partial<SkillSourceDraft>) {
    setSkillDrafts(current => current.map(draft => draft.draftId === draftId ? { ...draft, ...changes } : draft));
    setNotice("");
  }

  function addServerDraft() {
    setServerDrafts(current => [...current, {
      draftId: allocateDraftIdentifier(), name: "", transport: "stdio", enabled: true, providers: [...availableProviders],
      command: "", argumentsText: "", url: "", secretEntries: []
    }]);
    setNotice("");
  }

  function addSkillDraft() {
    setSkillDrafts(current => [...current, { draftId: allocateDraftIdentifier(), path: "", enabled: true, providers: [...availableProviders] }]);
    setNotice("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    const problem = describeConfigProblem(serverDrafts, reservedNames);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configFromDrafts(serverDrafts, skillDrafts) })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save MCP servers and skills.");
      applyResponse(body);
      setNotice("Saved. Changes apply from the next turn.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save MCP servers and skills.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-content global-instructions-settings global-agent-tools-settings" role="tabpanel" aria-label="MCP and skills">
    <div className="settings-section-heading">
      <div><h2>MCP servers &amp; skills</h2><p>Inject shared MCP servers and skills into Codex and Claude Code sessions started by Threadex.</p></div>
    </div>
    <form className="settings-card global-instructions-card" onSubmit={event => void save(event)}>
      <p>These settings only apply to sessions Threadex starts; ~/.codex and ~/.claude are never modified. Plan and read-only turns do not load MCP servers. Changes take effect from the next turn. Environment and header values are hidden once saved; leave a value as-is to keep it, or type a new one to replace it.</p>

      <h3 className="global-agent-tools-heading">MCP servers</h3>
      {serverDrafts.length === 0 && !loading ? <p>No MCP servers configured.</p> : null}
      {serverDrafts.map(draft => <fieldset className="global-agent-tools-item" key={draft.draftId} disabled={busy}>
        <div className="global-agent-tools-row">
          <input type="text" aria-label="MCP server name" placeholder="server_name" value={draft.name} spellCheck={false}
            onChange={event => updateServerDraft(draft.draftId, { name: event.target.value })} />
          <select aria-label="MCP server transport" value={draft.transport}
            onChange={event => updateServerDraft(draft.draftId, { transport: event.target.value as "stdio" | "http", secretEntries: [] })}>
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
          <label><input type="checkbox" checked={draft.enabled} onChange={event => updateServerDraft(draft.draftId, { enabled: event.target.checked })} />Enabled</label>
          <ProviderCheckboxes providers={draft.providers} availableProviders={availableProviders} disabled={busy}
            onChange={providers => updateServerDraft(draft.draftId, { providers })} />
          <button className="ghost-icon" type="button" title="Remove MCP server" aria-label={`Remove MCP server ${draft.name || ""}`.trim()}
            onClick={() => { setServerDrafts(current => current.filter(existing => existing.draftId !== draft.draftId)); setNotice(""); }}><Trash2 aria-hidden="true" /></button>
        </div>
        {draft.transport === "stdio" ? <>
          <div className="global-agent-tools-field"><span>Command</span>
            <input type="text" aria-label="Command" placeholder="npx" value={draft.command} spellCheck={false}
              onChange={event => updateServerDraft(draft.draftId, { command: event.target.value })} /></div>
          <div className="global-agent-tools-field"><span>Arguments (one per line)</span>
            <textarea aria-label="Arguments" rows={3} value={draft.argumentsText} spellCheck={false}
              onChange={event => updateServerDraft(draft.draftId, { argumentsText: event.target.value })} /></div>
          <SecretEntryEditor label="Environment" secretEntries={draft.secretEntries} disabled={busy}
            onChange={secretEntries => updateServerDraft(draft.draftId, { secretEntries })} />
        </> : <>
          <div className="global-agent-tools-field"><span>URL</span>
            <input type="text" aria-label="URL" placeholder="https://example.com/mcp" value={draft.url} spellCheck={false}
              onChange={event => updateServerDraft(draft.draftId, { url: event.target.value })} /></div>
          <SecretEntryEditor label="Headers" secretEntries={draft.secretEntries} disabled={busy}
            onChange={secretEntries => updateServerDraft(draft.draftId, { secretEntries })} />
        </>}
      </fieldset>)}
      <button className="secondary global-agent-tools-add" type="button" disabled={busy} onClick={addServerDraft}><Plus aria-hidden="true" />Add MCP server</button>

      <h3 className="global-agent-tools-heading">Skill sources</h3>
      <p>Absolute path to a single skill directory, or to a directory containing several skill directories.</p>
      {skillDrafts.length === 0 && !loading ? <p>No skill sources configured.</p> : null}
      {skillDrafts.map(draft => <fieldset className="global-agent-tools-item" key={draft.draftId} disabled={busy}>
        <div className="global-agent-tools-row">
          <input type="text" aria-label="Skill source path" placeholder="/absolute/path/to/skills" value={draft.path} spellCheck={false}
            onChange={event => updateSkillDraft(draft.draftId, { path: event.target.value })} />
          <label><input type="checkbox" checked={draft.enabled} onChange={event => updateSkillDraft(draft.draftId, { enabled: event.target.checked })} />Enabled</label>
          <ProviderCheckboxes providers={draft.providers} availableProviders={availableProviders} disabled={busy}
            onChange={providers => updateSkillDraft(draft.draftId, { providers })} />
          <button className="ghost-icon" type="button" title="Remove skill source" aria-label="Remove skill source"
            onClick={() => { setSkillDrafts(current => current.filter(existing => existing.draftId !== draft.draftId)); setNotice(""); }}><Trash2 aria-hidden="true" /></button>
        </div>
      </fieldset>)}
      <button className="secondary global-agent-tools-add" type="button" disabled={busy} onClick={addSkillDraft}><Plus aria-hidden="true" />Add skill source</button>

      <div className="global-instructions-actions">
        <span />
        <button className="secondary primary" type="submit" disabled={busy}>{saving ? "Saving…" : "Save"}</button>
      </div>
      {loading ? <p role="status">Loading MCP servers and skills…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  </div>;
}
