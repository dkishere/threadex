import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Search, Settings2, Users } from "lucide-react";
import { modelLabel } from "../modelCatalog";
import type { RoundtableActor } from "../roundtable";
import { actorFromPreset, type RoundtablePreset } from "../roundtablePresets";
import { ActorAvatar } from "./ActorAvatar";
import "./ActorMultiSelect.css";

export function ActorMultiSelect({ actors, presets, onChange, onManage, min = 0, max = 8, disabled = false,
  emptyLabel = "Default assistant" }: {
  actors: RoundtableActor[]; presets: RoundtablePreset[]; onChange: (actors: RoundtableActor[]) => void;
  onManage: () => void; min?: number; max?: number; disabled?: boolean; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const menu = dropdown.current!;
    const position = () => {
      const bounds = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const down = below >= 240 || below >= above;
      const width = Math.min(Math.max(bounds.width, 320), 420, window.innerWidth - 24);
      Object.assign(menu.style, { width: `${width}px`, left: `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`,
        top: down ? `${bounds.bottom + 6}px` : "auto", bottom: down ? "auto" : `${window.innerHeight - bounds.top + 6}px`,
        maxHeight: `${Math.max(100, down ? below : above)}px` });
    };
    position();
    menu.showPopover();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { menu.hidePopover(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  // Retain customised and legacy actors exactly as saved; toggling a library
  // entry creates a new actor only when it is not already selected.
  const options = [
    ...actors.map(actor => ({ key: actor.presetId && actors.filter(item => item.presetId === actor.presetId).length === 1
      ? `preset:${actor.presetId}` : actor.id, actor, preset: null as RoundtablePreset | null, selected: true })),
    ...presets.filter(preset => !actors.some(actor => actor.presetId === preset.id)).map(preset => ({
      key: `preset:${preset.id}`, actor: { ...preset, systemPrompt: preset.rolePrompt }, preset, selected: false
    }))
  ];
  const visible = options.filter(({ actor }) => `${actor.name} ${modelLabel(actor.model)} ${actor.systemPrompt}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <div className="actor-multi-select" ref={root} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      const choices = [...(root.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ?? [])];
      if (!choices.length) return;
      event.preventDefault();
      const current = choices.indexOf(document.activeElement as HTMLInputElement);
      choices[current < 0 ? (event.key === "ArrowDown" ? 0 : choices.length - 1)
        : (current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
    }
  }}>
    <button type="button" className="actor-picker-trigger" ref={trigger} disabled={disabled}
      aria-label="Select actors" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setQuery(""); setOpen(!open); }}>
      <span className="actor-picker-avatars" aria-hidden="true">{actors.length
        ? actors.slice(0, 3).map(actor => <ActorAvatar key={actor.id} actor={actor} />) : <Users size={18} />}</span>
      <span className="actor-picker-summary"><strong>{actors.length ? actors.map(actor => actor.name).join(", ") : emptyLabel}</strong>
        <small>{actors.length ? `${actors.length} actors selected` : "Select actors"}</small></span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div id={id} ref={dropdown} popover="manual" className="actor-picker-dropdown" role="dialog" aria-label="Select actors">
      <div className="actor-picker-search"><Search size={16} aria-hidden="true" /><input ref={search} aria-label="Search actors"
        placeholder="Search actors…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="actor-picker-options" role="group" aria-label="Available actors">
        {visible.map(({ key, actor, preset, selected }) => <label key={key} className="actor-picker-option" data-selected={selected}>
          <input type="checkbox" checked={selected} aria-label={actor.name}
            disabled={selected ? actors.length <= min : actors.length >= max}
            onChange={() => onChange(selected ? actors.filter(item => item.id !== actor.id) : [...actors, actorFromPreset(preset!)])} />
          <ActorAvatar actor={actor} /><span className="actor-picker-description"><strong>{actor.name}</strong>
            <small>{modelLabel(actor.model)} · {actor.effort}</small>
            {actor.systemPrompt && <span title={actor.systemPrompt}>{actor.systemPrompt}</span>}</span>
        </label>)}
        {!visible.length && <p className="actor-picker-empty">{presets.length || actors.length ? "No matching actors." : "No saved actors yet."}</p>}
      </div>
      <div className="actor-picker-footer"><small aria-live="polite">{actors.length}/{max} selected{min > 0 ? ` · At least ${min}` : " · None uses the default assistant"}</small>
        <button type="button" onClick={() => { setOpen(false); onManage(); }}><Settings2 size={15} />Manage actors</button></div>
    </div>}
  </div>;
}
