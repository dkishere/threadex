import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnGrillActivityLogHandler, createTurnGrillHandler } from "./turnGrillRoute";
import { startAutoGrill, waitForRunningGrill } from "./loopMode";
import { turnGrillEffort } from "./turnGrill";
import type { SessionStore } from "./sessionStore";
import type { TurnGrill } from "../turnGrill";

test("the promoted long-turn griller uses xhigh effort", () => {
  assert.equal(turnGrillEffort(true), "xhigh");
  assert.equal(turnGrillEffort(false), "max");
});

test("a running Grill checkpoints provider event counts and serves its activity log", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "grill-activity-"));
  let saved: TurnGrill | null = null;
  const session = { id: "s", workspaceId: "w", cwd: "", accountId: null };
  const turn = { id: "t", sessionId: "s", status: "done", userInput: "Review", agentResponse: "Done", tokenIn: 0, tokenOut: 0 };
  const store = {
    getSession: async () => session, getSessionTurn: async () => turn,
    getTurnGrill: async () => saved,
    saveTurnGrill: async (_session: string, _turn: string, revision: number, next: TurnGrill) => {
      if ((saved?.revision ?? 0) !== revision) return false;
      saved = structuredClone(next); return true;
    },
    getWorkspace: async () => ({ id: "w", codexHome: "/unused" }),
    listSessionTurnLiveItems: async () => [], listSessionSteerMessages: async () => ({}),
    listSessionApprovalLiveItems: async () => ({}), listSessionTurns: async () => [turn]
  } as unknown as SessionStore;
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  let emitted!: () => void;
  const eventsSent = new Promise<void>((done) => { emitted = done; });
  const handler = createTurnGrillHandler({ sessionStore: store, serverUrl: "http://unused", recordUsage: async () => {}, logDir,
    runGrill: async (_home, _prompt, _session, _url, _total, _turnId, _long, options) => {
      options?.onEvent?.("codex", { method: "item/started" });
      options?.onEvent?.("codex", { method: "item/reasoning/delta", delta: "private" });
      emitted(); await gate;
      return { responseText: JSON.stringify([{ id: "q1", md: "Question", responseMd: "", status: "open" }]), usage: null, authIdentity: { externalAccountId: null, externalUserId: null } };
    } });
  const app = express(); app.use(express.json());
  app.get("/:sessionId/:turnId/grill/attempts/:attemptId/log", createTurnGrillActivityLogHandler({ sessionStore: store, logDir }));
  app.get("/:sessionId/:turnId/grill", handler); app.post("/:sessionId/:turnId/grill", handler);
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/s/t/grill`;
  try {
    const request = fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await eventsSent;
    // The first checkpoint is written as soon as the run starts.
    const current = () => saved as TurnGrill | null;
    while (!current()?.activity) await new Promise((done) => setTimeout(done, 10));
    const running = (await (await fetch(url)).json()).grill as TurnGrill;
    assert.equal(running.status, "running");
    assert.equal(running.activity?.status, "running");
    release();
    assert.equal((await request).status, 200);
    const ready = (await (await fetch(url)).json()).grill as TurnGrill;
    assert.equal(ready.status, "ready");
    assert.equal(ready.activity?.status, "done");
    // run.started, two provider events and run.done.
    assert.equal(ready.activity?.eventCount, 4);
    const log = await (await fetch(`${url}/attempts/${ready.activity!.id}/log`)).text();
    assert.match(log, /codex\.item\/started/);
    assert.doesNotMatch(log, /private/);
    assert.equal((await fetch(`${url}/attempts/00000000-0000-0000-0000-000000000000/log`)).status, 404);
    // A lost worker marks its running activity interrupted.
    saved = { ...ready, status: "running", activity: { ...ready.activity!, status: "running" } };
    const recovered = (await (await fetch(url)).json()).grill as TurnGrill;
    assert.equal(recovered.status, "error");
    assert.equal(recovered.activity?.status, "interrupted");
  } finally {
    release(); await new Promise<void>((done) => server.close(() => done()));
    await rm(logDir, { recursive: true, force: true });
  }
});

const review = (status: TurnGrill["status"]): TurnGrill => ({ revision: 1, status, updated: "2026-10-25", issues: [], rounds: [], error: null, automatic: true });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("Auto Grill follows a review that outlives the start request instead of failing", async () => {
  const states = ["running", "running", "ready"] as const;
  const calls: string[] = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "POST") throw new TypeError("fetch failed");
    return json({ grill: review(states[calls.filter((call) => call === "GET").length - 1]) });
  }) as typeof fetch;
  const result = await startAutoGrill("http://x/grill", 0, { fetch: fakeFetch, sleep: async () => {} });
  assert.equal(result?.status, "ready");
  assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
});

test("Auto Grill waits on an already-running review (HTTP 409) and stops only on lost workers or shutdown", async () => {
  let gets = 0;
  const conflict = (async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? json({ error: "This turn is already being checked." }, 409)
    : json({ grill: review(++gets < 2 ? "running" : "ready") })) as typeof fetch;
  assert.equal((await startAutoGrill("http://x/grill", 1, { fetch: conflict, sleep: async () => {} }))?.status, "ready");
  // The Grill GET reports a lost worker as an error; waiting ends there.
  const lost = (async () => json({ grill: review("error") })) as typeof fetch;
  assert.equal((await waitForRunningGrill("http://x/grill", { fetch: lost }))?.status, "error");
  await assert.rejects(waitForRunningGrill("http://x/grill", { fetch: lost, stopped: () => true }), /shutting down/);
  const broken = (async (_url: string, init?: RequestInit) => json({ error: "boom" }, init?.method === "POST" ? 500 : 200)) as typeof fetch;
  await assert.rejects(startAutoGrill("http://x/grill", 1, { fetch: broken }), /HTTP 500/);
});
