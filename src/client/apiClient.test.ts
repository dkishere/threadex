import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, apiJson } from "./apiClient";

test("simultaneous reads share a request but cancel independently", async (t) => {
  let finish!: (response: Response) => void;
  let transportSignal: AbortSignal | undefined;
  const fetch = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    transportSignal = init.signal ?? undefined;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = apiJson("/api/shared", { signal: first.signal });
  const remaining = apiJson("/api/shared", { signal: second.signal });
  assert.equal(fetch.mock.callCount(), 1);
  first.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(transportSignal?.aborted, false);
  finish(Response.json({ value: 1 }));
  assert.deepEqual(await remaining, { value: 1 });
});

test("abandoned reads abort the transport, while immediate remounts reuse it", async (t) => {
  const signals: AbortSignal[] = [];
  const fetch = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  const first = new AbortController();
  const second = new AbortController();
  const abandoned = apiJson("/api/remount", { signal: first.signal });
  first.abort();
  const remounted = apiJson("/api/remount", { signal: second.signal });
  await assert.rejects(abandoned, { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(signals[0].aborted, false);
  second.abort();
  await assert.rejects(remounted, { name: "AbortError" });
  assert.equal(signals[0].aborted, true);
});

test("writes are never deduplicated and recovery reads bypass older requests", async (t) => {
  let finishOld!: (response: Response) => void;
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    if (++calls === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
    return Promise.resolve(Response.json({ method: init.method }));
  });
  const old = apiJson("/api/revision");
  await Promise.all([
    apiJson("/api/revision", { method: "POST", body: { action: "save" } }),
    apiJson("/api/revision", { method: "POST", body: { action: "save" } }),
    apiJson("/api/revision", { fresh: true })
  ]);
  assert.equal(fetch.mock.callCount(), 4);
  finishOld(Response.json({ revision: 1 }));
  await old;
  await apiJson("/api/revision");
  assert.equal(fetch.mock.callCount(), 5, "completed reads are not cached");
});

test("HTTP errors retain status, non-JSON failures remain readable, and failed reads can retry", async (t) => {
  const responses = [
    Response.json({ error: "Changed elsewhere" }, { status: 409 }),
    new Response("<html>Offline</html>", { status: 502 }),
    Response.json({ recovered: true })
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift()!);
  await assert.rejects(apiJson("/api/retry"), error => error instanceof ApiError && error.status === 409 && error.message === "Changed elsewhere");
  await assert.rejects(apiJson("/api/retry"), error => error instanceof ApiError && error.status === 502 && error.message === "API returned 502");
  assert.deepEqual(await apiJson("/api/retry"), { recovered: true });
});
