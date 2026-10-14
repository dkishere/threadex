import type { AcpMessage } from "../server/acp";

export const ACP_PREVIEW_CHANNEL = "threadex-acp-v1";

// Only the selected preview window may send prompts, and only to its bound
// session. The parent UI explicitly enables this bridge before it is attached.
export function attachAcpPreviewBridge(source: Window, session: { id: string; cwd: string }) {
  const connection = crypto.randomUUID();
  const requests = new Set<AbortController>();
  const post = (message: AcpMessage) => source.postMessage({ channel: ACP_PREVIEW_CHANNEL, message }, "*");
  const ready = () => source.postMessage({ channel: ACP_PREVIEW_CHANNEL, session }, "*");
  const listener = async (event: MessageEvent) => {
    if (event.source !== source || event.data?.channel !== ACP_PREVIEW_CHANNEL) return;
    if (event.data.discover === true) { ready(); return; }
    const message = event.data.message as AcpMessage | undefined;
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
    if (!["initialize", "session/resume", "session/prompt", "session/cancel"].includes(message.method) ||
      (message.method !== "initialize" && message.params?.sessionId !== session.id) ||
      (message.method === "session/resume" && message.params?.cwd !== session.cwd)) {
      if (message.id !== undefined) post({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "This preview is bound to its source session." } });
      return;
    }
    const abort = new AbortController();
    requests.add(abort);
    try {
      const response = await fetch("/api/acp", { method: "POST", credentials: "same-origin", signal: abort.signal,
        headers: { "Content-Type": "application/json", "X-Threadex-ACP-Connection": connection }, body: JSON.stringify(message) });
      if (!response.ok) throw new Error(`Feedback connection failed (HTTP ${response.status}).`);
      if (!response.body) throw new Error("Feedback stream is unavailable.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", responded = message.id === undefined;
      const row = (line: string) => {
        if (!line.trim()) return;
        const reply = JSON.parse(line) as AcpMessage;
        if (reply.id === message.id && ("result" in reply || "error" in reply)) responded = true;
        post(reply);
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          row(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode(); row(buffer);
      if (!responded) throw new Error("Feedback connection ended before completion. Check the saved turn before retrying.");
    } catch (error) {
      if (!abort.signal.aborted && message.id !== undefined) post({ jsonrpc: "2.0", id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : "Feedback delivery failed." } });
    } finally { requests.delete(abort); }
  };
  window.addEventListener("message", listener);
  ready();
  return () => {
    window.removeEventListener("message", listener);
    for (const request of requests) request.abort();
    source.postMessage({ channel: ACP_PREVIEW_CHANNEL, disconnected: true }, "*");
  };
}
