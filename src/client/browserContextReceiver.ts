export const browserContextReceiverAttribute = "data-local-browser-bridge-context-receiver";
export const browserContextInjectionEvent = "local-browser-bridge:inject-context";
export const browserContextInjectionResultEvent = "local-browser-bridge:inject-context-result";
export const threadexBrowserContextReceiverName = "Threadex";

export function registerBrowserContextReceiver(
  name: string,
  receive: (context: Record<string, unknown>) => void | Promise<void>
) {
  const receiverName = name.trim().slice(0, 120) || "Agent";
  document.documentElement.setAttribute(browserContextReceiverAttribute, receiverName);

  const onContext = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    try {
      const request = JSON.parse(event.detail) as { requestId?: unknown; context?: unknown };
      if (!request || typeof request.requestId !== "string" || !request.requestId ||
          !request.context || typeof request.context !== "object" || Array.isArray(request.context)) return;
      // This event is an extension-to-app transport, not a page UI event.
      // Do not let unrelated document listeners react to it as well.
      event.stopImmediatePropagation();
      void Promise.resolve().then(() => receive(request.context as Record<string, unknown>)).then(
        () => document.dispatchEvent(new CustomEvent(browserContextInjectionResultEvent, { detail: JSON.stringify({ requestId: request.requestId, ok: true }) })),
        (error) => document.dispatchEvent(new CustomEvent(browserContextInjectionResultEvent, { detail: JSON.stringify({ requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }) }))
      );
    } catch {
      // Ignore malformed extension messages.
    }
  };

  document.addEventListener(browserContextInjectionEvent, onContext);
  return () => {
    document.removeEventListener(browserContextInjectionEvent, onContext);
    if (document.documentElement.getAttribute(browserContextReceiverAttribute) === receiverName) {
      document.documentElement.removeAttribute(browserContextReceiverAttribute);
    }
  };
}
