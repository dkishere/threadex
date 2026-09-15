export type BrowserBridgeContextElement = {
  tagName?: string | null;
  id?: string | null;
  className?: string | null;
  role?: string | null;
  ariaLabel?: string | null;
};

export type BrowserBridgeReactComponent = {
  name: string;
  source?: string;
};

export type BrowserBridgeContext = {
  kind: "browser-bridge-context";
  capturedAt?: string;
  tabId: number;
  url: string;
  title?: string;
  selector?: string | null;
  element?: BrowserBridgeContextElement;
  /** Shared key for the page snapshot and WebP capture in current extension storage. */
  "extension-context-key"?: string;
  /** Page snapshot key emitted by earlier extension releases. */
  "extension-page-snapshot-key"?: string;
  /** WebP screenshot key emitted by earlier extension releases. */
  "extension-webp-screenshot-key"?: string;
  /** Page-local snapshot key emitted by the original content-script implementation. */
  "localstorage-page-snapshot-key"?: string;
  /** Values configured for the URL prefix(es) that matched this captured page. */
  "page-values"?: Record<string, unknown>;
  /** Every configured URL prefix that matched, from broadest to most specific. */
  "match-by-url"?: string[];
  /** Best-effort DOM-to-React metadata, captured without props or hook state. */
  "react-components"?: BrowserBridgeReactComponent[];
};

export function parseBrowserBridgeContext(value: string): BrowserBridgeContext | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value.trim());
  } catch {
    return null;
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "browser-bridge-context") return null;
  if (!Number.isInteger(record.tabId) || (record.tabId as number) < 0) return null;
  if (typeof record.url !== "string" || !isHttpUrl(record.url)) return null;
  if (!hasSnapshotReference(record)) return null;

  return candidate as BrowserBridgeContext;
}

function hasSnapshotReference(record: Record<string, unknown>) {
  return [
    "extension-context-key",
    "extension-page-snapshot-key",
    "extension-webp-screenshot-key",
    "localstorage-page-snapshot-key"
  ].some((key) => typeof record[key] === "string" && record[key].trim().length > 0);
}

export function browserBridgeContextAttachmentName(context: BrowserBridgeContext) {
  return `browser-bridge-context-${context.tabId}.json`;
}

export function browserBridgeContextTitle(context: BrowserBridgeContext) {
  const title = typeof context.title === "string" ? context.title.trim() : "";
  if (title) return title;
  try {
    return new URL(context.url).host;
  } catch {
    return context.url;
  }
}

export function browserBridgeContextDetail(context: BrowserBridgeContext) {
  const selector = typeof context.selector === "string" ? context.selector.trim() : "";
  return selector ? `Tab ${context.tabId} · ${selector}` : `Tab ${context.tabId}`;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
