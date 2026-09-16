import { Cog } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ModelReasoningEffort } from "./appTypes";
import { COMPACT_FILE_DROP_QUERY } from "./globalFileDrop";

export type ComposerGearProfile = {
  model: string;
  effort: ModelReasoningEffort;
};

type ComposerFrameProps = {
  children: ReactNode;
};

type ComposerSurfaceProps = {
  children: ReactNode;
  onDropFiles?: (files: FileList) => void | Promise<void>;
};

type ComposerToolbarProps = {
  children: ReactNode;
};

type ComposerGearSelectorProps = {
  idPrefix: string;
  label: string;
  gears: ComposerGearProfile[];
  activeGearIndex: number;
  modelOptions: readonly string[];
  effortOptions: readonly ModelReasoningEffort[];
  ultraEffortOptions: readonly ModelReasoningEffort[];
  supportsUltraEffort: (model: string) => boolean;
  modelOptionLabel: (model: string) => string;
  effortOptionLabel: (effort: ModelReasoningEffort) => string;
  onActivateGear: (index: number) => void;
  onModelChange: (index: number, model: string) => void;
  onEffortChange: (index: number, effort: ModelReasoningEffort) => void;
  autoModelValue?: string;
  autoEffort?: ModelReasoningEffort;
  disabled?: boolean;
  className?: string;
};

const COMPACT_EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  minimal: "Min",
  low: "L",
  medium: "M",
  high: "H",
  xhigh: "XH",
  ultra: "U"
};

function compactModelLabel(model: string, label: string, isAuto: boolean) {
  if (isAuto) return "Auto";
  return label
    .replace(/^5\.6\s+(Terra|Luna|Sol)$/i, "$1")
    .replace(/^5\.4\s+Mini$/i, "5.4m")
    .replace(/^GPT-/i, "");
}

export function ComposerFrame({ children }: ComposerFrameProps) {
  return <div className="composer-layout">{children}</div>;
}

export function ComposerSurface({ children, onDropFiles: onDesktopDropFiles }: ComposerSurfaceProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia(COMPACT_FILE_DROP_QUERY).matches);
  const onDropFiles = compact ? undefined : onDesktopDropFiles;

  useEffect(() => {
    const media = window.matchMedia(COMPACT_FILE_DROP_QUERY);
    const update = () => {
      setCompact(media.matches);
      setIsDragActive(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function isFileDrag(event: DragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles || !isFileDrag(event)) return;
    event.preventDefault();
    setIsDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
    setIsDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles || !isFileDrag(event)) return;
    event.preventDefault();
    setIsDragActive(false);
    if (event.dataTransfer.files.length > 0) {
      void onDropFiles(event.dataTransfer.files);
    }
  }

  return (
    <div
      className="composer-shell"
      data-drag-active={isDragActive ? "true" : undefined}
      data-file-drop-target={onDropFiles ? "true" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragActive && <div className="composer-drop-overlay">Drop files to attach</div>}
      {children}
    </div>
  );
}

export function ComposerToolbar({ children }: ComposerToolbarProps) {
  return <div className="composer-bar">{children}</div>;
}

export function ComposerGearSelector({
  idPrefix,
  label,
  gears,
  activeGearIndex,
  modelOptions,
  effortOptions,
  ultraEffortOptions,
  supportsUltraEffort,
  modelOptionLabel,
  effortOptionLabel,
  onActivateGear,
  onModelChange,
  onEffortChange,
  autoModelValue,
  autoEffort,
  disabled = false,
  className = ""
}: ComposerGearSelectorProps) {
  const classes = className ? `composer-gears ${className}` : "composer-gears";
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const menuId = `${idPrefix}-menu`;
  const [isPhone, setIsPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(width < 768px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(width < 768px)");
    const update = () => setIsPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const activeGear = gears[activeGearIndex] ?? gears[0];
  const activeGearIsAuto = activeGear && autoModelValue !== undefined && activeGear.model === autoModelValue;
  const activeGearEffort = activeGear
    ? activeGearIsAuto && autoEffort ? autoEffort : activeGear.effort
    : undefined;

  useEffect(() => {
    if (!isMenuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isMenuOpen]);

  return (
    <aside ref={rootRef} className={classes} aria-label={label}>
      <div className="composer-gear-controls">
        <button
          className="composer-gear-settings"
          type="button"
          aria-controls={menuId}
          aria-expanded={isMenuOpen}
          aria-label="Configure model gears"
          title="Configure model gears"
          onClick={() => setIsMenuOpen((open) => !open)}
        >
          <Cog aria-hidden="true" />
          {isPhone && activeGear && activeGearEffort && (
            <span className="composer-gear-mobile-summary" aria-hidden="true">
              <span>{compactModelLabel(activeGear.model, modelOptionLabel(activeGear.model), Boolean(activeGearIsAuto))}</span>
              <span>{COMPACT_EFFORT_LABELS[activeGearEffort]}</span>
            </span>
          )}
        </button>
        <div className="composer-gear-radios" role="radiogroup" aria-label={label}>
          {gears.map((gear, index) => {
            const isActive = activeGearIndex === index;
            const isAuto = autoModelValue !== undefined && gear.model === autoModelValue;
            const selectedEffort = isAuto && autoEffort ? autoEffort : gear.effort;
            const gearTitle = isAuto ? "Auto: Jev selects each turn when configured in Settings; otherwise uses automatic upgrades" : `Gear ${index + 1}: ${modelOptionLabel(gear.model)} · ${effortOptionLabel(selectedEffort)}`;
            const gearLabel = isAuto ? "Auto" : `${compactModelLabel(gear.model, modelOptionLabel(gear.model), isAuto)}·${COMPACT_EFFORT_LABELS[selectedEffort]}`;

            return (
              <label className="composer-gear-radio" data-active={isActive ? "true" : undefined} title={gearTitle} key={index}>
                <input
                  id={`${idPrefix}-${index + 1}`}
                  type="radio"
                  name={`${idPrefix}-active`}
                  value={index}
                  checked={isActive}
                  disabled={disabled}
                  aria-label={gearTitle}
                  onChange={() => onActivateGear(index)}
                />
                <span>{gearLabel}</span>
              </label>
            );
          })}
        </div>
      </div>
      {isMenuOpen && (
        <div id={menuId} className="composer-gear-menu" role="group" aria-label="Model gear configuration">
          <div className="composer-gear-menu-title">
            <Cog aria-hidden="true" />
            <strong>Model gear configuration</strong>
          </div>
          <div className="composer-gear-config-list">
            {gears.map((gear, index) => {
              const isActive = activeGearIndex === index;
              const isAuto = autoModelValue !== undefined && gear.model === autoModelValue;
              const selectedEffort = isAuto && autoEffort ? autoEffort : gear.effort;

              return (
                <div className="composer-gear-config" data-active={isActive ? "true" : undefined} key={index}>
                  <button type="button" disabled={disabled} onClick={() => onActivateGear(index)} aria-label={`Activate gear ${index + 1}`}>
                    Gear {index + 1}
                  </button>
                  <select
                    value={gear.model}
                    disabled={disabled}
                    onChange={(event) => onModelChange(index, event.target.value)}
                    aria-label={`Gear ${index + 1} model`}
                  >
                    {autoModelValue !== undefined && <option value={autoModelValue}>Auto</option>}
                    {modelOptions.map((model) => <option value={model} key={model}>{modelOptionLabel(model)}</option>)}
                  </select>
                  <select
                    value={selectedEffort}
                    disabled={disabled || isAuto}
                    onChange={(event) => onEffortChange(index, event.target.value as ModelReasoningEffort)}
                    aria-label={`Gear ${index + 1} effort`}
                  >
                    {(isAuto || supportsUltraEffort(gear.model) ? ultraEffortOptions : effortOptions).map((effort) => (
                      <option value={effort} key={effort}>
                        {effortOptionLabel(effort)}{isAuto && effort === autoEffort ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
