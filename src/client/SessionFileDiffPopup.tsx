import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MonacoDiffEditor } from "./MonacoDiffEditor";

export type SessionFileDiffSource = {
  path: string;
  kind: string;
};

type SessionFileDiffChange = SessionFileDiffSource & {
  before?: string;
  after?: string;
  beforeText?: string;
  afterText?: string;
  beforeContent?: string;
  afterContent?: string;
  oldContent?: string;
  newContent?: string;
  previousContent?: string;
  currentContent?: string;
  original?: string;
  updated?: string;
  diff?: string;
  patch?: string;
  unifiedDiff?: string;
};

type SessionFileDiffPayload = { change?: SessionFileDiffChange };

function firstText(change: SessionFileDiffChange, keys: Array<keyof SessionFileDiffChange>) {
  for (const key of keys) {
    const value = change[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function diffTextPair(value: string) {
  const before: string[] = [];
  const after: string[] = [];
  let hasContent = false;
  for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("*** ") || line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) {
      before.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith("+")) {
      after.push(line.slice(1));
      hasContent = true;
    } else if (line.startsWith(" ")) {
      const text = line.slice(1);
      before.push(text);
      after.push(text);
      hasContent = true;
    }
  }
  return hasContent ? { before: before.join("\n"), after: after.join("\n") } : null;
}

function buildDiffTextPair(change: SessionFileDiffChange) {
  const before = firstText(change, ["before", "beforeText", "beforeContent", "oldContent", "previousContent", "original"]);
  const after = firstText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]);
  if (before !== undefined || after !== undefined) return { before: before ?? "", after: after ?? "" };
  const patch = firstText(change, ["diff", "patch", "unifiedDiff"]);
  return patch ? diffTextPair(patch) : null;
}

function fileChangeLabel(kind: string) {
  if (kind === "add") return "Added";
  if (kind === "delete") return "Deleted";
  if (kind === "move") return "Moved";
  return "Edited";
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function SessionFileDiffPopup({
  sessionId,
  file,
  onClose
}: {
  sessionId: string;
  file: SessionFileDiffSource;
  onClose: () => void;
}) {
  const [change, setChange] = useState<SessionFileDiffChange>(file);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const textPair = useMemo(() => buildDiffTextPair(change), [change]);

  useEffect(() => {
    const controller = new AbortController();
    setChange(file);
    setStatus("loading");
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-change?path=${encodeURIComponent(file.path)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as SessionFileDiffPayload | null;
        if (!response.ok || !payload?.change || typeof payload.change.path !== "string") throw new Error("Could not load file diff.");
        return payload.change;
      })
      .then((nextChange) => {
        if (controller.signal.aborted) return;
        setChange(nextChange);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [file, sessionId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="file-diff-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="file-diff-popup" role="dialog" aria-modal="true" aria-label={`Diff for ${fileName(change.path)}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="file-diff-header">
          <div className="file-diff-title">
            <span className="file-change-badge" data-operation={change.kind === "add" || change.kind === "delete" ? change.kind : "update"}>{fileChangeLabel(change.kind)}</span>
            <div>
              <strong>{fileName(change.path)}</strong>
              <code>{change.path}</code>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close diff">
            <X aria-hidden="true" />
          </button>
        </header>
        {status === "loading" ? (
          <div className="file-diff-state">Loading diff…</div>
        ) : status === "error" ? (
          <div className="file-diff-state">Could not load this file’s diff.</div>
        ) : textPair ? (
          <MonacoDiffEditor before={textPair.before} after={textPair.after} filePath={change.path} />
        ) : (
          <div className="file-diff-state">No comparable text was recorded for this file change.</div>
        )}
      </section>
    </div>
  );
}
