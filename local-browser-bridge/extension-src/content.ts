type InjectedMapping = { urlPrefix: string; values: Record<string, unknown> };
type InjectionReceiver = { tabId: number; name: string };
type InjectionConfig = { enabled: boolean; tabId: number; mappings: InjectedMapping[]; receiver: InjectionReceiver | null };
type BridgeContext = Record<string, unknown>;
type ContextScreenshot = { key: string };
type StoredPageSnapshot = { key: string };

// Chrome may run this file once through the manifest and again while the
// background worker restores content scripts after an extension reload. Keep
// every runtime binding private to this evaluation so the second run does not
// conflict with the first script's global lexical declarations.
(() => {
const contentGlobal = globalThis as typeof globalThis & {
  __localBrowserBridgeContent?: { dispose(): void };
};
const contextKeyPrefix = "codex-browser-bridge:context:";
const receiverAttribute = "data-local-browser-bridge-context-receiver";
const injectionEvent = "local-browser-bridge:inject-context";
let active = true;
let menuHost: HTMLElement | undefined;
let highlightHost: HTMLElement | undefined;
let highlightedElement: Element | undefined;
const menuInteractionEvents = [
  "auxclick",
  "click",
  "dblclick",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseup",
  "pointerup",
  "pointercancel",
  "touchstart",
  "touchend",
  "touchcancel",
  "wheel"
] as const;

try { contentGlobal.__localBrowserBridgeContent?.dispose(); } catch { /* A reloaded extension invalidates the previous runtime object. */ }
for (const stale of document.querySelectorAll("[data-local-browser-bridge-menu],[data-local-browser-bridge-highlight],[data-codex-browser-bridge-menu]")) stale.remove();
const controller = { dispose };
contentGlobal.__localBrowserBridgeContent = controller;
chrome.runtime.onMessage.addListener(onExtensionMessage);
void initialize();

function dispose(): void {
  if (!active) return;
  active = false;
  try { chrome.runtime.onMessage.removeListener(onExtensionMessage); } catch { /* Previous extension runtime may already be invalid. */ }
  document.removeEventListener("contextmenu", onContextMenu, { capture: true });
  document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  document.removeEventListener("keydown", onKeyDown, { capture: true });
  closeMenu();
  if (contentGlobal.__localBrowserBridgeContent === controller) delete contentGlobal.__localBrowserBridgeContent;
}

function onExtensionMessage(message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): void {
  const record = message && typeof message === "object" && !Array.isArray(message) ? message as Record<string, unknown> : null;
  if (record?.type === "browserContextReceiver") {
    sendResponse({ name: document.documentElement.getAttribute(receiverAttribute) });
    return;
  }
  if (record?.type !== "injectBrowserContext") return;
  const receiverName = document.documentElement.getAttribute(receiverAttribute);
  const context = record.context;
  if (!receiverName || !context || typeof context !== "object" || Array.isArray(context)) {
    sendResponse({ ok: false });
    return;
  }
  document.dispatchEvent(new CustomEvent(injectionEvent, { detail: JSON.stringify(context) }));
  sendResponse({ ok: true });
}

async function initialize(): Promise<void> {
  try {
    const initial = await send<InjectionConfig>({ type: "pageInjectionConfig" });
    if (!active || !initial.enabled) return;
    document.addEventListener("contextmenu", onContextMenu, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });
  } catch {
    // Extension reloads and service-worker wakeups are retried by the next injection.
  }
}

function onContextMenu(event: MouseEvent): void {
  if (menuHost?.contains(event.target as Node)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (!event.shiftKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const element = event.target instanceof Element ? event.target : document.documentElement;
  void captureAndShowContextMenu(event.clientX, event.clientY, element);
}

async function captureAndShowContextMenu(x: number, y: number, element: Element): Promise<void> {
  closeMenu();
  let screenshot: ContextScreenshot | undefined;
  try {
    screenshot = await send<ContextScreenshot>({ type: "captureContextScreenshot" });
  } catch {
    // A denied or unavailable screenshot must not block page-context capture.
  }
  if (active) await showContextMenu(x, y, element.isConnected ? element : document.documentElement, screenshot);
}

function onPointerDown(event: PointerEvent): void {
  if (event.shiftKey && event.button === 2 && !menuHost?.contains(event.target as Node)) {
    // Stop the host page from turning a Shift+right-click gesture into a text
    // selection or another page-owned pointer interaction before contextmenu.
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (!menuHost) return;
  if (!menuHost.contains(event.target as Node)) {
    closeMenu();
    return;
  }
  // Let controls in the shadow tree receive focus. The host's own listeners
  // stop their events before they bubble into the page UI.
}

function onKeyDown(event: KeyboardEvent): void {
  if (!menuHost || event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeMenu();
}

async function showContextMenu(x: number, y: number, element: Element, screenshot?: ContextScreenshot): Promise<void> {
  closeMenu();
  showElementHighlight(element);
  const loading = createMenu(x, y);
  loading.shadowRoot?.append(createStatus("Loading page context…"));
  positionMenu(loading, x, y, element);
  try {
    const config = await send<InjectionConfig>({ type: "pageInjectionConfig" });
    if (!config.enabled) { closeMenu(); return; }
    const capturedContext = await captureContext(config, element, screenshot);
    const context = await send<BridgeContext>({ type: "enrichPageContext", context: capturedContext });
    const shadow = menuHost?.shadowRoot;
    if (!shadow) return;
    shadow.replaceChildren(menuStyle());
    const panel = document.createElement("section");
    panel.className = "panel";
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Add page context";
    const target = document.createElement("span");
    target.className = "target";
    target.textContent = describeElement(element);
    header.append(title, target);
    const label = document.createElement("label");
    label.textContent = "Comment (optional)";
    const comment = document.createElement("textarea");
    comment.rows = 3;
    comment.placeholder = "What should the agent look at?";
    comment.setAttribute("aria-label", "Comment (optional)");
    label.append(comment);
    const actions = document.createElement("div");
    actions.className = "actions";
    const contextWithComment = (): BridgeContext => {
      const value = comment.value.trim();
      return value ? { ...context, "user-comment": value } : context;
    };
    if (config.receiver) {
      const addLabel = `Add to ${config.receiver.name}`;
      actions.append(createButton(addLabel, async (button) => {
        setButtonState(button, "Adding…", true);
        try { await send({ type: "submitPageContext", context: contextWithComment(), receiverTabId: config.receiver!.tabId }); setButtonState(button, "Added", true); setTimeout(closeMenu, 500); }
        catch (error) { setButtonState(button, addLabel, false); showError(error); }
      }));
    }
    actions.append(createButton("Copy", async (button) => {
        setButtonState(button, "Copying…", true);
        try { await copyText(JSON.stringify(contextWithComment())); setButtonState(button, "Copied", true); setTimeout(closeMenu, 500); }
        catch (error) { setButtonState(button, "Copy", false); showError(error); }
    }));
    panel.append(header, label, actions);
    shadow.append(panel);
    positionMenu(menuHost, x, y, element);
  } catch (error) {
    const shadow = loading.shadowRoot;
    if (shadow) { shadow.replaceChildren(menuStyle()); shadow.append(createStatus(errorMessage(error))); }
  }
}

async function captureContext(config: InjectionConfig, element: Element, screenshot?: ContextScreenshot): Promise<BridgeContext> {
  const capturedAt = new Date().toISOString();
  const selector = cssPath(element);
  const elementMetadata = {
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    className: typeof element.className === "string" ? element.className : null,
    role: element.getAttribute("role"),
    ariaLabel: element.getAttribute("aria-label")
  };
  const pageValues = pageValuesForUrl(location.href, config.mappings);
  const contextKey = screenshot?.key ?? `${contextKeyPrefix}${config.tabId}:${crypto.randomUUID()}`;
  const snapshot = {
    kind: "browser-bridge-context-snapshot",
    capturedAt,
    tabId: config.tabId,
    url: location.href,
    title: document.title,
    selector,
    selectedText: (getSelection()?.toString().trim() || "").slice(0, 20_000),
    element: { ...elementMetadata, text: (element.textContent || "").trim().slice(0, 20_000), outerHTML: element.outerHTML.slice(0, 50_000) },
    ...(pageValues ? { "page-values": pageValues.values, "match-by-url": pageValues.matchedPrefixes } : {})
  };
  await send<StoredPageSnapshot>({ type: "storePageSnapshot", key: contextKey, snapshot });
  return {
    kind: "browser-bridge-context",
    capturedAt,
    tabId: config.tabId,
    url: location.href,
    title: document.title,
    selector,
    element: elementMetadata,
    "extension-context-key": contextKey,
    ...(pageValues ? { "page-values": pageValues.values, "match-by-url": pageValues.matchedPrefixes } : {})
  };
}

function pageValuesForUrl(url: string, mappings: InjectedMapping[]): { values: Record<string, unknown>; matchedPrefixes: string[] } | null {
  const values: Record<string, unknown> = {};
  const matchedPrefixes: string[] = [];
  for (const mapping of [...mappings].sort((left, right) => left.urlPrefix.length - right.urlPrefix.length)) {
    if (!url.startsWith(mapping.urlPrefix)) continue;
    matchedPrefixes.push(mapping.urlPrefix);
    Object.assign(values, mapping.values);
  }
  return Object.keys(values).length ? { values, matchedPrefixes } : null;
}

function cssPath(element: Element): string | null {
  const parts: string[] = [];
  for (let node: Element | null = element; node && parts.length < 8; node = node.parentElement) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    let part = node.tagName.toLowerCase();
    const siblings = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node!.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
  }
  return parts.join(" > ") || null;
}

function createMenu(x: number, y: number): HTMLElement {
  const host = document.createElement("div");
  host.dataset.localBrowserBridgeMenu = "1";
  Object.assign(host.style, { all: "initial", position: "fixed", zIndex: "2147483647", left: `${x}px`, top: `${y}px` });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(menuStyle());
  for (const eventName of menuInteractionEvents) {
    host.addEventListener(eventName, interceptMenuEvent);
  }
  document.documentElement.append(host);
  menuHost = host;
  return host;
}

function positionMenu(host: HTMLElement | undefined, x: number, y: number, element: Element): void {
  if (!host) return;
  const margin = 12;
  const gap = 10;
  const rect = host.getBoundingClientRect();
  const target = element.getBoundingClientRect();
  const clampLeft = (left: number) => Math.max(margin, Math.min(left, innerWidth - rect.width - margin));
  const clampTop = (top: number) => Math.max(margin, Math.min(top, innerHeight - rect.height - margin));
  const candidates = [
    { left: target.right + gap, top: clampTop(y) },
    { left: target.left - rect.width - gap, top: clampTop(y) },
    { left: clampLeft(x), top: target.bottom + gap },
    { left: clampLeft(x), top: target.top - rect.height - gap }
  ];
  const fits = ({ left, top }: { left: number; top: number }) => left >= margin && top >= margin && left + rect.width <= innerWidth - margin && top + rect.height <= innerHeight - margin;
  const overlapArea = ({ left, top }: { left: number; top: number }) =>
    Math.max(0, Math.min(left + rect.width, target.right) - Math.max(left, target.left)) *
    Math.max(0, Math.min(top + rect.height, target.bottom) - Math.max(top, target.top));
  const fallbacks = candidates
    .map(({ left, top }) => ({ left: clampLeft(left), top: clampTop(top) }))
    .sort((left, right) => overlapArea(left) - overlapArea(right));
  const position = candidates.find(fits) ?? fallbacks[0];
  host.style.left = `${position.left}px`;
  host.style.top = `${position.top}px`;
}

function interceptMenuEvent(event: Event): void {
  // Let the target button handle its own event first, then prevent it from
  // reaching the page UI outside this extension-owned shadow tree.
  event.stopPropagation();
}

function menuStyle(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `:host{display:block;width:min(340px,calc(100vw - 24px));color:#e8eaed;font:13px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.panel,.status{box-sizing:border-box;background:#202124;border:1px solid #5f6368;border-radius:12px;box-shadow:0 18px 48px #0009}.panel{padding:14px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}strong{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;color:#fff}.target{max-width:155px;overflow:hidden;color:#9aa0a6;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}label{display:grid;gap:7px;color:#bdc1c6;font-size:12px}textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;padding:9px 10px;color:#f1f3f4;background:#292a2d;border:1px solid #5f6368;border-radius:7px;outline:none;font:13px/1.4 inherit}textarea:focus{border-color:#8ab4f8;box-shadow:0 0 0 2px #8ab4f833}textarea::placeholder{color:#80868b}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}button{min-width:0;padding:8px 12px;color:#e8eaed;background:#3c4043;border:1px solid transparent;border-radius:7px;font:600 13px inherit;cursor:pointer}button:first-child{color:#202124;background:#8ab4f8}button:hover{filter:brightness(1.12)}button:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}button:disabled{cursor:default;filter:none;opacity:.72}.status{max-width:280px;padding:12px 14px}`;
  return style;
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const className = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean)[0] : "";
  return `${element.tagName.toLowerCase()}${id}${!id && className ? `.${className}` : ""}`;
}

function showElementHighlight(element: Element): void {
  highlightedElement = element;
  const host = document.createElement("div");
  host.dataset.localBrowserBridgeHighlight = "1";
  Object.assign(host.style, { all: "initial", position: "fixed", inset: "0", zIndex: "2147483646", pointerEvents: "none" });
  const shadow = host.attachShadow({ mode: "open" });
  const indicator = document.createElement("div");
  indicator.className = "indicator";
  const badge = document.createElement("span");
  badge.textContent = describeElement(element);
  indicator.append(badge);
  const style = document.createElement("style");
  style.textContent = `.indicator{position:fixed;box-sizing:border-box;border:2px solid #8ab4f8;border-radius:4px;background:#8ab4f81f;box-shadow:0 0 0 1px #20212499,0 0 18px #8ab4f855;transition:inset .06s linear}.indicator span{position:absolute;left:-2px;bottom:100%;max-width:240px;overflow:hidden;padding:3px 6px;color:#202124;background:#8ab4f8;border-radius:4px 4px 4px 0;font:600 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}`;
  shadow.append(style, indicator);
  document.documentElement.append(host);
  highlightHost = host;
  updateElementHighlight();
  addEventListener("scroll", updateElementHighlight, true);
  addEventListener("resize", updateElementHighlight);
}

function updateElementHighlight(): void {
  const indicator = highlightHost?.shadowRoot?.querySelector<HTMLElement>(".indicator");
  if (!indicator || !highlightedElement?.isConnected) return;
  const rect = highlightedElement.getBoundingClientRect();
  Object.assign(indicator.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const badge = indicator.querySelector<HTMLElement>("span");
  if (badge) Object.assign(badge.style, rect.top < 28 ? { top: "0", bottom: "auto" } : { top: "auto", bottom: "100%" });
}

function createButton(label: string, action: (button: HTMLButtonElement) => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = label;
  button.addEventListener("click", () => void action(button));
  return button;
}
function createStatus(text: string): HTMLDivElement { const status = document.createElement("div"); status.className = "status"; status.textContent = text; return status; }
function setButtonState(button: HTMLButtonElement, text: string, disabled: boolean): void { button.textContent = text; button.disabled = disabled; }
function closeMenu(): void {
  menuHost?.remove(); menuHost = undefined;
  highlightHost?.remove(); highlightHost = undefined; highlightedElement = undefined;
  removeEventListener("scroll", updateElementHighlight, true);
  removeEventListener("resize", updateElementHighlight);
}
function showError(error: unknown): void { window.alert(`Local Browser Bridge: ${errorMessage(error)}`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement("textarea");
  textarea.value = value; textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea); textarea.select();
  const copied = document.execCommand("copy"); textarea.remove();
  if (!copied) throw new Error("Clipboard access was denied.");
}

async function send<T = unknown>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as { ok?: boolean; result?: T; error?: string };
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response.result as T;
}
})();
