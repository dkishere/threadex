import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_MODEL } from "../modelCatalog";
import { newRoundtableActor } from "../roundtable";
import { DiscussionJobs, type DiscussionJob } from "./discussionJobs";
import { RoundtableService } from "./roundtableService";
import { SessionStore } from "./sessionStore";

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
