import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_MODEL } from "../modelCatalog";
import { newRoundtableActor } from "../roundtable";
import { DiscussionJobs, readJobJson, type DiscussionJob } from "./discussionJobs";
import { RoundtableService } from "./roundtableService";
import { SessionStore } from "./sessionStore";
import { DomainActorStore } from "./domainActorStore";
import { DomainActorService } from "./domainActorService";
import type { Consultation } from "../consultants";
import { ConsultantService } from "./consultantService";

const worker = fileURLToPath(new URL("./testFixtures/discussionWorker.ts", import.meta.url));
const jobsModule = fileURLToPath(new URL("./discussionJobs.ts", import.meta.url));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for detached worker");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
async function submitFromExitingServer(directory: string, job: DiscussionJob, storeId: string) {
  const source = `import { DiscussionJobs } from ${JSON.stringify(jobsModule)};
    new DiscussionJobs(${JSON.stringify(directory)}, ${JSON.stringify(worker)}).start(${JSON.stringify(job)});`;
  await new Promise<void>((done, reject) => {
    const parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      env: { ...process.env, SESSION_STORE_ID: storeId }, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    parent.stderr.on("data", chunk => { stderr += chunk; });
    parent.once("error", reject);
    parent.once("exit", code => code === 0 ? done() : reject(new Error(stderr)));
  });
}

test("consultant worker survives submitter exit, saves round table results once and supports cancellation without occupying the host", async () => {
  const directory = mkdtempSync("/private/tmp/discussion-consultant-test-");
  const storeId = `/private/tmp/discussion-store-${randomUUID()}`;
  const store = new SessionStore(storeId), jobs = new DiscussionJobs(directory, worker);
  const now = new Date().toISOString();
  const consultation: Consultation = { requestId: "round", sessionId: "host", workspaceId: "default", mode: "round_table",
    question: "Review this plan", context: "Keep the constraint", trigger: "on_demand", status: "queued", synthesis: null, error: null,
    created: now, updated: now, answers: ["critic", "researcher"].map(id => ({ consultant: { id, type: "consultant", name: id, model: DEFAULT_MODEL,
      effort: "high", rolePrompt: "Discuss", isDefault: true }, status: "waiting", text: "", error: null })) };
  const job: DiscussionJob = { id: "consultation_round", sessionId: "host", kind: "consultant", created: now,
    payload: { consultation, requestFingerprint: "stable", serverUrl: "http://127.0.0.1:1", synthesisModel: DEFAULT_MODEL } };
  const path = jobs.path(job.sessionId, job.id);
  const service = new ConsultantService({ store, settings: { read: () => ({ revision: 1, actors: [] }) }, jobs,
    serverUrl: "http://127.0.0.1:1", synthesisModel: () => DEFAULT_MODEL });
  const cancelled = { ...job, id: "consultation_cancel", created: now,
    payload: { ...job.payload, consultation: { ...consultation, requestId: "cancel", mode: "question", answers: consultation.answers.slice(0, 1) } } };
  try {
    await store.ready();
    await store.upsertSession({ id: "host", workspaceId: "default", cwd: "/private/tmp", title: "Consultant host" });
    await store.recordSessionTurn({ id: "working", sessionId: "host", userInput: "Implement", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    await submitFromExitingServer(directory, job, storeId);
    await until(() => existsSync(resolve(path, "calls")) && readFileSync(resolve(path, "calls"), "utf8").split("\n").length === 3);
    assert.equal((await service.get("host", "round")).status, "running");
    assert.equal((await store.getLatestRunningTurn("host"))?.id, "working", "consultation never occupies or replaces the host writer");
    assert.equal(jobs.start(job).id, job.id);
    writeFileSync(resolve(path, "release"), "");
    await until(() => jobs.state(job).status !== "running");
    assert.deepEqual(jobs.state(job), { status: "done" });
    const result = readJobJson<Consultation>(resolve(path, "consultation.json"))!;
    assert.equal(result.status, "done"); assert.ok(result.answers.every(answer => answer.status === "done"));
    assert.equal(result.synthesis, "Detached actor answer");
    assert.equal(readFileSync(resolve(path, "calls"), "utf8"), "actor\nactor\nactor\n");
    assert.deepEqual(await service.get("host", "round"), result);
    assert.equal((await store.listSessionTurns("host")).length, 1, "no tasks or turns are added by consultants");
    await submitFromExitingServer(directory, cancelled, storeId);
    await until(() => existsSync(resolve(jobs.path("host", cancelled.id), "calls")));
    const stopped = await service.cancel("host", "cancel");
    assert.equal(stopped.status, "stopped"); assert.equal(stopped.answers[0].status, "stopped");
    assert.equal((await service.cancel("host", "cancel")).status, "stopped");
  } finally {
    for (const item of [job, cancelled]) if (existsSync(jobs.path(item.sessionId, item.id))) {
      writeFileSync(resolve(jobs.path(item.sessionId, item.id), "release"), ""); await jobs.stop(item);
    }
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("side-chat worker survives its submitting process, reconnects without duplicate inference and saves its answer", async () => {
  const directory = mkdtempSync("/private/tmp/discussion-side-test-");
  const storeId = `/private/tmp/discussion-store-${randomUUID()}`;
  const store = new SessionStore(storeId);
  const jobs = new DiscussionJobs(directory, worker);
  store.runningSideChatSessionIds = () => jobs.runningSideChatSessionIds();
  const job: DiscussionJob = { id: "side_chat_request", sessionId: "host", kind: "side-chat", created: new Date().toISOString(),
    payload: { question: "Investigate", model: DEFAULT_MODEL, reasoningEffort: "low", serverUrl: "http://127.0.0.1:1",
      room: { actor: null, history: [], messageId: "side_chat_request" }, record: { roundId: "room", mode: "isolated_ephemeral_thread" } } };
  const path = jobs.path(job.sessionId, job.id);
  try {
    await store.ready();
    await store.upsertSession({ id: "host", workspaceId: "default", cwd: "/private/tmp", title: "Detached side chat" });
    await submitFromExitingServer(directory, job, storeId);
    await until(() => existsSync(resolve(path, "calls")));
    assert.equal(jobs.state(job).status, "running");
    assert.deepEqual(jobs.runningSideChatSessionIds(), ["host"]);
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("default"), { host: "running" });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses("other-workspace"), {});
    assert.deepEqual((await store.listWorkspaceMonitorSessions()).map(session => session.sessionId), ["host"]);
    assert.equal(await store.getLatestRunningTurn("host"), null, "side chat does not occupy the host writer");
    assert.equal(new DiscussionJobs(directory, worker).start(job).id, job.id);
    writeFileSync(resolve(path, "release"), "");
    await until(() => jobs.state(job).status !== "running");
    assert.deepEqual(jobs.state(job), { status: "done" });
    assert.deepEqual(await store.listActiveSessionExecutionStatuses(), {});
    assert.deepEqual(await store.listWorkspaceMonitorSessions(), []);
    const saved = await store.listSessionSideChats("host");
    assert.equal(saved?.sideChats.length, 1);
    assert.equal(saved?.sideChats[0].answer, "Detached actor answer");
    assert.equal(readFileSync(resolve(path, "calls"), "utf8"), "actor\n");
    assert.equal(jobs.list("another-session").length, 0);
    assert.throws(() => jobs.start({ ...job, payload: { ...job.payload, requestFingerprint: "different" } }), /another request/);
    const stopped = { ...job, id: "side_chat_stop", created: new Date().toISOString() };
    await submitFromExitingServer(directory, stopped, storeId);
    await until(() => existsSync(resolve(jobs.path(stopped.sessionId, stopped.id), "calls")));
    await jobs.stop(stopped);
    assert.equal(jobs.state(stopped).status, "stopped");
    assert.deepEqual(jobs.runningSideChatSessionIds(), []);
    assert.equal((await store.listSessionSideChats("host"))?.sideChats.length, 1, "cancelled answers are not saved");
  } finally {
    if (existsSync(path)) { writeFileSync(resolve(path, "release"), ""); await jobs.stop(job); }
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("lost workers are reported as failed, never silently relaunched", () => {
  const directory = mkdtempSync("/private/tmp/discussion-lost-test-");
  const jobs = new DiscussionJobs(directory, "/missing-worker.ts");
  const job: DiscussionJob = { id: "lost", sessionId: "session", kind: "side-chat", created: "2000-01-01T00:00:00Z", payload: {} };
  try {
    assert.equal(jobs.state(job).status, "error");
    assert.match(jobs.state(job).error!, /Retry/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actor room reattaches after API exit without repeating replies or cancelling its worker", async () => {
  const directory = mkdtempSync("/private/tmp/discussion-actor-test-");
  const storeId = `/private/tmp/discussion-store-${randomUUID()}`;
  const store = new SessionStore(storeId);
  const jobs = new DiscussionJobs(directory, worker);
  const actors = new DomainActorStore(store);
  const input = { workspaceId: "actor-test", requestId: "actor-restart", userPrompt: "Discuss the fix", namedActorIds: ["root"] };
  const taskBinding = { workspaceId: "actor-test", cwd: "/submission-project", projectId: "selected-project", source: "explicit" };
  const { createHash } = await import("node:crypto");
  const job: DiscussionJob = { id: `actor_request_${createHash("sha256").update(input.requestId).digest("hex")}`,
    sessionId: "actor-room:actor-test", kind: "actor-room", created: new Date().toISOString(),
    payload: { input, taskBinding, serverUrl: "http://127.0.0.1:1", requestFingerprint: JSON.stringify([input.userPrompt, input.namedActorIds, null, null]) } };
  const path = jobs.path(job.sessionId, job.id);
  // API observers must never perform model inference themselves.
  const service = new DomainActorService(actors, { jobs, policy: () => ({ order: [], threshold: {} }),
    decide: async () => { throw new Error("API inference"); }, respond: async () => { throw new Error("API inference"); },
    maintain: async () => { throw new Error("API inference"); }, startTask: async () => { throw new Error("Unexpected dispatch"); } });
  try {
    await store.ready();
    await store.upsertWorkspace({ id: "actor-test", name: "Actor restart test", cwd: directory, codexHome: directory });
    await actors.create("actor-test", { id: "root", name: "Root", model: DEFAULT_MODEL,
      memory: { rolePrompt: "Discuss", roleSummary: "Discussion", longTerm: "", rolling: "" } });
    await submitFromExitingServer(directory, job, storeId);
    await until(() => existsSync(resolve(path, "calls")));
    assert.equal((await service.getRoom("actor-test")).rounds[0].status, "responding");
    const receipt = service.submit(input);
    assert.equal(jobs.state(job).status, "running");
    writeFileSync(resolve(path, "release"), "");
    const round = await receipt;
    assert.equal(round.status, "no_claims");
    assert.deepEqual(round.taskBinding, taskBinding, "detached worker retains the submission's project snapshot");
    assert.equal(round.replies[0].status, "opinion", JSON.stringify(round.replies[0]));
    assert.equal(round.replies[0].text, "Detached actor answer");
    const calls = readFileSync(resolve(path, "calls"), "utf8");
    await service.submit(input);
    assert.equal(readFileSync(resolve(path, "calls"), "utf8"), calls, "completed retry never repeats inference");
    assert.equal((await service.getRoom("actor-test")).rounds.length, 1);
    await assert.rejects(service.submit({ ...input, userPrompt: "Different" }), /reused|another request/);
  } finally {
    if (existsSync(path)) { writeFileSync(resolve(path, "release"), ""); await jobs.stop(job); }
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("roundtable coordinator survives server exit, recovery attaches, and actors hand off to host exactly once", async () => {
  const directory = mkdtempSync("/private/tmp/discussion-round-test-");
  const storeId = `/private/tmp/discussion-store-${randomUUID()}`;
  const store = new SessionStore(storeId);
  const jobs = new DiscussionJobs(directory, worker);
  const job: DiscussionJob = { id: "rt_detached:1", sessionId: "host", kind: "roundtable", created: new Date().toISOString(),
    payload: { turnId: "rt_detached", logDir: resolve(directory, "logs"), summarizerModel: DEFAULT_MODEL } };
  const path = jobs.path(job.sessionId, job.id);
  const service = new RoundtableService({ store, jobs, summarizerModel: () => DEFAULT_MODEL });
  try {
    await store.ready();
    await store.upsertSession({ id: "host", workspaceId: "default", cwd: "/private/tmp", title: "Detached round" });
    await store.createRoundtableRound({ turnId: "rt_detached", sessionId: "host", revision: 1, prompt: "Discuss", created: job.created,
      status: "queued", context: null, summarizerModel: DEFAULT_MODEL, hostModel: DEFAULT_MODEL, hostEffort: "low",
      answers: [1, 2].map(() => ({ actor: newRoundtableActor({ model: DEFAULT_MODEL, effort: "low" }), status: "waiting", text: "", error: null })),
      summary: "", error: null, tokenIn: 0, tokenOut: 0 });
    await submitFromExitingServer(directory, job, storeId);
    await until(() => existsSync(resolve(path, "calls")) && readFileSync(resolve(path, "calls"), "utf8").split("\n").length === 3);
    assert.equal(await service.recover((await store.getRoundtableRound("rt_detached"))!), false);
    assert.equal((await store.getRoundtableRound("rt_detached"))?.status, "actors");
    // A second server shutdown detaches its observer without cancelling actors.
    service.stopAll(); await service.idle("rt_detached");
    assert.equal(jobs.state(job).status, "running");
    writeFileSync(resolve(path, "release"), "");
    await until(() => jobs.state(job).status !== "running");
    const round = (await store.getRoundtableRound("rt_detached"))!;
    assert.equal(round.status, "host");
    assert.equal(round.answers.filter(answer => answer.status === "done").length, 2);
    assert.equal((await store.getSessionTurn("rt_detached"))?.status, "todo");
    assert.equal(readFileSync(resolve(path, "calls"), "utf8"), "actor\nactor\n");
  } finally {
    service.stopAll(); await service.idle("rt_detached");
    if (existsSync(path)) { writeFileSync(resolve(path, "release"), ""); await jobs.stop(job); }
    await store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
