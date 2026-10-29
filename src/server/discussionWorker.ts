import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DiscussionJobs, readJobJson, writeJobJson, type DiscussionJob } from "./discussionJobs";
import { RoundtableService } from "./roundtableService";
import { SessionStore } from "./sessionStore";
import { answerSessionQuestion, stopSessionQuestionRunners } from "./sessionQuestion";
import { isClaudeModel } from "../modelCatalog";
import { normalizeModelTokenUsage } from "./modelTokenUsage";
import { DomainActorService } from "./domainActorService";
import { DomainActorStore } from "./domainActorStore";
import { actorModelHooks } from "./domainActorRunner";
import { saveActorAttachments } from "./domainActorAttachments";
import { SessionSummarizer } from "./sessionSummarizer";
import { AutoModelSettings } from "./autoModelSettings";
import { HelperModelSettings } from "./helperModelSettings";
import { createDecisionService } from "./decision/service";
import { DEFAULT_POLICY } from "./decision/policy";
import { executeConsultation } from "./consultantService";

const directory = resolve(process.argv[2]);
const job = readJobJson<DiscussionJob>(resolve(directory, "job.json"))!;
const heartbeat = () => writeJobJson(resolve(directory, "owner.json"), { pid: process.pid, heartbeat: Date.now() });
heartbeat();
const heartbeatTimer = setInterval(heartbeat, 1000);
const store = new SessionStore();
let stop = async () => {};
let stopping = false;
const controller = new AbortController();
const cancel = () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
  void stop().catch(error => console.error(error));
};
process.once("SIGTERM", cancel);
process.once("SIGINT", cancel);
const controls = setInterval(() => { if (existsSync(resolve(directory, "stop.json"))) cancel(); }, 200);

async function usage(input: { id: string; task: string; sessionId: string; workspaceId: string; accountId: string | null; model: string; usage: unknown }) {
  const value = normalizeModelTokenUsage(input.usage);
  if (!value) return;
  await store.recordTokenUsage([{ id: input.id, usageType: "background", source: "discussion_worker",
    sessionId: input.sessionId, workspaceId: input.workspaceId, accountId: input.accountId, model: input.model,
    ...value, metadata: { task: input.task } }]);
}

try {
  await store.ready();
  if (existsSync(resolve(directory, "stop.json"))) cancel();
  controller.signal.throwIfAborted();
  if (job.kind === "consultant") {
    const consultation = await executeConsultation({ job, store, signal: controller.signal,
      save: result => writeJobJson(resolve(directory, "consultation.json"), result) });
    writeJobJson(resolve(directory, "state.json"), { status: consultation.status === "done" ? "done" : consultation.status === "stopped" ? "stopped" : "error",
      ...(consultation.error ? { error: consultation.error } : {}) });
  } else if (job.kind === "actor-room") {
    const dataDir = resolve(directory, "../../..");
    const settings = new AutoModelSettings(resolve(dataDir, "typesafe-api-key"));
    const helpers = new HelperModelSettings(resolve(dataDir, "helper-models.json"));
    const summarizer = new SessionSummarizer(store, undefined, undefined, undefined, () => helpers.read());
    const hooks = actorModelHooks(store, summarizer, job.payload.serverUrl);
    const decide = createDecisionService(settings, store, input => summarizer.runDecisionJsonTask({ ...input,
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal }));
    stop = async () => summarizer.close();
    const service = new DomainActorService(new DomainActorStore(store), {
      saveAttachments: (workspaceId, requestId, attachments) => saveActorAttachments(resolve(dataDir, "uploads"), workspaceId, requestId, attachments),
      decide: input => { controller.signal.throwIfAborted(); return decide(input); },
      policy: purpose => settings.policies()[purpose] ?? DEFAULT_POLICY,
      ...hooks,
      respond: input => hooks.respond({ ...input, signal: AbortSignal.any([input.signal, controller.signal]) }),
      startTask: input => { controller.signal.throwIfAborted(); return hooks.startTask(input); },
      maintain: input => { controller.signal.throwIfAborted(); return hooks.maintain(input); }
    });
    try {
      if (job.payload.retry) await service.resumeRetry(job.payload.input.workspaceId, job.payload.retry.roundId, job.payload.retry.leaseOwner);
      else await service.submit(job.payload.input, job.payload.taskBinding);
      await service.settled();
    } finally { summarizer.close(); }
  } else if (job.kind === "roundtable") {
    const service = new RoundtableService({ store, logDir: job.payload.logDir, serverUrl: job.payload.serverUrl,
      summarizerModel: () => job.payload.summarizerModel, recordUsage: usage });
    stop = () => service.stop(job.payload.turnId);
    const jobs = new DiscussionJobs(resolve(directory, "../.."));
    let processing = Promise.resolve();
    const poll = setInterval(() => {
      processing = processing.then(async () => {
        for (const actorId of jobs.skippedActors(job)) {
          await service.skip(job.sessionId, job.payload.turnId, actorId).catch(error => console.warn("Skip actor:", error.message));
        }
      });
    }, 200);
    try {
      // A competing writer can win the claim between scheduling and startup.
      // Keep the durable job queued until it can claim, rather than losing it.
      do {
        controller.signal.throwIfAborted();
        service.resume(job.payload.turnId);
        await service.idle(job.payload.turnId);
        if ((await store.getRoundtableRound(job.payload.turnId))?.status !== "queued") break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (!stopping);
    }
    finally { clearInterval(poll); await processing; }
  } else {
    const session = await store.getSession(job.sessionId);
    const workspace = session && await store.getWorkspace(session.workspaceId);
    if (!session || !workspace) throw new Error("Side-chat session or workspace no longer exists.");
    const accountId = session.accountId ?? (await store.getActiveAccount(session.workspaceId))?.id ?? null;
    const auth = accountId ? await store.getAccountAuth(accountId) : null;
    const input = job.payload;
    const result = await answerSessionQuestion({ question: input.question, context: { session }, workspace,
      serverUrl: input.serverUrl, model: input.model, reasoningEffort: input.reasoningEffort,
      authRaw: auth?.authRaw, signal: controller.signal, room: input.room,
      resolveClaudeConfigDir: async () => (await store.resolveClaudeAccount({ workspaceId: session.workspaceId, sessionId: session.id }))?.configDir ?? null });
    controller.signal.throwIfAborted();
    await store.recordSessionSideChat({ ...input.record, id: job.id, sessionId: session.id, workspaceId: session.workspaceId,
      question: input.question, answer: result.answer, model: result.model });
    try {
      await usage({ id: `background:session_question:${job.id}`, task: "session_question", sessionId: session.id,
        workspaceId: session.workspaceId, accountId: isClaudeModel(result.model) ? null : accountId, model: result.model, usage: result.usage });
    } catch (error) { console.warn("Side-chat usage:", error); }
  }
  if (job.kind !== "consultant") writeJobJson(resolve(directory, "state.json"), { status: stopping ? "stopped" : "done" });
} catch (error) {
  writeJobJson(resolve(directory, "state.json"), { status: stopping ? "stopped" : "error", error: error instanceof Error ? error.message : String(error) });
} finally {
  clearInterval(controls);
  clearInterval(heartbeatTimer);
  stopSessionQuestionRunners();
  await store.close();
}
