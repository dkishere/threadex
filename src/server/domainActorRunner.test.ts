import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DomainActor } from "../domainActors";
import { validateActorMemory } from "./domainActorStore";
import { actorMemoryMaintenancePrompt, actorModelHooks } from "./domainActorRunner";
import type { SessionStore } from "./sessionStore";
import type { SessionSummarizer } from "./sessionSummarizer";
import { actorInputBudget } from "./domainActorContext";
import { MODEL_CATALOG } from "../modelCatalog";
import { ACTOR_MODEL_TIER_GUIDANCE, ACTOR_WORKLOAD_ASSESSMENT } from "./domainActorModelSelection";

test("individual actor defaults use workspace registry and root membership for all configured worker trees", async t => {
  const home = mkdtempSync(join(tmpdir(), "actor-binding-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const database = new DatabaseSync(join(home, "state_5.sqlite"));
  database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER);`);
  const dev = "01a0492d-13e1-7a92-9ddd-10b1f461bbb3";
  const bdd = "01a11d66-4168-7661-b495-a9511e88222a";
  const threadex = "01a04f6b-556e-7650-b431-0f40dc55d688";
  for (const [id, name, cwd] of [[dev, "dev", "/Volumes/dev"], [bdd, "bdd", "/Volumes/dev/tools/bdd"],
    [threadex, "session-manager", "/Volumes/dev/tools/session-manager"]]) {
    database.prepare("INSERT INTO projects VALUES (?, ?, 0)").run(id, name);
    database.prepare("INSERT INTO project_roots VALUES (?, ?, 0)").run(id, cwd);
  }
  database.close();
  const root = (id: string, projectId: string) => ({ id, rootActorId: id, parentActorId: null, projectIds: [projectId] });
  const defaultActors = ["fairshot-hiring-platform", "local-dev-environment", "deployment-infrastructure", "e2e-workflows",
    "data-models-and-apis", "observability-and-debugging", "code-review-and-repository-maintenance",
    "codex-tools-and-automation", "developer-productivity", "red-panda-coach"].map(id => root(id, dev));
  const threadexActors = ["threadex-session-planning", "threadex-composer-ui", "threadex-model-analytics",
    "threadex-execution-processes", "threadex-review-changes", "threadex-transcript-knowledge", "threadex-browser-files",
    "threadex-workspace-security", "threadex-data-sync", "threadex-platform"].map(id => root(id, threadex));
  threadexActors.push(root("actor_9a12e776-2564-4a32-8850-a7e444cda89c", bdd));
  const actors: Record<string, Partial<DomainActor>[]> = { default: defaultActors, threadex: [...threadexActors,
    { id: "actor_f240fb24-2f4f-4703-a9eb-46433b17e822", rootActorId: "threadex-session-planning", parentActorId: "threadex-session-planning" },
    { id: "actor_9ace3a31-32e8-4078-8e18-b3819c021423", rootActorId: "threadex-composer-ui", parentActorId: "threadex-composer-ui" }] };
  let roomReads = 0;
  const store = {
    getWorkspace: async (id: string) => ({ id, cwd: "/Volumes/dev/tools/session-manager", codexHome: home }),
    getDomainActorRoom: async (id: string) => { roomReads++; return { actors: actors[id] ?? [] }; }
  };
  const hooks = actorModelHooks(store as unknown as SessionStore, {} as SessionSummarizer, "http://localhost");
  for (const [workspaceId, workers] of Object.entries(actors)) {
    for (const actor of workers) {
      const expected = workspaceId === "default" ? dev : actor.id === "actor_9a12e776-2564-4a32-8850-a7e444cda89c" ? bdd : threadex;
      const binding = await hooks.resolveTaskBinding!({ workspaceId, requestId: "test", userPrompt: "fix this", namedActorIds: [actor.id!] });
      assert.equal(binding.projectId, expected, actor.id);
      assert.equal(binding.source, "actor");
      assert.equal(binding.cwd, expected === dev ? "/Volumes/dev" : expected === bdd ? "/Volumes/dev/tools/bdd" : "/Volumes/dev/tools/session-manager");
    }
  }
  assert.equal(roomReads, 23, "21 roots and two inherited sub-actors");
  const explicit = await hooks.resolveTaskBinding!({ workspaceId: "threadex", requestId: "explicit", userPrompt: "fix this",
    namedActorIds: [threadexActors[0].id], newSessionProjectId: bdd });
  assert.equal(explicit.projectId, bdd); assert.equal(explicit.source, "explicit");
  const message = await hooks.resolveTaskBinding!({ workspaceId: "threadex", requestId: "message", userPrompt: "fix bdd",
    namedActorIds: [threadexActors[0].id] });
  assert.equal(message.projectId, bdd); assert.equal(message.source, "message");
  const beforeGroup = roomReads;
  const group = await hooks.resolveTaskBinding!({ workspaceId: "threadex", requestId: "group", userPrompt: "fix this",
    newSessionProjectId: bdd, namedActorIds: [threadexActors[0].id, threadexActors[1].id] });
  assert.equal(group.projectId, bdd); assert.equal(roomReads, beforeGroup, "group bindings ignore individual defaults");
  const unassigned = await hooks.resolveTaskBinding!({ workspaceId: "other", requestId: "unassigned", userPrompt: "fix this" });
  assert.equal(unassigned.source, "workspace"); assert.equal(unassigned.workspaceId, "other");
  threadexActors[0].projectIds = [threadex, bdd];
  await assert.rejects(hooks.resolveTaskBinding!({ workspaceId: "threadex", requestId: "ambiguous", userPrompt: "fix this",
    namedActorIds: [threadexActors[0].id] }), /multiple projects/);
  threadexActors[0].projectIds = ["missing"];
  await assert.rejects(hooks.resolveTaskBinding!({ workspaceId: "threadex", requestId: "missing", userPrompt: "fix this",
    namedActorIds: ["actor_f240fb24-2f4f-4703-a9eb-46433b17e822"] }), /registered root/);
});

test("completion reviewer uses an independent bounded helper and rejects contradictory verdicts", async () => {
  let response = JSON.stringify({ verdict: "passed", issues: [] });
  let seen = false;
  const hooks = actorModelHooks({ listSessionApprovalLiveItems: async () => ({}), listSessionSteerMessages: async () => ({ turn: [
    { id: "steer", created: "2026-10-23T00:00:00Z", content: "Preserve the latest user correction", attachments: [], forcePlan: false }
  ] }) } as unknown as SessionStore, { runBackgroundJsonTask: async (_ws: string, task: string, prompt: string, options: { signal?: AbortSignal }) => {
    assert.equal(task, "actor_task_review"); assert.ok(options.signal);
    assert.match(prompt, /independently/); assert.match(prompt, /assigned portion/);
    assert.match(prompt, /Untrusted saved result/);
    assert.match(prompt, /Preserve the latest user correction/);
    seen = true; return response;
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { workspaceId: "ws", workItem: { id: "work", model: MODEL_CATALOG.luna.id, taskSessionId: "session", taskTurnId: "turn", delegatedTask: "Review gate only" } as Parameters<NonNullable<typeof hooks.reviewTask>>[0]["workItem"],
    originalRequest: "Review before publication", userPrompt: "Review gate only", result: "Untrusted saved result" };
  assert.deepEqual(await hooks.reviewTask!(input), { verdict: "passed", issues: [] }); assert.ok(seen);
  for (const value of [{ verdict: "passed", issues: ["Missing evidence"] }, { verdict: "issues_found", issues: [] }, { verdict: "unknown", issues: [] }]) {
    response = JSON.stringify(value); await assert.rejects(hooks.reviewTask!(input), /Invalid completion review/);
  }
});
const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
test("memory maintenance requests a strict schema and accepts complete JSON with trailing whitespace", async () => {
  let response = JSON.stringify(memory);
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, task: string, _prompt: string,
    options: { outputSchema: { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> }; lane: string }) => {
    assert.equal(task, "actor_memory"); assert.equal(options.lane, "actor-memory:a");
    assert.deepEqual(options.outputSchema.required, [...Object.keys(memory), "roleChangeQuote"]);
    assert.equal(options.outputSchema.additionalProperties, false);
    assert.deepEqual(options.outputSchema.properties.roleSummary, { type: "string", maxLength: 4000 });
    assert.deepEqual(options.outputSchema.properties.roleChangeQuote, { type: "string", maxLength: 4000 });
    return response;
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", model: MODEL_CATALOG.luna.id, memory }, event: {}, baseVersion: 0,
    context: {}, runningSessions: [] } as unknown as Parameters<typeof hooks.maintain>[0];
  const output = { ...memory, roleChangeQuote: "" };
  for (const text of [JSON.stringify(output), `${JSON.stringify(output)} \r\n\t`, `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``]) {
    response = text;
    assert.deepEqual(await hooks.maintain(input), output);
  }
});

test("memory maintenance returns roleChangeQuote beside the memory fields and rejects an invalid quote", async () => {
  let response = "";
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => response } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", model: MODEL_CATALOG.luna.id, memory }, event: {}, baseVersion: 0,
    context: {}, runningSessions: [] } as unknown as Parameters<typeof hooks.maintain>[0];
  response = JSON.stringify({ ...memory, rolePrompt: "Own billing", roleChangeQuote: "billing 交俾你負責" });
  assert.deepEqual(await hooks.maintain(input), { ...memory, rolePrompt: "Own billing", roleChangeQuote: "billing 交俾你負責" });
  // A helper that ignores outputSchema and omits the quote keeps its memory update; the service then rejects any role change.
  response = JSON.stringify(memory);
  assert.deepEqual(await hooks.maintain(input), { ...memory, roleChangeQuote: "" });
  for (const roleChangeQuote of [null, 7, "x".repeat(4001)]) {
    response = JSON.stringify({ ...memory, roleChangeQuote });
    await assert.rejects(hooks.maintain(input), /roleChangeQuote/);
  }
});

test("memory maintenance prompt prioritises decisions, recurring issues and methods and demotes one-off content", async () => {
  let prompt = "";
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, text: string) => {
    prompt = text; return JSON.stringify(memory);
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", model: MODEL_CATALOG.luna.id, memory }, event: {}, baseVersion: 0,
    context: {}, runningSessions: [] } as unknown as Parameters<typeof hooks.maintain>[0];
  assert.deepEqual(await hooks.maintain(input), { ...memory, roleChangeQuote: "" });
  assert.equal(prompt, actorMemoryMaintenancePrompt({ memory, event: {}, baseVersion: 0, context: {}, runningSessions: [] }));
  // Only the relative order of the longTerm sections is contractual, not the wording around them.
  const longTerm = prompt.split("\n\n").find(paragraph => paragraph.startsWith("longTerm holds")) ?? "";
  const order = ["standingDecisions", "recurringIssues", "methods"].map(key => longTerm.search(new RegExp(`\\b${key}\\b`)));
  assert.ok(order.every(index => index >= 0) && order[0] < order[1] && order[1] < order[2], "priority order in longTerm guidance");
  for (const key of ["standingDecisions", "recurringIssues", "methods"]) assert.ok(prompt.split("\n\n").some(paragraph => paragraph.includes(`${key} holds`)), key);
  // One source reference per entry: the task session, else the round; never turn or task-event ids.
  assert.match(prompt, /roleChangeQuote/);
  assert.match(prompt, /exactly one reference/);
  assert.ok(!prompt.includes("session/turn"), "no instruction to keep turn references");
});

test("actor memory eval fixture holds valid memory and keeps rubrics out of the generated prompt", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/actorMemory.eval.json", import.meta.url), "utf8")) as
    Array<{ id: string; memory: typeof memory; event: unknown; context: unknown; rubric: string[] }>;
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) {
    validateActorMemory(item.memory);
    assert.ok(item.rubric.length > 0, item.id);
    const prompt = actorMemoryMaintenancePrompt({ memory: item.memory, event: item.event, baseVersion: 0, context: item.context, runningSessions: [] });
    for (const line of item.rubric) assert.ok(!prompt.includes(line), `${item.id} rubric leaked`);
  }
});

test("memory maintenance rejects trailing content, truncation and invalid structures without salvaging JSON", async () => {
  let response = "";
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => response } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", model: MODEL_CATALOG.luna.id, memory }, event: {}, baseVersion: 0,
    context: {}, runningSessions: [] } as unknown as Parameters<typeof hooks.maintain>[0];
  const valid = JSON.stringify(memory);
  for (const text of [valid + " extra", valid + valid, valid.slice(0, -1), "null", "[]",
    JSON.stringify({ ...memory, rolling: null }), JSON.stringify({ rolePrompt: "Role" }),
    JSON.stringify({ ...memory, extra: "unexpected" }), JSON.stringify({ ...memory, roleSummary: "x".repeat(4001) })]) {
    response = text;
    await assert.rejects(hooks.maintain(input));
    assert.deepEqual(input.actor.memory, memory);
  }
});
test("actor reservation uses saved project cwd, preserves existing sessions and retains the legacy fallback", async () => {
  let session: { id: string; workspaceId: string; cwd: string } | undefined;
  const store = {
    getWorkspace: async () => ({ cwd: "/workspace-changed" }), normalizeMetadata: () => ({ title: "task" }),
    upsertSession: async (input: typeof session, options: { createOnly?: boolean }) => {
      assert.equal(options.createOnly, true); session ??= input; return session;
    },
    getSessionTurn: async () => ({ sessionId: "reserved" })
  };
  const hooks = actorModelHooks(store as unknown as SessionStore, {} as SessionSummarizer, "http://localhost");
  const input = { workspaceId: "ws", sessionId: "reserved", turnId: "turn", userPrompt: "fix", executor: { name: "Actor" }, workItem: {},
    taskBinding: { workspaceId: "ws", projectId: "project", cwd: "/chosen", source: "explicit" } } as Parameters<typeof hooks.startTask>[0];
  await hooks.startTask(input); assert.equal(session?.cwd, "/chosen");
  await hooks.startTask({ ...input, taskBinding: { ...input.taskBinding!, cwd: "/new-choice" } });
  assert.equal(session?.cwd, "/chosen", "retry cannot rebind an existing reservation");
  session = undefined;
  await hooks.startTask({ ...input, taskBinding: undefined }); assert.equal((session as { cwd: string } | undefined)?.cwd, "/workspace-changed");
  await assert.rejects(hooks.startTask({ ...input, taskBinding: { ...input.taskBinding!, workspaceId: "other" } }), /another workspace/);
});
test("automatic continuation checks project, binding and idle state, preserves model choice and recovers a lost receipt", async () => {
  let posts = 0, body: Record<string, unknown> = {}, running = false, queued = false, wrongProject = false, wrongBinding = false, saved = false;
  const work = { id: "work", roundId: "round", taskSessionId: "session", dispatchKey: "work", executorActorId: "actor", model: MODEL_CATALOG.astra.id, executionEffort: "high", workflowAssessment: "substantial_managed" as const };
  let approvalPolicy: string | undefined;
  const store = {
    resolveApprovalPolicy: async () => approvalPolicy,
    getSessionTurn: async () => saved ? { sessionId: "session", userInput: "Continue UI" } : null,
    getWorkspace: async () => ({ cwd: "/workspace" }),
    getSession: async () => ({ id: "session", workspaceId: "ws", cwd: wrongProject ? "/other" : "/project" }),
    getDomainActorRoom: async () => ({ rounds: [{ id: "round", taskBinding: { workspaceId: "ws", cwd: "/project", source: "explicit" } }], workItems: [{ ...work, executorActorId: wrongBinding ? "other" : "actor" }] }),
    getLatestRunningTurn: async () => running ? { id: "active" } : null,
    listPendingSessionTurns: async () => queued ? [{ session: { id: "session" } }] : []
  };
  const hooks = actorModelHooks(store as unknown as SessionStore, {} as SessionSummarizer, "http://localhost");
  const input = { workspaceId: "ws", workItem: work, userPrompt: "Continue UI", requestId: "continue", idleOnly: true } as Parameters<NonNullable<typeof hooks.updateTask>>[0];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { posts++; body = JSON.parse(String(options?.body)); return new Response("{}", { status: 200 }); };
  try {
    for (const failure of ["running", "queued", "project", "binding"]) {
      running = failure === "running"; queued = failure === "queued"; wrongProject = failure === "project"; wrongBinding = failure === "binding";
      await assert.rejects(hooks.updateTask!(input), /running or queued|project or actor binding/);
      assert.equal(posts, 0);
    }
    running = queued = wrongProject = wrongBinding = false;
    await hooks.updateTask!(input);
    assert.equal(posts, 1); assert.equal(body.sessionId, "session"); assert.equal(body.model, MODEL_CATALOG.astra.id);
    assert.equal(body.modelReasoningEffort, "high"); assert.equal(body.requireIdleSession, true);
    assert.match(String(body.developerInstructions), /Saved workflow assessment: substantial_managed/);
    assert.equal(body.managedMode, undefined, "reusing a session does not carry mode authorization");
    assert.equal(body.approvalPolicy, undefined, "no resolved policy means none is sent");
    const turnId = body.turnId;
    running = queued = true;
    const promptOrigin = { kind: "inter-actor" as const, trigger: "fast-track" as const, sourceActorId: "actor", sourceRoundId: "r2" };
    approvalPolicy = "never";
    assert.deepEqual(await hooks.updateTask!({ ...input, idleOnly: false, promptOrigin }), { queuedBehind: 2 }, "reports the turns ahead of the queued update");
    approvalPolicy = undefined;
    assert.equal(body.approvalPolicy, "never", "a queued update carries the session's resolved policy");
    assert.equal(posts, 2); assert.equal(body.turnId, turnId);
    assert.deepEqual(body.promptOrigin, promptOrigin, "the origin travels in the pending-turn body");
    assert.equal(body.modelReasoningEffort, "high", "a queued update still carries the reasoning effort");
    assert.equal(body.requireIdleSession, undefined, "fast track queues behind active work");
    assert.equal(body.developerInstructions, undefined, "no Actors-chat source means no added note");
    assert.equal(body.message, "Continue UI");
    const note = "[Threadex Actors room message] Source: Actors group chat (workspace ws; round r2). Sender: the user.";
    const userPrompt = "上面又出現actors 係group chat 讀取失敗\n\n  keep   spacing ";
    await hooks.updateTask!({ ...input, requestId: "from-chat", userPrompt, idleOnly: false, sourceNote: note });
    assert.equal(posts, 3);
    assert.equal(body.message, userPrompt, "the user's group chat text is delivered verbatim");
    assert.equal(body.developerInstructions, note, "the source note travels as a developer note, not as user text");
    running = queued = false;
    await hooks.updateTask!({ ...input, requestId: "from-chat-idle", sourceNote: note });
    assert.equal(posts, 4); assert.equal(body.message, "Continue UI");
    assert.equal(body.promptOrigin, undefined, "no origin is invented when the caller supplies none");
    assert.match(String(body.developerInstructions), /^\[Threadex Actors room message\][\s\S]*Saved workflow assessment: substantial_managed/);
    running = queued = true;
    await hooks.updateTask!({ ...input, requestId: "reuse-running", idleOnly: false, workflowGuidance: true });
    assert.equal(posts, 5); assert.equal(body.requireIdleSession, undefined, "a reused session queues behind running work");
    assert.match(String(body.developerInstructions), /Saved workflow assessment: substantial_managed/, "queued session reuse keeps workflow guidance");
    wrongBinding = true;
    await assert.rejects(hooks.updateTask!({ ...input, idleOnly: false }), /project or actor binding/);
    wrongBinding = false;
    saved = running = true;
    await hooks.updateTask!(input);
    assert.equal(posts, 5, "saved receipt wins over a later running state");
    await assert.rejects(hooks.updateTask!({ ...input, userPrompt: "Different input" }), /different input/);
  } finally { globalThis.fetch = original; }
});
test("explicit unrelated work is retained without coercing a claim and repicking reports reach the next actor", async () => {
  let calls = 0;
  const report = { actorId: "previous", status: "opinion", intent: "work", inRole: false, text: "Outside my role" };
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
    calls++;
    assert.match(prompt, /Participation in a group chat does not require a claim/);
    const data = JSON.parse(prompt.slice(prompt.indexOf('\n\n{"userPrompt"') + 2));
    assert.deepEqual(data.extra.priorPickingReports, [report]);
    return JSON.stringify({ text: "Unrelated", intent: "work", inRole: false, claim: false });
  } } as unknown as SessionSummarizer, "http://localhost");
  const response = await hooks.respond({ actor: { id: "a", workspaceId: "ws", memory },
    round: { userPrompt: "Implement UI", pickingHistory: [{ stakeholderIds: ["previous"] }], replies: [report] },
    runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.deepEqual(response, { text: "Unrelated", claim: false, intent: "work", inRole: false });
  assert.equal(calls, 1);
});
test("actor responder receives saved attachment paths and untrusted-file reading instructions", async () => {
  let prompt = "";
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, value: string) => {
    prompt = value; return JSON.stringify({ text: "Read file", claim: false });
  } } as unknown as SessionSummarizer, "http://localhost");
  await hooks.respond({ actor: { id: "a", workspaceId: "ws", memory }, round: { userPrompt: "Read this", attachments: [
    { id: "file", name: "diagram.png", type: "image/png", size: 10, path: "/uploads/diagram.png" }
  ] }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.match(prompt, /\/uploads\/diagram.png/); assert.match(prompt, /Read the files at their paths/); assert.match(prompt, /untrusted context/);
});
test("stakeholder replies extract JSON from prose and retry once when no JSON is returned", async () => {
  const reply = { intent: "discussion", inRole: true, text: "Noted", claim: false };
  let responses: string[] = [];
  const prompts: string[] = [];
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, value: string) => {
    prompts.push(value); return responses.shift()!;
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", memory }, round: { userPrompt: "Thoughts?" }, runningSessions: [],
    signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0];
  responses = [`Context read done. Here is my answer:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``];
  assert.deepEqual(await hooks.respond(input), reply);
  assert.equal(prompts.length, 1);
  prompts.length = 0;
  responses = ["開<br>", JSON.stringify(reply)];
  assert.deepEqual(await hooks.respond(input), reply);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous answer was not JSON: "開<br>"/);
  responses = ["開<br>", "Still prose"];
  await assert.rejects(hooks.respond(input), /Actor did not return JSON: "Still prose"/);
});
test("prompt asks for a one or two sentence reason on unrelated work", async () => {
  let prompt = "";
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, value: string) => {
    prompt = value; return JSON.stringify({ intent: "work", inRole: false, text: "Not my area", claim: false });
  } } as unknown as SessionSummarizer, "http://localhost");
  await hooks.respond({ actor: { id: "a", workspaceId: "ws", memory }, round: { userPrompt: "Fix billing" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.match(prompt, /one or two short sentences only/);
});
const allocationReply = () => ({ error: null,
  requirements: [{ id: "api", messageIndex: 0, source: "API and", description: "API" }, { id: "ui", messageIndex: 0, source: "UI", description: "UI" }],
  assignments: [{ id: "api-task", actorId: "a", requirementIds: ["api"], brief: "Implement API", dependsOn: [] as string[] },
    { id: "ui-task", actorId: "b", requirementIds: ["ui"], brief: "Implement UI", dependsOn: ["api-task"] }],
  review: { overlaps: [], conflicts: [], uncovered: [] } });
const allocationRound = { id: "r", actorSnapshots: [{ workspaceId: "ws", model: MODEL_CATALOG.astra.id }],
  replies: [{ actorId: "a", status: "claimed" }, { actorId: "b", status: "claimed" }] };

test("partial claim parsing retains its concrete scope and rejects an unspecified portion", async () => {
  let claim: Record<string, unknown> = { intent: "work", inRole: true, text: "I own API", claim: true, claimKind: "partial", claimScope: "API only; UI excluded", preparedPrompt: "Implement API" };
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => JSON.stringify(claim) } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "a", workspaceId: "ws", memory }, round: { userPrompt: "API and UI" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0];
  const result = await hooks.respond(input);
  assert.equal(result.claimKind, "partial"); assert.equal(result.claimScope, "API only; UI excluded");
  for (const scope of [undefined, "", " ", 123, "x".repeat(12001)]) {
    claim = { ...claim, claimScope: scope }; await assert.rejects(hooks.respond(input), /Invalid actor response/);
  }
});

test("partial planning uses the existing middle tier in the prompt's provider group independent of actor defaults", async () => {
  const calls: Array<{ model?: string; effort?: string }> = [];
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, task: string, prompt: string, options: { model?: string; effort?: string }) => {
    assert.equal(task, "actor_allocation"); assert.match(prompt, /overlaps, conflicts and uncovered/);
    assert.match(prompt, /corrections/); calls.push(options); return JSON.stringify(allocationReply());
  } } as unknown as SessionSummarizer, "http://localhost");
  for (const initiating of [MODEL_CATALOG.luna.id, MODEL_CATALOG.claudeOpus.id]) {
    await hooks.planClaims!({ round: { ...allocationRound, responseProfile: { model: initiating, effort: "high" } }, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]);
  }
  assert.deepEqual(calls.map(c => c.model), [MODEL_CATALOG.sol61.id, MODEL_CATALOG.claudeSonnet.id]);
  assert.ok(calls.every(c => c.effort === "high"));
});

test("invalid planner output receives precise feedback once, then returns a validated complete allocation", async () => {
  const prompts: string[] = [];
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string, options: { outputSchema?: { properties?: Record<string, unknown> } }) => {
    prompts.push(prompt);
    assert.ok(options.outputSchema?.properties?.requirements);
    const plan = allocationReply();
    if (prompts.length === 1) plan.assignments[1].dependsOn = ["a"];
    return JSON.stringify(plan);
  } } as unknown as SessionSummarizer, "http://localhost");
  const result = await hooks.planClaims!({ round: allocationRound, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]) as { requirements: Array<{ start: number; end: number }> };
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /unknown_dependency/);
  assert.match(prompts[1], /Previous invalid response/);
  assert.deepEqual(result.requirements.map(r => [r.start, r.end]), [[0, 7], [8, 10]]);
});

test("persistent invalid planner output stops after two attempts with the actual coverage reason", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; const plan = allocationReply(); plan.requirements[0].source = "API"; return JSON.stringify(plan);
  } } as unknown as SessionSummarizer, "http://localhost");
  await assert.rejects(hooks.planClaims!({ round: allocationRound, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]),
    /after two attempts.*source_gap.*offsets 3–8/);
  assert.equal(calls, 2);
});

test("malformed JSON is repaired once but transport failures are not retried as invalid plans", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; return calls === 1 ? "not JSON" : JSON.stringify(allocationReply());
  } } as unknown as SessionSummarizer, "http://localhost");
  await hooks.planClaims!({ round: allocationRound, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]);
  assert.equal(calls, 2);
  let failures = 0;
  const unavailable = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => { failures++; throw new Error("service unavailable"); } } as unknown as SessionSummarizer, "http://localhost");
  await assert.rejects(unavailable.planClaims!({ round: allocationRound, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]), /service unavailable/);
  assert.equal(failures, 1);
});

test("an explicit unresolved allocation remains blocked rather than prompting the planner to invent a resolution", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; return JSON.stringify({ error: "Canonical constraints require incompatible outcomes", requirements: [], assignments: [], review: { overlaps: [], conflicts: [], uncovered: [] } });
  } } as unknown as SessionSummarizer, "http://localhost");
  await assert.rejects(hooks.planClaims!({ round: allocationRound, messages: ["API and UI"] } as unknown as Parameters<NonNullable<typeof hooks.planClaims>>[0]), /unresolved_plan.*incompatible outcomes/);
  assert.equal(calls, 1);
});

test("stakeholder replies and memory-range follow-up use the round gearbox model and effort", async () => {
  const calls: Array<{ model?: string; effort?: string }> = [];
  let events = 0;
  const store = { getDomainActorRoom: async () => null } as unknown as SessionStore;
  const summarizer = { runBackgroundJsonTask: async (_workspace: string, _task: string, _prompt: string, options: { model?: string; effort?: string; onEvent?: (event: unknown) => void }) => {
    calls.push(options);
    options.onEvent?.({ method: "item/reasoning/summaryTextDelta" });
    return calls.length === 1 ? JSON.stringify({ memoryRead: { field: "longTerm", offset: 0, bytes: 128 } })
      : JSON.stringify({ text: "Advice", claim: false });
  } } as unknown as SessionSummarizer;
  const hooks = actorModelHooks(store, summarizer, "http://localhost:8787");
  const input = { actor: { id: "actor", workspaceId: "ws", rootActorId: "actor", model: "gpt-6-luna", effort: "medium", allowedModels: ["gpt-6-luna"], memory },
    round: { id: "round", userPrompt: "Give advice", namedActorIds: ["actor"], responseProfile: { model: "gpt-6-sol", effort: "high" } },
    runningSessions: [], signal: new AbortController().signal, onEvent: () => { events++; } } as unknown as Parameters<typeof hooks.respond>[0];
  assert.equal((await hooks.respond(input)).text, "Advice");
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [
    { model: "gpt-6-sol", effort: "high" }, { model: "gpt-6-sol", effort: "high" }
  ]);
  assert.equal(input.actor.model, "gpt-6-luna", "the actor's identity and task permissions are unchanged");
  assert.equal(events, 2, "both initial and memory-range inference renew activity");
});

test("stakeholder prompt includes intact prior room conversation across roots and excludes later turns on retry", async () => {
  let prompt = "";
  // Long, but below the unknown-window admission budget left after the stakeholder instructions.
  const ownText = "Own response ".repeat(250);
  const room = { rounds: [
    { id: "past", userPrompt: "Earlier request", status: "no_claims", replies: [
      { actorId: "self", status: "opinion", text: ownText }, { actorId: "other-root", status: "opinion", text: "Peer reply" }] },
    { id: "current", userPrompt: "Can you implement that?", status: "responding", replies: [] },
    { id: "future", userPrompt: "Future request", status: "no_claims", replies: [{ actorId: "self", status: "opinion", text: "Future secret" }] }
  ] };
  const hooks = actorModelHooks({ getDomainActorRoom: async () => room } as unknown as SessionStore,
    { runBackgroundJsonTask: async (_workspace: string, _purpose: string, input: string) => { prompt = input; return JSON.stringify({ text: "Taking this", claim: true, preparedPrompt: "Implement the agreed endpoint without changing its contract." }); } } as unknown as SessionSummarizer, "http://localhost");
  await hooks.respond({ actor: { id: "self", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: room.rounds[1], treeActors: [], runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  const context = JSON.parse(prompt.slice(prompt.indexOf('{"userPrompt"')));
  assert.equal(context.conversationHistory.find((row: any) => row.actorId === "self").text, ownText);
  assert.equal(context.conversationHistory.find((row: any) => row.actorId === "other-root").text, "Peer reply");
  assert.equal(prompt.includes("Future secret"), false);
  assert.match(prompt, /intent defaults to "work"/);
  assert.match(prompt, /requests phrased as questions/);
  assert.match(prompt, /Task workflow preferences, not requirements: prefer Managed mode/);
  assert.match(prompt, /carry this preference into the execution brief/);
  assert.ok(prompt.includes(ACTOR_WORKLOAD_ASSESSMENT));
  assert.match(prompt, /prioritize considering Managed mode for larger tasks/);
  assert.match(prompt, /bounded portions with clear ownership, dependencies, integration and verification/);
  assert.match(prompt, /Small, clear, self-contained tasks may proceed directly/);
  assert.match(prompt, /Task size alone never authorizes delegation/);
  assert.match(prompt, /If Managed mode is OFF, unavailable or unauthorized, continue directly within scope/);
  assert.match(prompt, /objective, relevant context and work continuity match/);
  assert.match(prompt, /never mix unrelated context merely to reuse a session/);
});

test("individual-round stakeholder prompt replays only the actor tree while group rounds keep peer replies", async () => {
  const room = { actors: [
    { id: "self", rootActorId: "self", parentActorId: null },
    { id: "self-sub", rootActorId: "self", parentActorId: "self" },
    { id: "other-root", rootActorId: "other-root", parentActorId: null }
  ], rounds: [
    { id: "past", userPrompt: "Earlier group request", status: "no_claims", namedActorIds: [], replies: [
      { actorId: "self", status: "opinion", text: "Own group reply" }, { actorId: "other-root", status: "opinion", text: "Peer group reply" }] },
    { id: "private-other", userPrompt: "Other private request", status: "no_claims", namedActorIds: ["other-root"], replies: [
      { actorId: "other-root", status: "opinion", text: "Peer private reply" }] },
    { id: "private-self", userPrompt: "Own private request", status: "no_claims", namedActorIds: ["self"], replies: [
      { actorId: "self-sub", status: "opinion", text: "Sub private reply" }] },
    { id: "individual", userPrompt: "Just you: continue", status: "responding", namedActorIds: ["self"], replies: [] },
    { id: "group", userPrompt: "Everyone: continue", status: "responding", namedActorIds: [], replies: [] }
  ] };
  const prompts: string[] = [];
  const hooks = actorModelHooks({ getDomainActorRoom: async () => room } as unknown as SessionStore,
    { runBackgroundJsonTask: async (_workspace: string, _purpose: string, input: string) => { prompts.push(input); return JSON.stringify({ text: "Noted", claim: false }); } } as unknown as SessionSummarizer, "http://localhost");
  const respond = (round: (typeof room.rounds)[number]) => hooks.respond({ actor: { id: "self", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round, treeActors: [], runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  await respond(room.rounds[3]);
  await respond(room.rounds[4]);
  const [individual, group] = prompts;
  assert.ok(individual.includes("Own group reply") && individual.includes("Sub private reply"));
  assert.equal(individual.includes("Peer group reply"), false, "individual chats exclude peers even from earlier group rounds");
  assert.equal(individual.includes("Peer private reply"), false);
  assert.match(individual, /private individual conversation between the user and your actor tree/);
  assert.doesNotMatch(individual, /up to two recent rounds from each peer/);
  assert.ok(group.includes("Peer group reply") && group.includes("Sub private reply"));
  assert.equal(group.includes("Peer private reply"), false, "another tree's individual round stays private in group rounds");
  assert.match(group, /up to two recent rounds from each peer/);
});

test("claim title is requested, cleaned of actor prefixes and optional for the claim", async () => {
  let reply: Record<string, unknown> = { intent: "work", inRole: true, text: "Taking this", claim: true, preparedPrompt: "Implement it", title: "Actor One：\n改 claim title" };
  let prompt = "";
  const hooks = actorModelHooks({} as SessionStore,
    { runBackgroundJsonTask: async (_workspace: string, _purpose: string, input: string) => { prompt = input; return JSON.stringify(reply); } } as unknown as SessionSummarizer, "http://localhost");
  const respond = () => hooks.respond({ actor: { id: "actor-1", name: "Actor One", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { id: "round", userPrompt: "Change titles", replies: [] }, treeActors: undefined, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.equal((await respond()).title, "改 claim title");
  assert.match(prompt, /title\?:string/);
  assert.match(prompt, /No actor name, id or prefix/);
  for (const title of [null, 7, "actor-1: "]) {
    reply = { ...reply, title };
    const result = await respond();
    assert.equal(result.claim, true);
    assert.equal("title" in result, false);
  }
  reply = { intent: "discussion", inRole: true, text: "Opinion", claim: false, title: "Ignored" };
  assert.equal("title" in await respond(), false);
});

test("actor task session uses the claim title without an actor prefix and protects it from the summariser", async () => {
  const originalFetch = globalThis.fetch;
  let queued = false;
  globalThis.fetch = async () => { queued = true; return new Response("{}", { status: 200 }); };
  const sessions: Array<Record<string, unknown>> = [];
  try {
    const store = {
      getWorkspace: async () => ({ cwd: "/tmp/project" }),
      normalizeMetadata: (input: { title?: string }, fallback: string) => ({ title: input.title ?? `derived:${fallback}`, description: fallback, keywordWeights: {}, parentSessionId: null }),
      upsertSession: async (input: Record<string, unknown>) => { queued = false; sessions.push(input); return { ...input, workspaceId: "workspace" }; },
      getSessionTurn: async () => queued ? { id: "turn", sessionId: "tx_task" } : null, resolveApprovalPolicy: async () => null,
      getSessionModelPreferences: async () => ({ activeGearIndex: 0, gearProfiles: [{ model: "gpt-6-luna", effort: "medium" }] }),
      setSessionModelPreferences: async () => {}
    } as unknown as SessionStore;
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost:8787");
    const start = (workItem: Record<string, unknown>) => hooks.startTask({ workspaceId: "workspace", sessionId: "tx_task", turnId: "turn",
      userPrompt: "Canonical request", requestId: "request", executor: { name: "Actor", id: "actor", rootActorId: "actor", effort: "medium" },
      workItem: { model: "gpt-6-luna", preparedPrompt: "Brief", ...workItem }, advisories: [], memory } as unknown as Parameters<typeof hooks.startTask>[0]);
    await start({ title: "改 claim title" });
    await start({});
    await start({ delegatedTask: "Delegated part" });
    assert.deepEqual(sessions.map(session => [session.title, session.titleSource, session.description]), [
      ["改 claim title", "actor", "Canonical request"],
      ["derived:Canonical request", "actor", "Canonical request"],
      ["derived:Delegated part", "actor", "Canonical request"]
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test("actor reservation retry returns the existing turn without dispatching another prompt", async () => {
  let queued = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { queued++; throw new Error("Must not enqueue an existing reservation"); };
  try {
    const store = {
      getWorkspace: async () => ({ cwd: "/tmp/project" }),
      normalizeMetadata: () => ({ title: "task", description: "", keywordWeights: {} }),
      upsertSession: async (input: unknown, options: unknown) => {
        assert.deepEqual(options, { createOnly: true });
        return { ...(input as object), id: "tx_reserved", workspaceId: "workspace" };
      },
      getSessionModelPreferences: async () => ({ activeGearIndex: 0, gearProfiles: [{ model: "gpt-6-luna", effort: "medium" }] }),
      setSessionModelPreferences: async () => {},
      getSessionTurn: async () => ({ id: "turn", sessionId: "tx_reserved", status: "running" })
    } as unknown as SessionStore;
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost:8787");
    const result = await hooks.startTask({ workspaceId: "workspace", sessionId: "tx_reserved", turnId: "turn",
      userPrompt: "Canonical request", requestId: "reservation", executor: { name: "Actor", id: "actor", rootActorId: "actor", effort: "medium" },
      workItem: { model: "gpt-6-luna" }, advisories: [], memory } as unknown as Parameters<typeof hooks.startTask>[0]);
    assert.deepEqual(result, { sessionId: "tx_reserved", turnId: "turn" });
    assert.equal(queued, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("task launch carries prior chat and the full delegated portion while preserving the canonical user request", async () => {
  const originalFetch = globalThis.fetch;
  let queued: Record<string, any> | null = null;
  globalThis.fetch = async (_url, init) => { queued = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); };
  try {
    const store = {
      getWorkspace: async () => ({ cwd: "/tmp/project" }), normalizeMetadata: () => ({ title: "task" }),
      upsertSession: async (input: unknown) => input,
      resolveApprovalPolicy: async () => undefined,
      getSessionTurn: async () => queued ? { id: "turn", sessionId: "session" } : null,
      getSessionModelPreferences: async () => ({ activeGearIndex: 0, gearProfiles: [] }), setSessionModelPreferences: async () => {},
      getDomainActorRoom: async () => ({ rounds: [
        { id: "prior", status: "no_claims", userPrompt: "Implement an API", replies: [{ actorId: "actor", status: "opinion", text: "Use the agreed endpoint" }] },
        { id: "round", status: "assigned", contextRoundIds: ["prior"], replies: [] }
      ] })
    } as unknown as SessionStore;
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost");
    const delegatedTask = "Implement the agreed API " + "細節".repeat(600);
    await hooks.startTask({ workspaceId: "workspace", sessionId: "session", turnId: "turn", requestId: "request",
      userPrompt: "  Implement the API.  ", executor: { id: "actor", name: "Actor", rootActorId: "actor", effort: "medium" },
      promptOrigin: { kind: "inter-actor", trigger: "decision-dispatch", sourceActorId: "owner", sourceRoundId: "round" },
      workItem: { model: "gpt-6-luna", workflowAssessment: "substantial_managed", roundId: "round", delegatedTask, preparedPrompt: delegatedTask, parentPreparedPrompt: "Implement API and UI together", executionEffort: "high",
        canonicalUserMessages: ["  Implement the API.  ", "Ask other actors to implement the API and UI concurrently."] },
      attachments: [{ id: "file", name: "spec.txt", type: "text/plain", size: 4, path: "/uploads/spec.txt" }],
      advisories: [{ actorId: "actor", text: "I will keep the existing API contract and verify errors", untrusted: true }], memory
    } as unknown as Parameters<typeof hooks.startTask>[0]);
    const body = queued as unknown as { message: string; developerInstructions: string; modelReasoningEffort: string };
    assert.deepEqual((queued as unknown as { attachments: unknown }).attachments, [{ id: "file", name: "spec.txt", type: "text/plain", size: 4, path: "/uploads/spec.txt" }]);
    assert.ok(body.message.includes("Original user request (canonical authorization):\n  Implement the API.  \n\n"));
    assert.ok(body.message.includes("Additional original user instruction (canonical authorization):\nAsk other actors to implement the API and UI concurrently."));
    assert.equal(body.message.split("  Implement the API.  ").length - 1, 1, "do not display the original request twice");
    assert.ok(body.message.endsWith(`Actor-prepared execution brief (assigned portion only):\n${delegatedTask}`));
    assert.equal(body.message.includes("Implement API and UI together"), false, "the parent brief is context, never the child's main execution scope");
    assert.equal(body.modelReasoningEffort, "high", "use the execution effort evaluated at selection, not a different actor default");
    assert.deepEqual((queued as unknown as Record<string, unknown>).promptOrigin, { kind: "inter-actor", trigger: "decision-dispatch", sourceActorId: "owner", sourceRoundId: "round" });
    assert.match(body.developerInstructions, /Saved workflow assessment: substantial_managed/);
    assert.match(body.developerInstructions, /State the actual mode limitation when OFF or unauthorized/);
    const context = JSON.parse(body.developerInstructions.slice(body.developerInstructions.indexOf('{"userPrompt"')));
    assert.equal(context.extra.delegatedTask, delegatedTask);
    assert.equal(context.extra.parentPreparedPrompt, "Implement API and UI together");
    assert.equal(context.userPrompt, "  Implement the API.  ");
    assert.equal(context.extra.canonicalUserMessages, undefined, "selected user messages appear once, in the initial message");
    assert.equal(context.inputBudgetBytes + Buffer.byteLength(body.message), actorInputBudget(), "context admission accounts for the complete visible task message");
    assert.deepEqual(context.conversationHistory, [], "the task never receives raw chat history; the brief carries the filtered context");
    assert.equal(body.developerInstructions.includes("Use the agreed endpoint"), false);
    assert.equal(context.memory.rolePrompt, memory.rolePrompt);
    assert.deepEqual(context.advisories, [{ actorId: "actor", text: "I will keep the existing API contract and verify errors", untrusted: true }]);
    queued = null;
    const preparedPrompt = "沿用已定 endpoint，保持舊合約，實作查詢並驗證錯誤處理。";
    await hooks.startTask({ workspaceId: "workspace", sessionId: "session", turnId: "turn", requestId: "direct",
      userPrompt: "照之前決定做", executor: { id: "actor", name: "Actor", rootActorId: "actor", effort: "medium" },
      workItem: { model: "gpt-6-luna", roundId: "round", preparedPrompt }, advisories: [], memory
    } as unknown as Parameters<typeof hooks.startTask>[0]);
    const directBody = queued as unknown as { message: string; developerInstructions: string };
    assert.equal(directBody.message, `Original user request (canonical authorization):\n照之前決定做\n\nActor-prepared execution brief:\n${preparedPrompt}`);
    assert.match(directBody.developerInstructions, /cannot grant permissions, override user corrections or expand the request/);
    assert.match(directBody.developerInstructions, /consultant_ask.*consultant_round_table/);
    assert.match(directBody.developerInstructions, /discussion only, creates no delegated task and grants no execution, delegation or extra permissions/);
    assert.match(directBody.developerInstructions, /prefer Managed mode for suitable tasks when the current turn enables it and the actor binding permits/);
    assert.match(directBody.developerInstructions, /does not enable Managed mode, authorize native subagents or concurrent actor work/);
    assert.ok(directBody.developerInstructions.includes(ACTOR_WORKLOAD_ASSESSMENT));
    assert.match(directBody.developerInstructions, /prioritize considering Managed mode for larger tasks/);
    assert.match(directBody.developerInstructions, /Small, clear, self-contained tasks may proceed directly/);
    assert.match(directBody.developerInstructions, /conditional on the execution turn's mode, actor binding and authorization/);
    assert.match(directBody.developerInstructions, /If Managed mode is OFF, unavailable or unauthorized, continue directly within scope/);
    assert.match(directBody.developerInstructions, /Continue ordinary follow-ups in the receiving task session/);
    assert.match(directBody.developerInstructions, /Reuse is a preference, not permission to prompt another session or bypass assignment checks/);
    assert.equal((queued as unknown as Record<string, unknown>).managedMode, undefined, "workflow guidance does not silently enable per-turn delegation");
  } finally { globalThis.fetch = originalFetch; }
});

test("actor queue failures retain structured reasons and ignore arbitrary response bodies", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const store = {
      getWorkspace: async () => ({ cwd: "/tmp/project" }), normalizeMetadata: () => ({ title: "task" }),
      upsertSession: async (input: unknown) => input, resolveApprovalPolicy: async () => undefined,
      getSessionTurn: async () => null,
      getSessionModelPreferences: async () => ({ activeGearIndex: 0, gearProfiles: [] }), setSessionModelPreferences: async () => {}
    } as unknown as SessionStore;
    const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost");
    for (const [body, expected] of [
      [JSON.stringify({ error: "Reservation rejected" }), "HTTP 500: Reservation rejected"],
      ["<html>private proxy diagnostics</html>", "HTTP 500. Retry"],
      [JSON.stringify({ error: { private: "details" } }), "HTTP 500. Retry"]
    ]) {
      globalThis.fetch = async () => new Response(body, { status: 500 });
      await assert.rejects(hooks.startTask({ workspaceId: "workspace", sessionId: "session", turnId: "turn", requestId: "request",
        userPrompt: "Implement this", executor: { id: "actor", name: "Actor", rootActorId: "actor", effort: "medium" },
        workItem: { model: "gpt-6-luna", preparedPrompt: "Implement this" }, advisories: [], memory
      } as unknown as Parameters<typeof hooks.startTask>[0]), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(expected));
        assert.ok(!error.message.includes("private"));
        return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("actor launch carries the selected policy without overriding saved session settings", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const selected of ["granular", "never", "untrusted", "on-request", undefined] as const) {
      for (const saved of [undefined, "on-request"] as const) {
        let queued: Record<string, unknown> | undefined;
        globalThis.fetch = async (_url, init) => { queued = JSON.parse(String(init?.body)); return new Response("{}"); };
        const store = {
          getWorkspace: async () => ({ cwd: "/tmp/project" }), normalizeMetadata: () => ({ title: "task" }),
          upsertSession: async (input: unknown) => input,
          resolveApprovalPolicy: async (sessionId: string, turnId: string) => {
            assert.equal(sessionId, "session"); assert.equal(turnId, "turn"); return saved;
          },
          getSessionTurn: async () => queued ? { id: "turn", sessionId: "session" } : null,
          getSessionModelPreferences: async () => ({ activeGearIndex: 0, gearProfiles: [] }), setSessionModelPreferences: async () => {}
        } as unknown as SessionStore;
        const hooks = actorModelHooks(store, {} as SessionSummarizer, "http://localhost");
        await hooks.startTask({ workspaceId: "workspace", sessionId: "session", turnId: "turn", requestId: "request",
          approvalPolicy: selected, userPrompt: "Implement this", executor: { id: "actor", name: "Actor", rootActorId: "actor", effort: "medium" },
          workItem: { model: "gpt-6-luna", preparedPrompt: "Implement this" }, advisories: [], memory
        } as unknown as Parameters<typeof hooks.startTask>[0]);
        assert.equal(queued?.approvalPolicy, saved ?? selected);
        assert.equal(queued?.sandbox, undefined, "actor requests cannot override the server sandbox");
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("late stakeholder response is rejected after the response deadline", async () => {
  const controller = new AbortController();
  const summarizer = { runBackgroundJsonTask: async () => {
    controller.abort();
    return JSON.stringify({ text: "late claim", claim: true, model: "gpt-6-luna" });
  } } as unknown as SessionSummarizer;
  const hooks = actorModelHooks({} as SessionStore, summarizer, "http://localhost");
  await assert.rejects(hooks.respond({ actor: { workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { userPrompt: "Canonical" }, runningSessions: [], signal: controller.signal } as unknown as Parameters<typeof hooks.respond>[0]), /deadline/);
});

test("claims require a bounded actor-prepared executable prompt while opinions do not", async () => {
  let value: object = { text: "I will do this", claim: true };
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; return JSON.stringify(value);
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "actor", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { userPrompt: "Implement the API" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0];
  for (const preparedPrompt of [undefined, "   ", "x".repeat(12001)]) {
    value = { text: "I will do this", claim: true, preparedPrompt };
    await assert.rejects(hooks.respond(input), /Invalid actor response/);
  }
  value = { text: "Discussion only", claim: false };
  assert.equal((await hooks.respond(input)).claim, false);
  value = { text: "I will do this", claim: true, preparedPrompt: "依照已定 API 合約實作，驗證錯誤處理。" };
  assert.equal((await hooks.respond(input)).preparedPrompt, "依照已定 API 合約實作，驗證錯誤處理。");
  assert.equal(calls, 5, "preparation uses the same response call, with no extra LLM pass");
});

test("null optional stakeholder fields are treated as omitted", async () => {
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => JSON.stringify({ text: "好，我做。", claim: true,
    preparedPrompt: "加 sub-actor 支援並驗證。", model: null, executorActorId: null }) } as unknown as SessionSummarizer, "http://localhost");
  const result = await hooks.respond({ actor: { id: "actor", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { userPrompt: "咁做啦" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.deepEqual(result, { text: "好，我做。", claim: true, claimKind: "full", preparedPrompt: "加 sub-actor 支援並驗證。" });
});

test("claimed context rounds are limited to history the actor was shown", async () => {
  let value: object = {};
  const room = { rounds: [
    { id: "seen", userPrompt: "Use the full composer", status: "no_claims", replies: [{ actorId: "actor", status: "opinion", text: "Agreed" }] },
    { id: "unseen", userPrompt: "Peer-only topic", status: "no_claims", replies: [] },
    { id: "current", userPrompt: "做", status: "responding", replies: [] }
  ] };
  const hooks = actorModelHooks({ getDomainActorRoom: async () => room } as unknown as SessionStore,
    { runBackgroundJsonTask: async () => JSON.stringify(value) } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "actor", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: room.rounds[2], runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0];
  value = { text: "好，我做。", claim: true, preparedPrompt: "改用完整 composer。", contextRoundIds: ["seen", "unseen", "current", "seen"] };
  assert.deepEqual((await hooks.respond(input)).contextRoundIds, ["seen"]);
  value = { text: "好，我做。", claim: true, preparedPrompt: "改用完整 composer。", contextRoundIds: "seen" };
  await assert.rejects(hooks.respond(input), /Invalid actor response/);
  value = { text: "意見", claim: false, contextRoundIds: ["seen"] };
  assert.equal((await hooks.respond(input)).contextRoundIds, undefined, "opinions never carry task context");
});

test("in-role work answered as an opinion is asked once for the claim", async () => {
  const prompts: string[] = [];
  const answers = [
    { intent: "work", inRole: true, text: "明白。Actor 不綁定模型。", claim: false },
    { intent: "work", inRole: true, text: "我會改成 actor 只揀 tier。", claim: true, preparedPrompt: "移除 actor 綁定模型，改為按工作揀 tier。" }
  ];
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async (_w: string, _t: string, prompt: string) => {
    prompts.push(prompt); return JSON.stringify(answers[prompts.length - 1]);
  } } as unknown as SessionSummarizer, "http://localhost");
  const input = { actor: { id: "actor", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { userPrompt: "另外actor 唔會綁model" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0];
  const result = await hooks.respond(input);
  assert.equal(result.claim, true);
  assert.equal(result.preparedPrompt, "移除 actor 綁定模型，改為按工作揀 tier。");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /You judged this as work within your role/);
  answers.splice(0, 2, { intent: "discussion", inRole: true, text: "我覺得可以。", claim: false });
  prompts.length = 0;
  assert.equal((await hooks.respond(input)).claim, false, "discussion stays an opinion without a repair call");
  assert.equal(prompts.length, 1);
});

test("stakeholders choose their execution tier from the prompt group and the server validates it", async () => {
  let prompt = "";
  const summarizer = { runBackgroundJsonTask: async (_ws: string, _task: string, input: string) => { prompt = input; return JSON.stringify({ text: "I can handle this work", claim: true, preparedPrompt: "Implement the requested change.", model: "outside-allowlist-proposal" }); } } as unknown as SessionSummarizer;
  const hooks = actorModelHooks({} as SessionStore, summarizer, "http://localhost");
  const response = await hooks.respond({ actor: { id: "actor", workspaceId: "workspace", model: "gpt-6-luna", allowedModels: ["gpt-6-luna"], memory },
    round: { userPrompt: "Canonical request" }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
  assert.equal(response.text, "I can handle this work");
  assert.equal(response.claim, true);
  assert.equal(response.model, "outside-allowlist-proposal");
  assert.match(prompt, /an explicit user model or tier first, otherwise what the work needs/);
  assert.ok(prompt.includes(ACTOR_MODEL_TIER_GUIDANCE), "claiming actors use the same tier criteria as the Decision fallback");
  assert.match(prompt, /An allowed choice is final; Decision selects only if you omit model/);
  assert.match(prompt, /"executionModels":\["gpt-6-luna"\]/);
});

test("a repeated contradictory claim is an explicit failure, not a successful opinion", async () => {
  let calls = 0;
  const hooks = actorModelHooks({} as SessionStore, { runBackgroundJsonTask: async () => {
    calls++; return JSON.stringify({ intent: "work", inRole: true, text: "Understood", claim: false });
  } } as unknown as SessionSummarizer, "http://localhost");
  await assert.rejects(hooks.respond({ actor: { id: "actor", workspaceId: "ws", model: "gpt-6-luna", memory },
    round: { userPrompt: "Please implement this" }, runningSessions: [], signal: new AbortController().signal
  } as unknown as Parameters<typeof hooks.respond>[0]), /intent, role and claim must agree/);
  assert.equal(calls, 2);
});
test("contextRead evidence still fits when memory fills the input budget and oversize reads are truncated with a disclosed size", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "actor-read-"));
  const big = { rolePrompt: "角".repeat(4000), roleSummary: "摘".repeat(4000), longTerm: "知".repeat(4000), rolling: "近".repeat(4000) };
  // A tight observed window leaves only a few KB beyond the stakeholder instructions.
  const window = 40_000;
  for (const [name, body, expectFull] of [["small", JSON.stringify({ kind: "browser-bridge-context", tabId: 1, text: "我嘗試讀取" }), true],
    ["large", JSON.stringify({ kind: "browser-bridge-context", tabId: 1, text: "我".repeat(8000) }), false]] as const) {
    const path = join(dir, `${name}.json`); writeFileSync(path, body);
    const prompts: string[] = [];
    const hooks = actorModelHooks({ getModelContextWindow: async () => window } as unknown as SessionStore, { runBackgroundJsonTask: async (_ws: string, _task: string, prompt: string) => {
      prompts.push(prompt);
      return prompts.length === 1 ? JSON.stringify({ contextRead: { tool: "attachment", attachmentId: "a" } }) : JSON.stringify({ text: "ok", claim: false });
    } } as unknown as SessionSummarizer, "http://localhost");
    await hooks.respond({ actor: { id: "a", workspaceId: "ws", memory: big }, round: { userPrompt: "Read", attachments: [
      { id: "a", name: "ctx.json", type: "application/json", size: body.length, path }] }, runningSessions: [], signal: new AbortController().signal } as unknown as Parameters<typeof hooks.respond>[0]);
    const last = prompts[1];
    assert.doesNotMatch(last, /Context inspection unavailable/, name);
    assert.doesNotMatch(last, /�/, name);
    assert.ok(Buffer.byteLength(last) <= actorInputBudget(window), name);
    if (expectFull) assert.doesNotMatch(last, /Context truncated/); else assert.match(last, /Context truncated: showing first \d+ of \d+ bytes/);
  }
});
