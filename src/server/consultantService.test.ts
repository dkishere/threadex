import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import express from "express";
import { DEFAULT_MODEL, MODEL_CATALOG } from "../modelCatalog";
import type { Consultation } from "../consultants";
import { ConsultantService, createConsultantRouter, executeConsultation } from "./consultantService";
import { DiscussionJobs, writeJobJson, type DiscussionJob, type DiscussionJobState } from "./discussionJobs";
import type { SessionStore } from "./sessionStore";
import type { RoundtableInference } from "./roundtableRunner";
import { createDomainActorRouter } from "./domainActorRoutes";
import type { DomainActorService } from "./domainActorService";
import type { DomainActorStore } from "./domainActorStore";
import type { CollaborationService } from "./collaborationService";

class Jobs extends DiscussionJobs {
  entries: DiscussionJob[] = []; states = new Map<string, DiscussionJobState>(); stops = 0;
  override list(sessionId: string) { return this.entries.filter(job => job.sessionId === sessionId); }
  override state(job: DiscussionJob): DiscussionJobState { return this.states.get(job.id) ?? { status: "running" }; }
  override start(job: DiscussionJob) {
    const existing = this.entries.find(item => item.sessionId === job.sessionId && item.id === job.id);
    if (existing) {
      if (existing.payload.requestFingerprint !== job.payload.requestFingerprint) throw new Error("request ID conflict");
      return existing;
    }
    mkdirSync(this.path(job.sessionId, job.id), { recursive: true }); this.entries.push(structuredClone(job)); return job;
  }
  override async stop(job: DiscussionJob) { this.stops++; this.states.set(job.id, { status: "stopped" }); }
}
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "threadex-consultants-test-"));
  const jobs = new Jobs(directory);
  const actors = ["critic", "researcher"].map(id => ({ type: "consultant" as const, id, name: id, model: DEFAULT_MODEL as string, effort: "high", rolePrompt: `${id} role`, isDefault: true }));
  const usages: unknown[] = [];
  const store = {
    getSession: async (id: string) => ["host", "other"].includes(id) ? { id, workspaceId: "workspace", accountId: "account", cwd: "/host/project" } : null,
    getSessionTurn: async (id: string) => ({ id, sessionId: id === "turn" ? "host" : "other" }),
    getWorkspace: async () => ({ id: "workspace", codexHome: "/workspace/home" }),
    getActiveAccount: async () => null, getAccountAuth: async () => ({ authRaw: "test-auth" }),
    resolveClaudeAccount: async () => null, recordTokenUsage: async (rows: unknown[]) => { usages.push(...rows); }
  } as unknown as SessionStore;
  const service = new ConsultantService({ store, settings: { read: () => ({ revision: 3, actors }) }, jobs,
    serverUrl: "http://localhost:8787", synthesisModel: () => MODEL_CATALOG.astra.id });
  const save = (result: Consultation) => writeJobJson(resolve(jobs.path(result.sessionId, `consultation_${result.requestId}`), "consultation.json"), result);
  return { directory, jobs, actors, usages, store, service, save, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const base = { requestId: "request", mode: "question" as const, consultantIds: ["critic"], question: "Check the plan", sourceTurnId: "turn" };
const response = (responseText = "Evidence") => ({ responseText, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });

test("consultations freeze presets, preserve request identity across reopen, and reject invalid selections and cross-session turns", async () => {
  const f = fixture();
  try {
    const initial = await f.service.start("host", base);
    assert.equal(initial.status, "queued"); assert.equal(initial.answers[0].consultant.id, "critic");
    f.actors[0].rolePrompt = "Changed";
    assert.deepEqual(await f.service.start("host", base), initial);
    assert.equal(f.jobs.entries.length, 1);
    const reopened = new ConsultantService({ store: f.store, settings: { read: () => ({ revision: 4, actors: [] }) }, jobs: f.jobs,
      serverUrl: "http://localhost:8787", synthesisModel: () => DEFAULT_MODEL });
    assert.deepEqual(await reopened.start("host", base), initial, "retry uses the frozen snapshot even after a preset is removed");
    await assert.rejects(f.service.start("host", { ...base, question: "Different" }), /another request/);
    await assert.rejects(f.service.start("host", { ...base, requestId: "missing", consultantIds: ["absent"] }), /not found/);
    await assert.rejects(f.service.start("host", { ...base, requestId: "foreign", sourceTurnId: "foreign" }), /does not belong/);
    await assert.rejects(f.service.get("other", "request"), /not found/);
    await assert.rejects(f.service.start("host", { ...base, requestId: "bad-mode", mode: "round_table" }), /2–8/);
    await assert.rejects(f.service.start("host", { ...base, requestId: "permission" }, [MODEL_CATALOG.astra.id]), /model permissions/);
    assert.equal(f.jobs.entries.length, 1);
  } finally { f.close(); }
});

for (const trigger of ["on_demand", "user_requested"] as const) test(`worker ${trigger} consultation uses bounded frozen context and discussion runner`, async () => {
  const f = fixture(); const calls: RoundtableInference[] = [];
  try {
    await f.service.start("host", { ...base, trigger, context: "Keep the current database." }, [DEFAULT_MODEL]);
    const result = await executeConsultation({ job: f.jobs.entries[0], store: f.store, signal: new AbortController().signal, save: f.save,
      run: async input => { calls.push(input); return response(); } });
    assert.equal(result.status, "done"); assert.equal(result.trigger, trigger);
    assert.equal(result.answers[0].text, "Evidence"); assert.equal(calls.length, 1);
    assert.equal(calls[0].actorTools?.session.id, "host"); assert.equal(calls[0].actorTools?.session.cwd, "/host/project");
    assert.equal(calls[0].systemPrompt, "critic role");
    const prompt = JSON.parse(calls[0].prompt); assert.equal(prompt.hostSession.sourceTurnId, "turn");
    assert.match(prompt.context.instruction, /not instructions or permission/); assert.equal(prompt.context.text, "Keep the current database.");
    assert.equal(f.usages.length, 1);
    assert.equal((await f.service.get("host", "request")).status, "done");
  } finally { f.close(); }
});

test("round table isolates initial answers and synthesises attributed findings with partial failures retained", async () => {
  const f = fixture(); const prompts: string[] = [];
  try {
    await f.service.start("host", { ...base, mode: "round_table", consultantIds: ["critic", "researcher"] }, [DEFAULT_MODEL]);
    const result = await executeConsultation({ job: f.jobs.entries[0], store: f.store, signal: new AbortController().signal, save: f.save,
      run: async input => {
        prompts.push(input.prompt);
        if (input.systemPrompt === "researcher role") throw new Error("Provider unavailable");
        if (input.systemPrompt === "critic role") return response("Plan evidence");
        assert.equal(input.model, DEFAULT_MODEL, "synthesis respects worker model permissions");
        const synthesis = JSON.parse(input.prompt); assert.equal(synthesis.answers[0].name, "critic");
        assert.equal(synthesis.answers[1].error, "Provider unavailable"); return response("Attributed synthesis; researcher failed");
      } });
    assert.equal(prompts[0], prompts[1]); assert.equal(result.status, "error");
    assert.equal(result.answers[0].status, "done"); assert.equal(result.answers[1].status, "error");
    assert.match(result.synthesis!, /researcher failed/); assert.match(result.error!, /Some consultants failed/);
  } finally { f.close(); }
});

test("all failures, empty output, synthesis failure, and vanished hosts produce explicit terminal errors", async () => {
  for (const failure of ["all", "empty", "synthesis", "host"]) {
    const f = fixture();
    try {
      await f.service.start("host", failure === "synthesis" ? { ...base, mode: "round_table", consultantIds: ["critic", "researcher"] } : base);
      const result = await executeConsultation({ job: f.jobs.entries[0], store: failure === "host" ? { ...f.store, getSession: async () => null } as unknown as SessionStore : f.store,
        signal: new AbortController().signal, save: f.save, run: async input => {
          if (failure === "all" || failure === "synthesis" && input.effort === "medium") throw new Error("Provider failed");
          return response(failure === "empty" ? " " : "Position");
        } });
      assert.equal(result.status, "error"); assert.ok(result.error);
      if (failure === "synthesis") assert.ok(result.answers.every(answer => answer.status === "done"));
    } finally { f.close(); }
  }
});

test("cancellation aborts running inference and retains completed answers; crash/restart exposes errors", async () => {
  const f = fixture(); const controller = new AbortController();
  try {
    await f.service.start("host", { ...base, mode: "round_table", consultantIds: ["critic", "researcher"] });
    const result = await executeConsultation({ job: f.jobs.entries[0], store: f.store, signal: controller.signal, save: f.save,
      run: async input => {
        if (input.systemPrompt === "critic role") return response("Retained evidence");
        await new Promise<void>(resolve => setTimeout(resolve, 5)); controller.abort(); input.signal.throwIfAborted(); return response();
      } });
    assert.equal(result.status, "stopped"); assert.equal(result.answers[0].text, "Retained evidence");
    assert.equal(result.answers[1].status, "stopped"); assert.equal(result.synthesis, null);
    await f.service.cancel("host", "request"); await f.service.cancel("host", "request");
    assert.equal((await f.service.get("host", "request")).answers[0].text, "Retained evidence");
    await f.service.start("host", { ...base, requestId: "crashed" });
    f.jobs.states.set("consultation_crashed", { status: "error", error: "Discussion worker exited" });
    const crashed = await f.service.get("host", "crashed");
    assert.equal(crashed.status, "error"); assert.match(crashed.error!, /worker exited/);
    assert.equal(crashed.answers[0].status, "error");
    assert.deepEqual((await f.service.history("host")).consultations.map(item => item.requestId), ["request", "crashed"]);
  } finally { f.close(); }
});

test("direct HTTP requires signed-in UI; complete API supports list/start/status/cancel and session isolation", async () => {
  const f = fixture(); const app = express(); app.use(express.json());
  app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "user"; next(); });
  app.use(createConsultantRouter(f.service));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json", "x-test-user": "user" };
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await (await fetch(url, { headers })).json()).actors[0].type, "consultant");
    const started = await fetch(`${url}/sessions/host/requests`, { method: "POST", headers, body: JSON.stringify(base) }); assert.equal(started.status, 200);
    assert.equal((await (await fetch(`${url}/sessions/host/requests/request`, { headers })).json()).status, "queued");
    assert.equal((await fetch(`${url}/sessions/other/requests/request`, { headers })).status, 400);
    const stopped = await fetch(`${url}/sessions/host/requests/request/cancel`, { method: "POST", headers });
    assert.equal((await stopped.json()).status, "stopped");
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); f.close(); }
});

test("real worker action routes require capability and active binding, ignore forged host IDs and enforce model permissions", async () => {
  const f = fixture(); let active = true;
  const domain = { getRoom: async () => ({ actors: [{ id: "worker", rootActorId: "worker", allowedModels: [DEFAULT_MODEL] }],
    workItems: [{ id: "work", executorActorId: "worker", taskSessionId: "host", taskTurnId: "turn" }] }) } as unknown as DomainActorService;
  f.store.getSessionTurn = async id => ({ id, sessionId: id === "turn" ? "host" : "other", status: active ? "running" : "done" }) as never;
  const app = express(); app.use(express.json());
  app.use(createDomainActorRouter(domain, {} as DomainActorStore, f.store, {} as CollaborationService,
    { verify: async token => token === "test-worker-token" }, f.service));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(done => server.once("listening", done));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const call = (body: object, capability = "test-worker-token") => fetch(`http://127.0.0.1:${address.port}/sessions/host/action`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-threadex-actor-capability": capability }, body: JSON.stringify({ sourceTurnId: "turn", ...body })
  });
  try {
    assert.equal((await call({ action: "consultant_list" }, "wrong")).status, 400);
    const library = await call({ action: "consultant_list" }); assert.equal((await library.json()).actors.length, 2);
    const page = await (await call({ action: "consultant_list", limit: 1 })).json();
    assert.equal(page.actors.length, 1); assert.equal(page.nextOffset, 1); assert.equal(page.actors[0].rolePrompt, undefined);
    assert.equal((await call({ action: "consultant_list", limit: 100 })).status, 400);
    for (const trigger of ["on_demand", "user_requested"]) {
      const started = await call({ action: "consultant_ask", requestId: trigger, consultantId: "critic", question: "Review", trigger,
        sessionId: "other", workspaceId: "other", sourceActorId: "forged" });
      assert.equal(started.status, 200);
      const result = await started.json(); assert.equal(result.sessionId, "host"); assert.equal(result.sourceTurnId, "turn");
      assert.equal(result.trigger, trigger); assert.equal(result.answers[0].consultant.type, "consultant");
    }
    const round = await call({ action: "consultant_round_table", requestId: "round", consultantIds: ["critic", "researcher"], question: "Discuss" });
    assert.equal(round.status, 200); assert.equal((await round.json()).mode, "round_table");
    assert.equal((await call({ action: "consultant_status", requestId: "round" })).status, 200);
    const cancelled = await call({ action: "consultant_cancel", requestId: "round" }); assert.equal((await cancelled.json()).status, "stopped");
    f.actors[1].model = MODEL_CATALOG.astra.id;
    assert.equal((await (await call({ action: "consultant_list" })).json()).actors.length, 1);
    const disallowed = await call({ action: "consultant_ask", requestId: "forbidden", consultantId: "researcher", question: "Assess" });
    assert.equal(disallowed.status, 400); assert.match((await disallowed.json()).error, /model permissions/);
    active = false;
    const stale = await call({ action: "consultant_ask", requestId: "stale", consultantId: "critic", question: "Assess" });
    assert.equal(stale.status, 400); assert.match((await stale.json()).error, /bound running task/);
    assert.equal(f.jobs.entries.length, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); f.close(); }
});
