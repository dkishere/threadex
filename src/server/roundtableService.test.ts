import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { DEFAULT_MODEL, MODEL_CATALOG } from "../modelCatalog";
import { newRoundtableActor, parseRoundtableActors, parseRoundtableSynthesis, roundtableIssueKind, type RoundtableRound } from "../roundtable";
import { RoundtableService as Service, roundtableActorPrompt, roundtableHostInstructions, roundtableHostPrompt } from "./roundtableService";
import { SessionStore } from "./sessionStore";
import type { RoundtableInference } from "./roundtableRunner";
import { RoundtableRunLog } from "./roundtableRunLog";

const logDir = mkdtempSync("/private/tmp/roundtable-activity-test-");
after(() => rmSync(logDir, { recursive: true, force: true }));
class RoundtableService extends Service {
  constructor(options: ConstructorParameters<typeof Service>[0]) { super({ logDir, ...options }); }
}

const actors = [newRoundtableActor({ model: DEFAULT_MODEL, effort: "low" }), newRoundtableActor({ model: MODEL_CATALOG.claudeSonnet.id, effort: "high" })];
const response = (responseText: string) => ({ responseText, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for round table state"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function fixture() {
  const store = new SessionStore(`/private/tmp/roundtable-test-${randomUUID()}`);
  await store.ready();
  await store.upsertSession({ id: "host", workspaceId: "default", cwd: "/private/tmp", title: "Round table test" });
  return store;
}

test("defaults use the selected gearbox profiles, random names and empty custom prompts", () => {
  assert.equal(actors[0].model, DEFAULT_MODEL); assert.equal(actors[0].effort, "low");
  assert.equal(actors[1].model, MODEL_CATALOG.claudeSonnet.id);
  assert.notEqual(actors[0].name, actors[1].name);
  assert.deepEqual(actors.map(actor => actor.systemPrompt), ["", ""]);
  assert.throws(() => parseRoundtableActors([actors[0]]), /2 to 8/);
  assert.throws(() => parseRoundtableActors([actors[0], actors[0]]), /unique/);
  assert.throws(() => parseRoundtableActors([actors[0], { ...actors[1], model: "invalid" }]), /Invalid/);
  assert.throws(() => parseRoundtableActors([actors[0], { ...actors[1], model: MODEL_CATALOG.gpt55.id, effort: "ultra" }]), /Invalid/);
  assert.equal(parseRoundtableActors([actors[0], { ...actors[1], model: MODEL_CATALOG.astra.id, effort: "ultra" }])[1].effort, "ultra");
  assert.equal(newRoundtableActor({ model: MODEL_CATALOG.gpt55.id, effort: "max" }).effort, "xhigh", "unsupported gear effort uses the shared model fallback");
});

test("actors run independently in parallel, then hand results to the same host; the next turn includes that response", async () => {
  const store = await fixture();
  const calls: RoundtableInference[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let actorCalls = 0;
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async input => {
    calls.push(input);
    if (input.systemPrompt.startsWith("Prepare focused context")) return response("Recapped user constraints");
    const index = ++actorCalls;
    if (index <= 2) await gate;
    return response(`Position ${index}`);
  } });
  try {
    await store.recordSessionTurn({ id: "before", sessionId: "host", userInput: "Keep the original constraint", agentResponse: "Earlier answer", tokenIn: 0, tokenOut: 0 });
    const first = { turnId: "rt_first", message: "Discuss trade-offs", actors };
    await service.create("host", first);
    await until(async () => actorCalls === 2);
    assert.equal(calls.length, 3, "one context summary, two concurrent actors; no final helper summary");
    assert.equal(calls[1].prompt, calls[2].prompt);
    assert.match(calls[0].prompt, /Keep the original constraint/);
    assert.doesNotMatch(calls[1].prompt, /Position 1|Position 2/);
    assert.equal((await store.getSessionTurn("rt_first"))?.status, "running");
    await service.create("host", first);
    assert.equal(actorCalls, 2, "a repeated request does not run actors again");
    await service.create("host", { turnId: "rt_second", message: "Consider a compromise", actors });
    assert.equal((await store.getRoundtableRound("rt_second"))?.status, "queued");
    release(); await service.idle("rt_first");
    const round = (await store.getRoundtableRound("rt_first"))!;
    assert.equal(round.status, "host");
    assert.equal((await store.getSessionTurn("rt_first"))?.status, "todo");
    assert.deepEqual(round.answers.map(answer => answer.text), ["Position 1", "Position 2"]);
    const inspected = await store.inspectSession({ sessionId: "host", turnId: "rt_first" });
    assert.deepEqual(inspected?.turns[0].roundtable?.answers.map(answer => answer.text), ["Position 1", "Position 2"]);
    assert.equal(inspected?.turns[0].roundtable?.hostModel, round.hostModel);
    const bounded = await store.inspectSession({ sessionId: "host", turnId: "rt_first", maxTextChars: 4 });
    assert.equal(bounded!.turns[0].roundtable!.answers[0].text, "Position 1", "short responses remain intact under the inspector's 200-character minimum");
    const queued = await store.inspectSession({ sessionId: "host", turnId: "rt_second" });
    assert.equal(queued?.turns.length, 1);
    assert.equal(queued?.turns[0].roundtable?.status, "queued");
    assert.doesNotMatch(roundtableHostInstructions(round), /Position 1/, "actor answers are sent once, in the host prompt");
    for (const actor of actors) assert.match(roundtableHostInstructions(round), new RegExp(actor.name));
    assert.match(roundtableHostInstructions(round), /structured JSON/);
    assert.match(roundtableHostPrompt(round), /```json/);
    assert.match(roundtableHostInstructions(round), /do not implement/i);
    const hostPrompt = roundtableHostPrompt(round);
    assert.notEqual(hostPrompt, round.prompt);
    assert.match(hostPrompt, /not a new request to research/);
    const evidence = JSON.parse(hostPrompt.split("\n\n")[3]);
    assert.equal(evidence.topic, round.prompt);
    assert.deepEqual(evidence.responses, round.answers.map(answer => ({ actor: answer.actor.name, response: answer.text })));
    assert.equal(calls.length, 3);
    await store.claimPendingSessionTurn("rt_first", "host");
    await store.updateSessionTurn({ id: "rt_first", status: "done", agentResponse: "HOST FORMAT: Consensus and remaining differences", tokenIn: 3, tokenOut: 4 });
    const settled = (await store.getRoundtableRound("rt_first"))!;
    assert.equal(settled.status, "done", "the host turn settles its round without a client poll");
    assert.equal(settled.summary, "HOST FORMAT: Consensus and remaining differences");
    assert.equal((await store.getSessionTurn("rt_first"))?.agentResponse, "HOST FORMAT: Consensus and remaining differences");
    await service.wake("host");
    await until(async () => (await store.getRoundtableRound("rt_second"))?.status === "host");
    await service.idle("rt_second");
    assert.doesNotMatch(calls[3].prompt, /HOST FORMAT/);
    assert.doesNotMatch(calls[3].prompt, /Position 1/, "raw responses bypass summarization");
    assert.match(calls[3].prompt, /Consider a compromise/);
    const followUp = JSON.parse(calls[4].prompt);
    assert.equal(followUp.userPrompt, "Consider a compromise");
    assert.equal(followUp.hostContext, "Recapped user constraints");
    assert.equal(followUp.nextRound.previousTurnId, "rt_first");
    assert.equal(followUp.nextRound.previousSynthesis, undefined);
    assert.deepEqual(followUp.nextRound.previousResponses.map((item: { response: string }) => item.response), ["Position 1", "Position 2"], "raw answers reach actors directly even when the summarizer omits them");
    assert.equal(calls[4].prompt, calls[5].prompt, "every actor receives the same prior-round answers");
    assert.equal(JSON.parse(calls[1].prompt).nextRound, undefined, "the first round must not receive a queued future round");
    assert.equal(calls.length, 6);
    assert.equal((await store.listSessionTurns("host")).length, 3, "both rounds live in the original host");
  } finally { release(); service.stopAll(); await service.idle("rt_first"); await service.idle("rt_second"); await store.close(); }
});

test("next round continues the latest completed round's topic; actors see every previous answer", async () => {
  const store = await fixture();
  const calls: RoundtableInference[] = [];
  let actorCalls = 0;
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async input => {
    calls.push(input);
    if (input.systemPrompt.startsWith("Prepare focused context")) return response("Recap");
    return response(`Position ${++actorCalls}`);
  } });
  const settle = async (turnId: string) => {
    await until(async () => (await store.getRoundtableRound(turnId))?.status === "host");
    await service.idle(turnId);
    await store.claimPendingSessionTurn(turnId, "host");
    await store.updateSessionTurn({ id: turnId, status: "done", agentResponse: `Synthesis of ${turnId}`, tokenIn: 0, tokenOut: 0 });
  };
  try {
    await service.create("host", { turnId: "rt_topic", message: "Monolith or services?", actors });
    await assert.rejects(service.nextRoundSource("host", "rt_topic"), /Wait for this round table to finish/);
    await settle("rt_topic");
    await assert.rejects(service.nextRoundSource("other", "rt_topic"), /not found/);
    const body = { turnId: "rt_next", message: "Next round: actors, continue the discussion.", actors, continueFrom: "rt_topic" };
    const next = await service.create("host", body);
    assert.deepEqual(next.continuation, { turnId: "rt_topic", topic: "Monolith or services?" });
    await settle("rt_next");
    const prompt = JSON.parse(calls.at(-1)!.prompt);
    assert.equal(prompt.userPrompt, "Monolith or services?", "actors discuss the original topic, not the button label");
    assert.deepEqual(prompt.nextRound.previousResponses.map((item: { response: string }) => item.response).sort(), ["Position 1", "Position 2"]);
    assert.equal(prompt.nextRound.previousSynthesis, undefined);
    assert.doesNotMatch(calls.at(-1)!.prompt, /Synthesis of rt_topic/);
    const settled = (await store.getRoundtableRound("rt_next"))!;
    assert.equal(JSON.parse(roundtableHostPrompt(settled).split("\n\n")[3]).topic, "Monolith or services?");
    await assert.rejects(service.nextRoundSource("host", "rt_topic"), /Only the latest/);
    const chained = await service.create("host", { ...body, turnId: "rt_third", continueFrom: "rt_next" });
    assert.equal(chained.continuation?.topic, "Monolith or services?", "chained rounds keep the original topic");
    await settle("rt_third");
  } finally { service.stopAll(); await service.idle("rt_topic"); await service.idle("rt_next"); await service.idle("rt_third"); await store.close(); }
});

test("watchdog listings preserve round table ownership while Concurrent results queue", async () => {
  const store = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async () => {
    calls++;
    await gate;
    return response("Actor position");
  } });
  try {
    await service.create("host", { turnId: "rt_watchdog", message: "Discuss", actors });
    await until(async () => calls === 2);
    const running = (await store.listRunningSessionTurns()).find(turn => turn.id === "rt_watchdog")!;
    assert.equal(running.runnerPid, null, "actors have no ordinary host runner");
    assert.equal(running.requestMetadata?.roundtable, true, "watchdog must dispatch to round table recovery");
    assert.equal(await service.recover((await store.getRoundtableRound(running.id))!), false,
      "an active actor stage must retain its writer");
    await store.recordSessionTurn({ id: "concurrent_result", sessionId: "host", userInput: "Worker result",
      agentResponse: "Queued", tokenIn: 0, tokenOut: 0, status: "todo", pendingReason: "queued" });
    assert.equal((await store.claimPendingSessionTurn("concurrent_result", "host")).disposition, "blocked");
    release();
    await service.idle("rt_watchdog");
    const round = (await store.getRoundtableRound("rt_watchdog"))!;
    assert.equal(round.status, "host");
    assert.equal(round.error, null);
    assert.ok(round.answers.every(answer => answer.status === "done"));
  } finally { release(); service.stopAll(); await service.idle("rt_watchdog"); await store.close(); }
});

test("failed actors retain successful answers; retry dispatches only unfinished work and blocks stale or cross-session retries", async () => {
  const store = await fixture();
  let fail = true;
  const models: string[] = [];
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async input => {
    models.push(input.model);
    input.onEvent?.("codex", { method: "item/started", params: { item: { id: "read", type: "commandExecution", command: "git status" } } });
    if (fail && input.model === MODEL_CATALOG.claudeSonnet.id) throw new Error("Claude rate limit");
    return response(`Answer ${input.model}`);
  } });
  try {
    await service.create("host", { turnId: "rt_retry", message: "Discuss", actors });
    await until(async () => (await store.getRoundtableRound("rt_retry"))?.status === "error");
    await service.idle("rt_retry");
    const round = (await store.getRoundtableRound("rt_retry"))!;
    assert.equal(round.answers[0].status, "done");
    assert.match(round.answers[1].error!, /rate limit/);
    const failedAttempt = round.answers[1].attempts![0];
    assert.equal(failedAttempt.status, "error");
    const originalLog = readFileSync(failedAttempt.logPath, "utf8");
    assert.match(originalLog, /git status/);
    assert.match(originalLog, /run.error/);
    assert.match(originalLog, /Claude rate limit/);
    assert.equal(await service.activityLogPath("wrong-host", round.turnId, failedAttempt.id), null);
    assert.equal(await service.activityLogPath("host", round.turnId, failedAttempt.id), failedAttempt.logPath);
    assert.equal((await store.getSessionTurn(round.turnId))?.status, "done");
    await assert.rejects(service.retry("wrong-host", round.turnId, round.revision), /not found/);
    await assert.rejects(service.retry("host", round.turnId, round.revision - 1), /changed/);
    fail = false;
    await service.retry("host", round.turnId, round.revision);
    await service.idle(round.turnId);
    assert.equal((await store.getRoundtableRound(round.turnId))?.status, "host");
    assert.deepEqual(models, [DEFAULT_MODEL, MODEL_CATALOG.claudeSonnet.id, MODEL_CATALOG.claudeSonnet.id]);
    const retried = (await store.getRoundtableRound(round.turnId))!;
    assert.deepEqual(retried.answers.map(answer => answer.attempts!.length), [1, 2]);
    assert.deepEqual(retried.answers[1].attempts!.map(attempt => attempt.status), ["error", "done"]);
    assert.equal(readFileSync(failedAttempt.logPath, "utf8"), originalLog, "retry never overwrites the failed attempt");
    await assert.rejects(service.create("host", { turnId: round.turnId, message: "Different prompt", actors }), /already belongs/);
  } finally { service.stopAll(); await service.idle("rt_retry"); await store.close(); }
});

test("restart recovery retains completed actors and never automatically replays interrupted inference", async () => {
  const store = await fixture();
  let calls = 0;
  try {
    const initial: RoundtableRound = { turnId: "rt_interrupted", sessionId: "host", revision: 1, prompt: "Discuss", created: new Date().toISOString(),
      status: "queued", context: "Saved context", summarizerModel: DEFAULT_MODEL, hostModel: DEFAULT_MODEL, hostEffort: "high", summary: "", error: null, tokenIn: 0, tokenOut: 0,
      answers: actors.map(actor => ({ actor, status: "waiting", text: "", error: null })) };
    await store.createRoundtableRound(initial);
    await store.claimPendingSessionTurn(initial.turnId, "host");
    const journal = new RoundtableRunLog(logDir, { sessionId: "host", turnId: initial.turnId, actorId: actors[1].id, model: actors[1].model, effort: "high" });
    journal.providerEvent("claude", { type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 30 });
    const interrupted: RoundtableRound = { ...initial, revision: 2, status: "actors", answers: [
      { ...initial.answers[0], status: "done", text: "Saved answer" }, { ...initial.answers[1], status: "running", attempts: [{ ...journal.attempt }] }] };
    await store.saveRoundtableRound(interrupted, 1);
    const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async () => { calls++; return response("New answer"); } });
    assert.equal(await service.recover(interrupted), true, "the runner watchdog recovers the interrupted stage");
    const recovered = (await store.getRoundtableRound("rt_interrupted"))!;
    assert.equal(recovered.status, "error"); assert.equal(calls, 0);
    assert.equal(recovered.answers[0].text, "Saved answer");
    assert.equal(recovered.answers[1].attempts![0].status, "interrupted");
    assert.match(readFileSync(journal.attempt.logPath, "utf8"), /tool_progress[\s\S]*run.interrupted/);
    assert.equal((await store.getLatestRunningTurn("host")), null);
    await service.retry("host", recovered.turnId, recovered.revision);
    await service.idle(recovered.turnId);
    assert.equal(calls, 1);
    assert.equal((await store.getRoundtableRound(recovered.turnId))?.context, "Saved context");
    await assert.rejects(store.saveRoundtableRound(interrupted, 1), /changed/);
  } finally { await store.close(); }
});

test("cancellation ends active inference and preserves actor answers without starting the host", async () => {
  const store = await fixture();
  let started = 0;
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: input => {
    started++;
    return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  try {
    await service.create("host", { turnId: "rt_stop", message: "Discuss", actors });
    await until(async () => started === 2);
    await service.stop("rt_stop");
    assert.equal((await store.getRoundtableRound("rt_stop"))?.status, "stopped");
    const stopped = (await store.getRoundtableRound("rt_stop"))!;
    for (const answer of stopped.answers) {
      assert.equal(answer.attempts![0].status, "stopped");
      assert.match(readFileSync(answer.attempts![0].logPath, "utf8"), /run.stopped/);
    }
    assert.equal((await store.getSessionTurn("rt_stop"))?.status, "done");
  } finally { service.stopAll(); await service.idle("rt_stop"); await store.close(); }
});

test("host JSON becomes a validated synthesis with derived consensus and disagreement", async () => {
  const [a, b] = actors.map(actor => actor.name);
  const synthesis = parseRoundtableSynthesis("```json\n" + JSON.stringify({ issues: [
    { topic: "Direction", positions: [{ view: "Wait for data", actors: [a, b] }] },
    { topic: "Focus", positions: [{ view: "Rates", actors: [a] }, { view: "Earnings", actors: [b] }] },
    { topic: "Horizon", positions: [{ view: "Ask the user", actors: [b] }] }
  ] }) + "\n```", [a, b])!;
  assert.deepEqual(synthesis.issues.map(issue => roundtableIssueKind(issue, 2)), ["consensus", "disagreement", "partial"]);
  assert.deepEqual(synthesis.issues[1].positions.map(position => position.actors), [[a], [b]]);
  assert.equal(parseRoundtableSynthesis("Plain markdown answer", [a, b]), null);
  assert.throws(() => parseRoundtableActors([actors[0], { ...actors[1], name: a }]), /different name/);

  const store = await fixture();
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async () => response("Actor position") });
  try {
    await service.create("host", { turnId: "rt_synthesis", message: "Discuss", actors });
    await until(async () => (await store.getRoundtableRound("rt_synthesis"))?.status === "host");
    await service.idle("rt_synthesis");
    await store.claimPendingSessionTurn("rt_synthesis", "host");
    await store.updateSessionTurn({ id: "rt_synthesis", status: "done", runnerExitCode: 0, tokenIn: 0, tokenOut: 0,
      agentResponse: "```json\n" + JSON.stringify({ issues: [{ topic: "Direction", positions: [{ view: "Wait for data", actors: [a, b] }] }] }) + "\n```" });
    const round = (await store.getRoundtableRound("rt_synthesis"))!;
    assert.equal(round.synthesis?.issues[0].topic, "Direction");
    assert.match(round.summary, /\*\*Consensus\*\*/);
    assert.equal((await store.getSessionTurn("rt_synthesis"))?.agentResponse, round.summary, "history keeps readable markdown, not raw JSON");
    await service.create("host", { turnId: "rt_malformed", message: "Continue", actors });
    await until(async () => (await store.getRoundtableRound("rt_malformed"))?.status === "host");
    await service.idle("rt_malformed");
    await store.claimPendingSessionTurn("rt_malformed", "host");
    const malformed = JSON.stringify({ issues: [{ topic: "Direction", positions: [
      { view: "Wait", actors: [a, b] }, { view: "Proceed", actors: ["Unknown"] }
    ] }] });
    await store.updateSessionTurn({ id: "rt_malformed", status: "done", runnerExitCode: 0, tokenIn: 0, tokenOut: 0, agentResponse: malformed });
    assert.equal((await store.getRoundtableRound("rt_malformed"))?.synthesis, null);
    assert.equal((await store.getSessionTurn("rt_malformed"))?.agentResponse, malformed, "invalid attribution must not erase a position and invent consensus");
  } finally { service.stopAll(); await service.idle("rt_synthesis"); await store.close(); }
});

test("minor differences stay within consensus and reject invalid detail attribution", () => {
  const names = ["Robin", "Willow"];
  const parse = (details: unknown) => parseRoundtableSynthesis(JSON.stringify({ issues: [{ topic: "Rollout", positions: [
    { view: "Stage the migration", actors: names, details }
  ] }] }), names);
  const details = [{ actors: ["Robin"], detail: "Start with [a pilot](https://example.com/pilot)" }];
  const result = parse(details)!;
  assert.equal(roundtableIssueKind(result.issues[0], 2), "consensus");
  assert.deepEqual(result.issues[0].positions[0].details, details);
  assert.equal(parse([{ actors: ["Ghost"], detail: "Wait" }]), null);
  assert.equal(parse([{ actors: ["Robin"], detail: "Wait" }, { actors: ["Robin"], detail: "Go" }]), null);
  assert.equal(parse([{ actors: [], detail: "Wait" }]), null);
  assert.equal(parse([null]), null);
  assert.equal(parse({}), null);
  assert.equal(parseRoundtableSynthesis(JSON.stringify({ issues: [{ topic: "Rollout", positions: [
    { view: "Wait", actors: ["Robin"], details: [{ actors: ["Willow"], detail: "Later" }] }
  ] }] }), names), null);
});

test("synthesis keeps attribution intact or falls back to the original output", () => {
  const names = ["Robin", "Willow"];
  const parse = (positions: unknown[]) => parseRoundtableSynthesis(JSON.stringify({ issues: [{ topic: "Rollout", positions }] }), names);
  assert.equal(parse([{ view: "Wait", actors: names }, { view: "Proceed", actors: ["Ghost"] }]), null);
  assert.equal(parse([{ view: "Wait", actors: names }, { view: "Proceed", actors: [names[0]] }]), null);
  assert.equal(parse([null]), null);
  assert.equal(parse([{ view: "Wait", actors: [] }]), null);
  assert.equal(parseRoundtableSynthesis('{"issues":[]}', names), null);
  assert.equal(parseRoundtableSynthesis('{"issues":[null]}', names), null);
  const merged = parse([{ view: "Wait", actors: [names[0], names[0]] }, { view: "Wait", actors: [names[1]] }])!;
  assert.equal(merged.issues[0].positions.length, 1, "identical views are not a disagreement");
  assert.equal(roundtableIssueKind(merged.issues[0], 2), "consensus");
  assert.equal(roundtableIssueKind({ topic: "Rollout", positions: [{ view: "Wait", actors: [names[0], names[0]] }] }, 2), "partial");
  assert.equal(roundtableIssueKind({ topic: "Empty", positions: [] }, 2), "partial");
});

test("actors get tools and the host session link; context cites turn links; peers stay sealed in the inspector", async () => {
  const store = await fixture();
  const calls: RoundtableInference[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, serverUrl: "http://127.0.0.1:1", run: async input => {
    calls.push(input);
    input.onEvent?.("codex", { method: "item/started", params: { item: { type: "commandExecution", command: "git status" } } });
    if (input.actorTools && input.model === actors[1].model) await gate;
    return response(input.actorTools ? `Answer from ${input.model}` : "Focused context");
  } });
  try {
    await store.recordSessionTurn({ id: "earlier", sessionId: "host", userInput: "Constraint", agentResponse: "Noted", tokenIn: 0, tokenOut: 0 });
    await service.create("host", { turnId: "rt_tools", message: "Discuss", actors });
    await until(async () => (await store.getRoundtableRound("rt_tools"))?.answers[0].status === "done");
    const [context, ...actorCalls] = calls;
    assert.equal(context.actorTools, undefined, "the context summariser has no tools");
    assert.match(context.prompt, /threadex:\/\/default\/host\/earlier/);
    assert.ok(actorCalls.every(call => call.actorTools?.session.id === "host" && call.actorTools.serverUrl === "http://127.0.0.1:1"));
    assert.equal(JSON.parse(actorCalls[0].prompt).hostSession.link, "threadex://default/host");
    const inspected = await store.inspectSession({ sessionId: "host", turnId: "rt_tools" });
    assert.deepEqual(inspected?.turns[0].roundtable?.answers.map(answer => answer.text), ["", ""], "a finished actor's answer is hidden while peers run");
    const activeAttempt = inspected!.turns[0].roundtable!.answers[1].attempts![0];
    assert.equal(activeAttempt.status, "running");
    assert.equal(activeAttempt.logPath, "", "peer log content stays sealed during inference");
    await until(async () => (await store.getRoundtableRound("rt_tools"))!.answers[1].attempts![0].eventCount >= 2);
    const liveAttempt = (await store.getRoundtableRound("rt_tools"))!.answers[1].attempts![0];
    assert.match(readFileSync(liveAttempt.logPath, "utf8"), /git status/, "events are durable before a final answer");
    release(); await service.idle("rt_tools");
    const settled = await store.inspectSession({ sessionId: "host", turnId: "rt_tools" });
    assert.ok(settled?.turns[0].roundtable?.answers.every(answer => answer.text.startsWith("Answer from")));
    assert.ok(settled?.turns[0].roundtable?.answers.every(answer => existsSync(answer.attempts![0].logPath)));
    assert.ok(settled?.turns[0].roundtable?.contextAttempts?.length);
  } finally { release(); service.stopAll(); await service.idle("rt_tools"); await store.close(); }
});

test("actor prompt contains no current-round peer output", () => {
  const prompt = roundtableActorPrompt({ context: "Prior round discussion", prompt: "Next question", answers: [{ text: "CURRENT PEER OUTPUT" }] } as RoundtableRound);
  assert.match(prompt, /Prior round discussion/);
  assert.doesNotMatch(prompt, /CURRENT PEER OUTPUT/);
});

test("restart between claiming the host writer and the first checkpoint releases the writer", async () => {
  const store = await fixture();
  try {
    const round: RoundtableRound = { turnId: "rt_claimed", sessionId: "host", revision: 1, prompt: "Discuss", created: new Date().toISOString(),
      status: "queued", context: null, summarizerModel: DEFAULT_MODEL, hostModel: DEFAULT_MODEL, hostEffort: "high", summary: "", error: null, tokenIn: 0, tokenOut: 0,
      answers: actors.map(actor => ({ actor, status: "waiting", text: "", error: null })) };
    await store.createRoundtableRound(round);
    await store.claimPendingSessionTurn(round.turnId, "host");
    const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL });
    assert.equal(await service.recover(round), true);
    assert.equal(await store.getLatestRunningTurn("host"), null);
    assert.equal((await store.getRoundtableRound(round.turnId))?.status, "error");
  } finally { await store.close(); }
});

test("a failed or stopped host response settles the round and retries the host with saved answers", async () => {
  const store = await fixture();
  let calls = 0;
  const service = new RoundtableService({ store, summarizerModel: () => DEFAULT_MODEL, run: async () => { calls++; return response("Actor position"); } });
  try {
    await service.create("host", { turnId: "rt_host_retry", message: "Discuss", actors });
    await until(async () => (await store.getRoundtableRound("rt_host_retry"))?.status === "host");
    await service.idle("rt_host_retry");
    await store.claimPendingSessionTurn("rt_host_retry", "host");
    await store.updateSessionTurn({ id: "rt_host_retry", status: "done", agentResponse: "Host runner failed", runnerExitCode: 1, tokenIn: 0, tokenOut: 0 });
    const round = (await store.getRoundtableRound("rt_host_retry"))!;
    assert.equal(round.status, "error");
    assert.equal(round.summary, "");
    assert.equal((await store.getSessionTurn(round.turnId))?.agentResponse, "Host runner failed");
    await service.retry("host", round.turnId, round.revision);
    await service.idle(round.turnId);
    assert.equal((await store.getRoundtableRound(round.turnId))?.status, "host");
    assert.equal(calls, 2, "completed actor inference is never repeated for a host failure");
    await store.claimPendingSessionTurn("rt_host_retry", "host");
    await store.updateSessionTurn({ id: "rt_host_retry", status: "todo", pendingReason: "stopped", agentResponse: "Runner stopped", tokenIn: 0, tokenOut: 0 });
    assert.equal((await store.getRoundtableRound("rt_host_retry"))?.status, "stopped");
  } finally { service.stopAll(); await service.idle("rt_host_retry"); await store.close(); }
});
