export function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// Keep navigation inside a child frame so the app and its draft stay mounted.
export function createLinkPreview(title: string, htmlPreview = false) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", title);
  dialog.style.cssText = "position:fixed;inset:0;margin:0;padding:0;border:0;border-radius:0;width:100%;max-width:none;height:100dvh;max-height:none;overflow:hidden;background:white;color:#0f172a";
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
  const header = document.createElement("header");
  header.style.cssText = "display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:8px;min-height:32px;padding:env(safe-area-inset-top,0px) max(8px,env(safe-area-inset-right)) 0 max(8px,env(safe-area-inset-left));border-bottom:1px solid #cbd5e1;font:12px/1.2 system-ui,sans-serif";
  const label = document.createElement("strong");
  label.textContent = title;
  label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500";
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-shrink:0;align-items:center";
  let previewFrame: HTMLIFrameElement | null = null;
  const refresh = previewIconButton("Refresh preview", "M20 7v5h-5 M20 12a8 8 0 1 0-2.34 5.66 M20 7l-2.34-2.66");
  refresh.disabled = true;
  refresh.onclick = () => {
    if (!previewFrame) return;
    try {
      previewFrame.contentWindow?.location.reload();
    } catch {
      // Sandboxed HTML and cross-origin editors cannot be accessed directly.
      previewFrame.src = previewFrame.src;
    }
  };
  const close = previewIconButton("Close preview", "M6 6l12 12 M6 18L18 6");
  close.onclick = () => dialog.close();
  actions.append(refresh, close);
  header.append(label, actions);
  const status = document.createElement("p");
  status.textContent = "Loading…";
  status.style.padding = "12px";
  container.append(header, status);
  dialog.append(container);
  document.body.append(dialog);
  let closed = false;
  dialog.addEventListener("close", () => {
    closed = true;
    dialog.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
  }, { once: true });
  dialog.showModal();
  return {
    close: () => dialog.close(),
    navigate(url: string) {
      if (closed) return;
      const frame = document.createElement("iframe");
      frame.title = title;
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", htmlPreview ? "allow-scripts" : "allow-scripts allow-same-origin allow-forms allow-downloads allow-popups");
      frame.style.cssText = "width:100%;flex:1;min-height:0;border:0;background:white";
      frame.src = url;
      status.replaceWith(frame);
      previewFrame = frame;
      refresh.disabled = false;
    }
  };
}

function previewIconButton(label: string, path: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.style.cssText = "display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  icon.append(shape);
  button.append(icon);
  return button;
}

export function createProjectViewer() {
  if (isStandaloneApp()) return createLinkPreview("Web VS Code");
  const popup = window.open("about:blank", "_blank");
  if (!popup) return null;
  popup.opener = null;
  return { close: () => popup.close(), navigate: (url: string) => { popup.location.replace(url); } };
}
