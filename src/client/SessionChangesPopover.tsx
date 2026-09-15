import { FolderOpen, MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileEditIcon } from "./FileEditIcon";
import { compactFilePath } from "./filePathDisplay";
import { openProjectFiles, openSessionReview } from "./ProjectFilesViewer";
import { SessionFileDiffPopup, type SessionFileDiffSource } from "./SessionFileDiffPopup";

type SessionFileChange = {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
  movePath?: string;
  turnIds: string[];
};

type SessionChangePayload = {
  fileChanges?: SessionFileChange[];
  totals?: { files?: number; additions?: number; deletions?: number };
};

function fileChangeTone(kind: string) {
  return kind === "add" || kind === "delete" || kind === "move" ? kind : "update";
}

function fileChangeLabel(kind: string) {
  if (kind === "add") return "Added";
  if (kind === "delete") return "Deleted";
  if (kind === "move") return "Moved";
  return "Edited";
}

export function SessionChangesPopover({ sessionId }: { sessionId?: string | null }) {
  const [target, setTarget] = useState<Element | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [files, setFiles] = useState<SessionFileChange[]>([]);
  const [diffFile, setDiffFile] = useState<SessionFileDiffSource | null>(null);
  const [totals, setTotals] = useState({ files: 0, additions: 0, deletions: 0 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const closeTimerRef = useRef<number | undefined>(undefined);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTarget(document.querySelector(".content-header-actions"));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    setStatus("loading");
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-changes`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as SessionChangePayload | null;
        if (!response.ok) throw new Error("Could not load session changes.");
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const nextFiles = Array.isArray(payload?.fileChanges) ? payload.fileChanges : [];
        setFiles(nextFiles);
        setTotals({
          files: typeof payload?.totals?.files === "number" ? payload.totals.files : nextFiles.length,
          additions: typeof payload?.totals?.additions === "number" ? payload.totals.additions : 0,
          deletions: typeof payload?.totals?.deletions === "number" ? payload.totals.deletions : 0
        });
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [refreshKey, sessionId]);

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isPinned) return;
    const closeOnOutsideInteraction = (event: MouseEvent) => {
      if (!summaryRef.current?.contains(event.target as Node)) {
        setIsPinned(false);
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPinned(false);
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideInteraction);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideInteraction);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isPinned]);

  if (!target || !sessionId || (status === "ready" && totals.files === 0)) return null;

  const cancelClose = () => {
    if (closeTimerRef.current !== undefined) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  };
  const openPopover = () => {
    cancelClose();
    if (!isOpen) {
      setIsOpen(true);
      setRefreshKey((value) => value + 1);
    }
  };
  const scheduleClose = () => {
    if (isPinned) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      closeTimerRef.current = undefined;
    }, 500);
  };
  const togglePinnedPopover = () => {
    cancelClose();
    if (isPinned) {
      setIsPinned(false);
      setIsOpen(false);
      return;
    }
    setIsPinned(true);
    if (!isOpen) {
      setIsOpen(true);
      setRefreshKey((value) => value + 1);
    }
  };
  const countLabel = status === "loading" ? "Loading changes" : status === "error" ? "Changes unavailable" : `${totals.files} changed ${totals.files === 1 ? "file" : "files"}`;

  return createPortal(
    <>
      <div
      ref={summaryRef}
      className="session-changes-summary"
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
      onFocusCapture={openPopover}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
      }}
    >
      <button
        className="session-changes-tag"
        type="button"
        aria-label={countLabel}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={togglePinnedPopover}
        title={countLabel}
      >
        <FileEditIcon aria-hidden="true" />
        <span>{status === "loading" ? "…" : status === "error" ? "?" : totals.files}</span>
      </button>
      {isOpen && (
        <section className="session-changes-popover" role="dialog" aria-label="All session changes">
          <header className="session-changes-popover-header">
            <div>
              <strong>All session changes</strong>
              <span>{status === "ready" ? `${totals.files} ${totals.files === 1 ? "file" : "files"}` : countLabel}</span>
            </div>
            {status === "ready" && (totals.additions > 0 || totals.deletions > 0) && (
              <span className="session-changes-line-totals">
                {totals.additions > 0 && <span data-tone="add">+{totals.additions}</span>}
                {totals.deletions > 0 && <span data-tone="delete">−{totals.deletions}</span>}
              </span>
            )}
          </header>
          {status === "loading" ? (
            <p className="session-changes-popover-state">Loading changed files…</p>
          ) : status === "error" ? (
            <p className="session-changes-popover-state">Could not load the changed files. Hover again to retry.</p>
          ) : files.length === 0 ? (
            <p className="session-changes-popover-state">No file changes recorded for this session.</p>
          ) : (
            <ul className="session-changes-file-list">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    className="session-changes-file-trigger"
                    type="button"
                    title={`Open diff for ${file.path}`}
                    onClick={() => {
                      cancelClose();
                      setIsPinned(false);
                      setIsOpen(false);
                      setDiffFile({ path: file.path, kind: file.kind });
                    }}
                  >
                  <span className="session-changes-file-kind" data-operation={fileChangeTone(file.kind)}>{fileChangeLabel(file.kind)}</span>
                  <code title={file.movePath ? `${file.path} → ${file.movePath}` : file.path}>
                    {file.movePath ? `${compactFilePath(file.path)} → ${compactFilePath(file.movePath)}` : compactFilePath(file.path)}
                  </code>
                  {(file.additions > 0 || file.deletions > 0) && (
                    <span className="session-changes-file-lines">
                      {file.additions > 0 && <span data-tone="add">+{file.additions}</span>}
                      {file.deletions > 0 && <span data-tone="delete">−{file.deletions}</span>}
                    </span>
                  )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <footer>
            <button
              className="session-changes-annotate"
              type="button"
              onClick={() => {
                cancelClose();
                setIsPinned(false);
                setIsOpen(false);
                void openProjectFiles({ sessionId });
              }}
            >
              <MessageSquarePlus aria-hidden="true" />
              Add annotation in VS Code
            </button>
            <button
              className="session-changes-review"
              type="button"
              disabled={status !== "ready" || files.length === 0}
              onClick={() => void openSessionReview(sessionId)}
            >
              <FolderOpen aria-hidden="true" />
              Review all in VS Code
            </button>
          </footer>
        </section>
      )}
      </div>
      {diffFile && <SessionFileDiffPopup sessionId={sessionId} file={diffFile} onClose={() => setDiffFile(null)} />}
    </>,
    target
  );
}
