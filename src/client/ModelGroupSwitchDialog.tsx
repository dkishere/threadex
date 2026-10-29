import { useEffect, useRef } from "react";
import "./ModelGroupSwitchDialog.css";
import { modelLabel, modelProvider, type ModelProvider } from "../modelCatalog";

const GROUP_LABEL: Record<ModelProvider, string> = { claude: "Claude Code", codex: "Codex" };
export const modelGroupLabel = (model: string) => GROUP_LABEL[modelProvider(model)];

/** Native modal dialog: Esc cancels, focus moves in on open and returns to the previously focused control on close. */
export function ModelGroupSwitchDialog({ from, to, onConfirm, onCancel }: {
  from: string;
  to: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      opener?.focus?.();
    };
  }, []);
  return (
    <dialog ref={dialog} className="model-group-switch-dialog" role="alertdialog" aria-labelledby="model-group-switch-title"
      aria-describedby="model-group-switch-body" onCancel={(event) => { event.preventDefault(); onCancel(); }}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <h2 id="model-group-switch-title">Switch from {modelGroupLabel(from)} to {modelGroupLabel(to)}?</h2>
        <p id="model-group-switch-body">
          This session last ran on {modelLabel(from)} ({modelGroupLabel(from)}). Sending this prompt will run it on {modelLabel(to)} ({modelGroupLabel(to)}),
          a different agent backend. It cannot resume the earlier native thread; it continues with a note that the session switched providers.
        </p>
        <div className="model-group-switch-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" autoFocus>Switch and send</button>
        </div>
      </form>
    </dialog>
  );
}
