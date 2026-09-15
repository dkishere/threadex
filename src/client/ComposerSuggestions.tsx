import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComposerSuggestion } from "./appTypes";

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

export function findComposerSuggestionTrigger(value: string, caret: number | null = value.length) {
  const end = caret ?? value.length;
  const prefix = value.slice(0, end);
  const match = /(?:^|\s)([^\s/][^\s]*)$/.exec(prefix);
  if (!match) return null;
  return { start: end - match[1].length, end, query: match[1] };
}

export async function loadComposerSuggestionKeywords(workspaceId?: string | null): Promise<string[]> {
  if (!workspaceId) return [];
  const response = await fetch(`/api/composer-suggestion-keywords?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const payload = await response.json();
  return normalizeKeywords(payload.keywords);
}

export function ComposerSuggestionMenu({ suggestions, activeIndex, onSelect, loading }: {
  suggestions: ComposerSuggestion[];
  activeIndex: number;
  onSelect: (suggestion: ComposerSuggestion) => void;
  loading?: boolean;
}) {
  return <div className="slash-suggestions composer-suggestions" role="listbox" aria-label="Composer suggestions">
    {suggestions.map((suggestion, index) => <button
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      data-active={index === activeIndex}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(suggestion)}
      key={`${suggestion.kind}:${suggestion.name}:${suggestion.kind === "path" || suggestion.kind === "skill" ? suggestion.path : ""}`}
    >
      <span className="slash-suggestion-name">/{suggestion.name}</span>
      <span className="slash-suggestion-description">{suggestion.description}</span>
      <small>{suggestion.kind === "mode" ? "Mode" : suggestion.scope}</small>
    </button>)}
    {suggestions.length === 0 && <span className="slash-suggestions-empty">{loading ? "Loading suggestions…" : "No matching suggestions"}</span>}
  </div>;
}

export function ComposerSuggestionSettingsPanel({ workspaceId, keywords, onKeywordsChange }: {
  workspaceId?: string | null;
  keywords: string[];
  onKeywordsChange: (keywords: string[]) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft("");
    setError("");
  }, [workspaceId]);
  const save = async (next: string[]) => {
    if (!workspaceId) return false;
    const normalized = normalizeKeywords(next);
    setIsSaving(true);
    setError("");
    try {
      await onKeywordsChange(normalized);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save keywords.");
      return false;
    } finally {
      setIsSaving(false);
    }
  };
  const addKeywords = async () => {
    const additions = normalizeKeywords(draft.split(/[,\n]/));
    if (!additions.length) return;
    if (await save([...keywords, ...additions])) {
      setDraft("");
      inputRef.current?.focus();
    }
  };
  return <div className="settings-content" role="tabpanel" aria-label="Composer suggestions">
    <div className="settings-section-heading"><div><h2>Composer suggestions</h2><p>Type in the composer to insert a saved keyword or thread file or folder. <code>/</code> remains reserved for skills and modes.</p></div></div>
    <section className="settings-card" aria-labelledby="suggestion-keywords-title">
      <div className="settings-card-header"><div><h3 id="suggestion-keywords-title">Suggestion keywords</h3><p>These are saved for this workspace and available to Threadex agents.</p></div></div>
      <div className="composer-suggestion-keywords">
        <div className="composer-suggestion-keyword-tags" aria-label="Saved suggestion keywords">
          {keywords.map((keyword) => <span className="composer-suggestion-keyword-tag" key={keyword}>
            <span>{keyword}</span>
            <button type="button" disabled={isSaving} onClick={() => void save(keywords.filter((item) => item !== keyword))} title={`Remove ${keyword}`} aria-label={`Remove ${keyword}`}>
              <X aria-hidden="true" />
            </button>
          </span>)}
          {keywords.length === 0 && <span className="composer-suggestion-keywords-empty">No keywords yet.</span>}
        </div>
        <form className="composer-suggestion-keyword-add" onSubmit={(event) => { event.preventDefault(); void addKeywords(); }}>
          <input ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add keyword" disabled={!workspaceId || isSaving} />
          <button type="submit" className="secondary" disabled={!workspaceId || !draft.trim() || isSaving}><Plus aria-hidden="true" />Add</button>
        </form>
        {error && <p className="composer-suggestion-keywords-error" role="alert">{error}</p>}
      </div>
    </section>
  </div>;
}
