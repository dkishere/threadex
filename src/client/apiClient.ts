export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  fresh?: boolean;
};

type PendingRead = {
  promise: Promise<unknown>;
  controller: AbortController;
  readers: number;
};

const pendingReads = new Map<string, PendingRead>();

async function request<T>(url: string, options: ApiOptions): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    cache: "no-store",
    signal: options.signal,
    ...(options.body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body)
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(typeof body?.error === "string" && body.error.trim()
      ? body.error : `API returned ${response.status}`, response.status);
  }
  if (body === null) throw new Error("The server returned an incomplete JSON response.");
  return body as T;
}

// Share simultaneous reads only. Mutations and explicit recovery reads must
// never reuse a response from before a write, and completed reads are not cached.
export function apiJson<T>(url: string, options: ApiOptions = {}): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  if ((options.method ?? "GET") !== "GET" || options.fresh) return request<T>(url, options);

  let pending = pendingReads.get(url);
  if (!pending) {
    const controller = new AbortController();
    pending = { controller, readers: 0, promise: request(url, { ...options, signal: controller.signal }) };
    pendingReads.set(url, pending);
    const entry = pending;
    const cleanup = () => { if (pendingReads.get(url) === entry) pendingReads.delete(url); };
    void entry.promise.then(cleanup, cleanup);
  }
  const entry = pending;
  entry.readers++;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", abort);
      entry.readers--;
      // A StrictMode effect can resubscribe in the same task.
      queueMicrotask(() => {
        if (entry.readers === 0 && pendingReads.get(url) === entry) {
          pendingReads.delete(url);
          entry.controller.abort();
        }
      });
      return true;
    };
    const abort = () => { if (release()) reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      value => { if (release()) resolve(value as T); },
      error => { if (release()) reject(error); }
    );
  });
}
