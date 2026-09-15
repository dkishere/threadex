import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, History, X } from "lucide-react";
import type { GrillRound } from "../turnGrill";
import { MarkdownContent } from "./MarkdownContent";

const labels = { start: "Initial questions", respond: "Thread response", followup: "Re-grill", save: "Question changes" };

export function GrillHistoryDialog({ id, rounds, onClose }: { id: string; rounds: GrillRound[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} id={id} className="turn-grill grill-history-dialog" aria-labelledby={`${id}-title`}
    onCancel={onClose} onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="grill-history-dialog-header"><div><History size={17} aria-hidden="true" /><h2 id={`${id}-title`}>Review history</h2></div>
      <button type="button" className="grill-icon-button" aria-label="Close review history" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="grill-history">{[...rounds].reverse().map((round, index) => <details key={round.id} open={index === 0}>
      <summary><ChevronDown size={13} /><strong>{labels[round.action]}</strong><time>{new Date(round.created).toLocaleString()}</time></summary>
      <div className="grill-history-round">
        {round.prompt && <div className="grill-round-prompt"><MarkdownContent>{round.prompt}</MarkdownContent></div>}
        {round.issues.map((issue, issueIndex) => <div key={issue.id} data-dropped={issue.dropped ? "true" : undefined}>
          <span className="grill-history-index">Question {issueIndex + 1}{issue.dropped ? " · Dropped" : issue.status === "resolved" ? " · Satisfied" : issue.selected ? " · Selected" : ""}</span>
          <MarkdownContent>{issue.md}</MarkdownContent>
          {issue.responseMd && <div className="grill-round-prompt"><MarkdownContent>{issue.responseMd}</MarkdownContent></div>}
        </div>)}
      </div>
    </details>)}</div>
  </dialog>, document.body);
}
