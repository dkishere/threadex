export const browserContextReceiverAttribute = "data-local-browser-bridge-context-receiver";
export const browserContextInjectionEvent = "local-browser-bridge:inject-context";
export const threadexBrowserContextReceiverName = "Threadex";

export function registerBrowserContextReceiver(
  name: string,
  receive: (context: Record<string, unknown>) => void
) {
  const receiverName = name.trim().slice(0, 120) || "Agent";
  document.documentElement.setAttribute(browserContextReceiverAttribute, receiverName);

  const onContext = (event: Event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
    try {
      const context = JSON.parse(event.detail) as unknown;
      if (!context || typeof context !== "object" || Array.isArray(context)) return;
      // This event is an extension-to-app transport, not a page UI event.
      // Do not let unrelated document listeners react to it as well.
      event.stopImmediatePropagation();
      receive(context as Record<string, unknown>);
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
