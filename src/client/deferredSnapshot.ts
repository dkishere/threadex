type SnapshotHost = Pick<Window, "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"> &
  Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">>;

// The server owns the durable transcript. This is only the browser's startup
// cache: never serialize its tool history for every streamed character.
export function deferSnapshotWrite(write: () => void, host: SnapshotHost = window, page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document) {
  let idle: number | undefined;
  let written = false;
  const flush = () => {
    host.clearTimeout(timer);
    if (idle !== undefined) host.cancelIdleCallback?.(idle);
    if (!written) { written = true; write(); }
  };
  const timer = host.setTimeout(() => {
    if (host.requestIdleCallback) idle = host.requestIdleCallback(flush, { timeout: 2000 });
    else flush();
  }, 500);
  const onVisibility = () => { if (page.visibilityState === "hidden") flush(); };
  host.addEventListener("pagehide", flush);
  page.addEventListener("visibilitychange", onVisibility);
  return () => {
    host.clearTimeout(timer);
    if (idle !== undefined) host.cancelIdleCallback?.(idle);
    host.removeEventListener("pagehide", flush);
    page.removeEventListener("visibilitychange", onVisibility);
  };
}
