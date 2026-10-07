import { useEffect, useRef } from "react";
import type { ResponseAnnotation } from "./responseAnnotations";

export function useVsCodeAnnotationInbox(sessionId: string | null, enabled: boolean, receive: (annotation: ResponseAnnotation) => void) {
  const receiver = useRef(receive);
  receiver.current = receive;
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let stopped = false;
    let busy = false;
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/vscode-annotations`;
    const poll = async () => {
      if (busy || stopped || document.visibilityState !== "visible") return;
      busy = true;
      try {
        await navigator.locks.request(`threadex-vscode-inbox:${sessionId}`, async () => {
          if (stopped) return;
          const response = await fetch(base);
          if (!response.ok || stopped) return;
          const { annotations } = await response.json();
          if (stopped || !Array.isArray(annotations)) return;
          for (const item of annotations) {
            if (stopped) break;
            const key = `threadex-vscode-received:${item.id}`;
            if (!localStorage.getItem(key)) {
              receiver.current(item.annotation);
              localStorage.setItem(key, "1");
            }
            const ack = await fetch(`${base}/${encodeURIComponent(item.id)}`, { method: "DELETE" });
            if (!ack.ok) break;
          }
        });
      } catch {
        // Keep the durable backend item for the next successful poll.
      } finally { busy = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    window.addEventListener("focus", poll);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [sessionId, enabled]);
}
