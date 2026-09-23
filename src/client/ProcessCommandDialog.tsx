import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Play, X } from "lucide-react";
import { resolveCommandValues, type ProcessCommandParameter, type ProcessCommandValues } from "../processCommandParameters";
import "./ProcessCommandDialog.css";

export function ProcessCommandDialog({ label, parameters, onRun, onClose }: {
  label: string;
  parameters: ProcessCommandParameter[];
  onRun: (values: ProcessCommandValues) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parameters.map((parameter) => [parameter.name, String(parameter.default)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  async function submit() {
    if (busy) return;
    setError(null);
    try {
      const input = Object.fromEntries(parameters.map((parameter) => {
        const raw = values[parameter.name];
        if (parameter.type === "number" && !raw.trim()) throw new Error(`${parameter.name} requires a number.`);
        return [parameter.name, parameter.type === "number" ? Number(raw) : raw];
      }));
      const resolved = resolveCommandValues(parameters, input);
      setBusy(true);
      if (await onRun(resolved)) onClose();
      else setError("Unable to start command. Please try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start command.");
    } finally {
      setBusy(false);
    }
  }
  return createPortal(<dialog ref={dialog} className="process-command-dialog" aria-labelledby="process-command-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header><h2 id="process-command-title">{label}</h2><button type="button" onClick={onClose} disabled={busy} aria-label="Close parameters"><X size={16} /></button></header>
      <div className="process-command-fields">
        {parameters.map((parameter, index) => <label key={parameter.name}>
          <span>{parameter.name}</span>
          {parameter.desc && <small id={`command-param-desc-${index}`}>{parameter.desc}</small>}
          {parameter.type === "option" ? <select autoFocus={index === 0} value={values[parameter.name]} disabled={busy}
            aria-describedby={parameter.desc ? `command-param-desc-${index}` : undefined}
            onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.target.value }))}>
            {parameter.options?.map((option) => <option key={option} value={option}>{option}</option>)}
          </select> : <input autoFocus={index === 0} type={parameter.type === "number" ? "number" : "text"} step={parameter.type === "number" ? "any" : undefined}
            required={parameter.type === "number"} maxLength={parameter.type === "string" ? 4000 : undefined}
            aria-describedby={parameter.desc ? `command-param-desc-${index}` : undefined}
            value={values[parameter.name]} disabled={busy}
            onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.target.value }))} />}
        </label>)}
      </div>
      {error && <p className="process-monitor-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {busy ? "Starting…" : "Run"}
      </button></footer>
    </form>
  </dialog>, document.body);
}
