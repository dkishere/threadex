import { useState } from "react";
import { Copy, Reply } from "lucide-react";

/** Copy preserves source Markdown; Reply prepares context without sending. */
export function ChatMessageActions({ text, onReply, replyLabel = "Reply" }: { text: string; onReply?: () => void; replyLabel?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  if (!text.trim() && !onReply) return null;
  const label = copyState === "copied" ? "Message copied" : copyState === "error" ? "Could not copy message; retry" : "Copy message";
  return <div className="message-actions chat-message-actions">
    {text.trim() && <button type="button" className="message-action-icon" title={label} aria-label={label} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopyState("copied"); }
      catch { setCopyState("error"); }
    }}><Copy aria-hidden="true" /></button>}
    {onReply && <button type="button" className="message-action-icon" title={replyLabel} aria-label={replyLabel} onClick={onReply}><Reply aria-hidden="true" /></button>}
    <span className="chat-message-copy-status" role="status">{copyState === "idle" ? "" : label}</span>
  </div>;
}
