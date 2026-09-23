import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  SessionSummarizer,
  buildSummarizerPrompt,
  buildSummaryContext,
  isSummarizerUsageLimitError,
  summarizerAgentHomeCandidates,
  summarizerExecutionAccountId
} from "./sessionSummarizer";
import { SessionStore, type SessionRecord, type SessionTurnRecord } from "./sessionStore";

test("summarizer prompt requests only a Chinese title", () => {
  const context = buildSummaryContext(
    session({ title: "summariser title language" }),
    [turn("summariser 做title又用曬英文，prompt無寫好嗎？")],
    5000
  );

  assert.equal(context.titleLanguage, "Traditional Chinese/Cantonese");
  const prompt = buildSummarizerPrompt(context);
  assert.match(prompt, /Title language: Traditional Chinese\/Cantonese/);
  assert.match(prompt, /title must include Chinese characters/);
  assert.match(prompt, /It must not be English-only/);
  assert.doesNotMatch(prompt, /keywords?:/i);
});

test("title language survives short English follow-ups and automated notices", () => {
  const context = buildSummaryContext(session({}), [
    turn("clickhouse 仲係唔得，我想 preview delete"),
    turn("我係 head studio 搞"),
    turn("Fix?"),
    turn("Threadex commentary issue follow-up for the current task. The summariser has recorded issues without a solution.")
  ], 20000)!;
  assert.equal(context.titleLanguage, "Traditional Chinese/Cantonese");
});

test("Japanese titles use kana before shared Han characters", () => {
  const context = buildSummaryContext(session({}), [turn("日本語のタイトルを修正してください")], 20000)!;
  assert.equal(context.titleLanguage, "Japanese");
});

test("summarizer prompt keeps English as the default title language", () => {
  const context = buildSummaryContext(
    session({ title: "Fix summarizer prompt" }),
    [turn("Fix the summarizer prompt so titles follow the user request language")],
    5000
  );

  assert.equal(context.titleLanguage, "English");
  assert.match(buildSummarizerPrompt(context), /Title language: English/);
});

test("summarizer title actions stay grounded in the user's prompt", () => {
  const context = buildSummaryContext(
    session(),
    [turn("commit hms, CD, @fairshot-hub & push")],
    5000
  );

  const prompt = buildSummarizerPrompt(context);
  assert.match(prompt, /every substantive action and subject in the title must be traceable to the user's own prompts/);
  assert.match(prompt, /Do not turn commit\/push into refine or deploy/);
});

test("summarizer waits for an in-progress Codex app turn to finish importing", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-summarizer-in-progress-test-"));
  const codexHome = resolve(root, "codex-home");
  const sessionsDir = resolve(codexHome, "sessions", "2026", "09", "04");
  const sessionId = "cccccccc-1111-4222-8333-dddddddddddd";
  const transcriptPath = resolve(sessionsDir, `rollout-2026-09-04T08-00-00-${sessionId}.jsonl`);
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      { timestamp: "2026-09-04T08:00:00Z", type: "session_meta", payload: { id: sessionId, cwd: root } },
      { timestamp: "2026-09-04T08:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "completed-turn" } },
      { timestamp: "2026-09-04T08:00:02Z", type: "event_msg", payload: { type: "user_message", turn_id: "completed-turn", message: "commit hms, CD, @fairshot-hub & push" } },
      { timestamp: "2026-09-04T08:00:03Z", type: "event_msg", payload: { type: "task_complete", turn_id: "completed-turn" } },
      { timestamp: "2026-09-04T09:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "incomplete-turn" } },
      { timestamp: "2026-09-04T09:00:01Z", type: "event_msg", payload: { type: "user_message", turn_id: "incomplete-turn", message: "collect the beta tag and draft a primo deploy PR" } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );

  const store = new SessionStore(resolve(root, "summarizer-in-progress.postgres"));
  await store.ready();
  const summarizer = new SessionSummarizer(store, {
    model: "test-model",
    idleMs: 60_000,
    sweepMs: 60_000,
    pendingRetryMs: 60_000,
    maxInputChars: 5_000,
    timeoutMs: 5_000,
    runnerMaxRuns: 10,
    runnerMaxAgeMs: 60_000,
    reasoningEffort: "low",
    provider: "mock",
    mockResponse: "title: Invented deployment title",
    promptDumpDir: null
  });
  try {
    await store.importLocalCodexSessionFile({ path: transcriptPath, codexHome });
    const localSessionId = `local_${sessionId}`;
    const before = await store.getSession(localSessionId);
    await summarizer.forceSummarizeSession(localSessionId);

    assert.equal((await store.getSession(localSessionId))?.title, before?.title);
    assert.equal(await store.getSessionSummaryState(localSessionId), null);
  } finally {
    summarizer.close();
    await store.close();
  }
});

test("summarizer updates the title without generating or replacing keywords", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-summarizer-title-only-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  const summarizer = new SessionSummarizer(store, {
    model: "test-model",
    idleMs: 60_000,
    sweepMs: 60_000,
    pendingRetryMs: 60_000,
    maxInputChars: 5_000,
    timeoutMs: 5_000,
    runnerMaxRuns: 10,
    runnerMaxAgeMs: 60_000,
    reasoningEffort: "low",
    provider: "mock",
    mockResponse: "title: 優先更新 session title",
    promptDumpDir: null
  });
  try {
    assert.deepEqual(store.normalizeMetadata({}, "修正 session title").keywordWeights, {});
    await store.upsertSession({
      id: "title-only-session",
      workspaceId: "default",
      title: "Initial title",
      titleSource: "initial",
      keywordWeights: { existing: 1 }
    });
    await store.recordSessionTurn({
      id: "title-only-turn",
      sessionId: "title-only-session",
      userInput: "先做好 session title 更新",
      agentResponse: "完成。",
      tokenIn: 1,
      tokenOut: 1,
      status: "done"
    });

    await summarizer.forceSummarizeSession("title-only-session");

    const updated = await store.getSession("title-only-session");
    assert.equal(updated?.title, "優先更新 session title");
    assert.equal(updated?.titleSource, "summarizer");
    assert.deepEqual(updated?.keywordWeights, { existing: 1 });
  } finally {
    summarizer.close();
    await store.close();
  }
});

test("failed model calls preserve the title and summary cache until a successful retry", async () => {
  const original = { ...session({ title: "Gemma prompt lab", titleSource: "summarizer" }), threadId: null };
  let writes = 0;
  let saved: unknown = null;
  const store = {
    listRunningSessionTurns: async () => [],
    listPendingSessionTurns: async () => [],
    getSession: async () => original,
    hasIncompleteImportedLocalTurns: async () => false,
    listSessionTurns: async () => [
      turn("Build a local Gemma prompt lab for reviewed device findings"),
      turn("run the llm call in concurrent on the page")
    ],
    getSessionSummaryState: async () => saved,
    getWorkspace: async () => ({ codexHome: null }),
    getOutcomePlan: async () => null,
    upsertSessionSummary: async (value: { title: string }) => {
      writes += 1;
      saved = value;
      original.title = value.title;
      return original;
    }
  } as unknown as SessionStore;
  const summarizer = new SessionSummarizer(store);
  const internals = summarizer as unknown as {
    runSummarizerLuna: (prompt: string) => Promise<unknown>;
    pendingRetries: Map<string, unknown>;
    processSession: (id: string, request: { force: boolean; reason: "idle" }) => Promise<void>;
  };
  try {
    internals.runSummarizerLuna = async () => { throw new Error("transient model timeout"); };
    await summarizer.forceSummarizeSession(original.id);
    assert.equal(original.title, "Gemma prompt lab");
    assert.equal(writes, 0);
    assert.equal(saved, null);
    assert.ok(internals.pendingRetries.has(original.id));

    internals.runSummarizerLuna = async (prompt) => {
      assert.match(prompt, /Build a local Gemma prompt lab/);
      assert.match(prompt, /run the llm call in concurrent on the page/);
      return { responseText: "title: Build Gemma prompt testing lab", usage: null, accountId: null };
    };
    await internals.processSession(original.id, { force: true, reason: "idle" });
    assert.equal(writes, 1);
    assert.equal(original.title, "Build Gemma prompt testing lab");
    assert.equal(internals.pendingRetries.has(original.id), false);
  } finally {
    summarizer.close();
  }
});

test("summarizer prompt titles the overall objective instead of a narrow latest turn", () => {
  const context = buildSummaryContext(
    session({ title: "Improve session retrieval" }),
    [
      turn("Improve session retrieval by combining vector and keyword search"),
      turn("Please rename the helper variable in the ranking function")
    ],
    5000
  );

  const prompt = buildSummarizerPrompt(context);
  assert.doesNotMatch(context.inputText, /Existing title/);
  assert.match(prompt, /work or decision that explains the largest share of substantive turns/);
  assert.match(prompt, /Weight the original objective, decisions that drive later work, and recurring themes more than recency/);
  assert.match(prompt, /mentally remove the last user turn/);
  assert.match(prompt, /core action or subject appears only in the latest user turn/);
  assert.match(prompt, /narrow follow-up/);
  assert.match(prompt, /Centralize hard-gate default in SSM/);
  assert.match(prompt, /not 'Clarify table-name environment variable' or 'Terraform environment configuration'/);
});

test("summarizer keeps every user prompt, compact prior agent context, and the final response", () => {
  const context = buildSummaryContext(
    session(),
    [
      turn("First user objective with an important early constraint.", { agentResponse: "Earlier agent response that should be omitted." }),
      turn("Last user follow-up.", { agentResponse: "Final agent response with the completed outcome." })
    ],
    5000
  );

  assert.match(context.inputText, /user: First user objective with an important early constraint\./);
  assert.match(context.inputText, /user: Last user follow-up\./);
  assert.ok(context.inputText.indexOf("user: Last user follow-up.") < context.inputText.indexOf("user: First user objective"));
  assert.match(context.inputText, /agent context: Earlier agent response that should be omitted/);
  assert.match(context.inputText, /final agent: Final agent response with the completed outcome/);
  const prompt = buildSummarizerPrompt(context);
  assert.match(prompt, /Turns are listed newest-to-oldest to counter recency bias/);
  assert.match(prompt, /TITLE DECISION REMINDER/);
  assert.match(prompt, /must still describe the work after mentally removing the latest user turn/);
  assert.match(prompt, /Return only the title line/);
});

test("summarizer rejects an old title and final-only follow-up as the session topic", () => {
  const context = buildSummaryContext(
    session({ title: "Move wait events to snapshot" }),
    [
      turn("Why is the workspace snapshot endpoint so slow?"),
      turn("What makes the events polling path slow?"),
      turn("Move the expensive status monitor out of event polling."),
      turn("Could wait events also come from the snapshot?"),
    ],
    5000
  );

  const prompt = buildSummarizerPrompt(context);
  assert.doesNotMatch(context.inputText, /Move wait events to snapshot/);
  assert.match(context.inputText, /user: Why is the workspace snapshot endpoint so slow\?/);
  assert.match(context.inputText, /user: Move the expensive status monitor out of event polling\./);
  assert.match(prompt, /not for a final follow-up such as 'Move wait events to snapshot'/);
});

test("summarizer keeps repeated refinements subordinate to their parent feature", () => {
  const context = buildSummaryContext(
    session(),
    [
      turn("Add session list multi-select with bulk copy and an unselect action."),
      turn("Only show checkboxes while hovering or selecting."),
      turn("Do not reserve whitespace for a hidden checkbox."),
      turn("Unselect the sessions after copy completes."),
    ],
    5000
  );

  const prompt = buildSummarizerPrompt(context);
  assert.match(prompt, /Parent-feature rule: title the umbrella capability or problem/);
  assert.match(prompt, /Repeating a sub-requirement in the original compound request and again in a later clarification does not promote it/);
  assert.match(prompt, /should be titled 'Add session list multi-select and bulk copy'/);
  assert.match(prompt, /Choose the umbrella capability or problem for the whole session/);
});

test("summarizer preserves a bounded delivery objective across contextual follow-ups", () => {
  const context = buildSummaryContext(
    session(),
    [
      turn("Resolve the conflict in async-scoring PR 68.", { agentResponse: "The conflict changes when cheat detection is handed off before scoring." }),
      turn("Does the review comment make sense?", { agentResponse: "The comment proposes concurrent scoring and handoff with explicit error handling." }),
      turn("Will gather stop the other work after one failure?", { agentResponse: "Gather raises early by default but return_exceptions waits for all outcomes." }),
      turn("Go implement it and preserve current error handling.", { agentResponse: "Implemented gather return_exceptions and retained the existing error semantics." }),
    ],
    5000
  );

  const prompt = buildSummarizerPrompt(context);
  assert.match(context.inputText, /agent context: The conflict changes when cheat detection is handed off before scoring\./);
  assert.match(context.inputText, /agent context: Gather raises early by default but return_exceptions waits for all outcomes\./);
  assert.match(prompt, /Delivery-anchor rule: when turn 1 defines a concrete bounded deliverable/);
  assert.match(prompt, /should be titled 'Resolve async-scoring PR conflict'/);
});

test("summarizer only accepts the session workspace auth", () => {
  const workspaceCodexHome = "/managed/workspace/codex-home";
  assert.deepEqual(summarizerAgentHomeCandidates(workspaceCodexHome), [workspaceCodexHome]);
  assert.deepEqual(summarizerAgentHomeCandidates(null), []);
});

test("summarizer resolves only one saved account from the runner auth identity", () => {
  const accounts = [
    { id: "saved-a", externalAccountId: "billing-a", externalUserId: "user-a" },
    { id: "saved-b", externalAccountId: "billing-b", externalUserId: "user-b" }
  ] as Awaited<ReturnType<SessionStore["listAccounts"]>>;
  assert.equal(summarizerExecutionAccountId(accounts, {
    externalAccountId: "billing-b",
    externalUserId: "user-b"
  }), "saved-b");
  assert.equal(summarizerExecutionAccountId([...accounts, {
    ...accounts[1],
    id: "duplicate-b"
  }], {
    externalAccountId: "billing-b",
    externalUserId: "user-b"
  }), null);
  assert.equal(summarizerExecutionAccountId([...accounts, {
    ...accounts[1],
    id: "incomplete-b",
    externalUserId: null
  }], {
    externalAccountId: "billing-b",
    externalUserId: "user-b"
  }), "saved-b");
  assert.equal(summarizerExecutionAccountId(accounts, {
    externalAccountId: null,
    externalUserId: null
  }), null);
});

test("summarizer attributes usage to runner auth across null sessions and account switches", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-summarizer-account-test-"));
  const codexHome = resolve(root, "workspace-codex-home");
  const fakeCodexPath = resolve(root, "fake-codex.mjs");
  const previousCodexPath = process.env.CODEX_PATH;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
const auth = JSON.parse(readFileSync(resolve(process.env.CODEX_HOME, "auth.json"), "utf8"));
const executionAccount = auth.tokens.account_id;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turnNumber = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "thread-" + (++turnNumber) } } });
  if (request.method === "turn/start") {
    const threadId = request.params.threadId;
    send({ id: request.id, result: { turn: { id: "turn-" + turnNumber } } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId,
      tokenUsage: { last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, totalTokens: 15 } }
    } });
    send({ method: "item/completed", params: {
      threadId,
      item: { id: "answer-" + turnNumber, type: "agentMessage", text: "title: " + executionAccount }
    } });
    send({ method: "turn/completed", params: { threadId, turn: { id: "turn-" + turnNumber, status: "completed" } } });
  }
});
`, "utf8");
  chmodSync(fakeCodexPath, 0o755);
  process.env.CODEX_PATH = fakeCodexPath;

  const writeWorkspaceAuth = (externalAccountId: string) => writeFileSync(
    resolve(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: externalAccountId } }),
    "utf8"
  );
  writeWorkspaceAuth("billing-a");

  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  const summarizer = new SessionSummarizer(store, {
    model: "gpt-5.6-luna",
    idleMs: 60_000,
    sweepMs: 60_000,
    pendingRetryMs: 60_000,
    maxInputChars: 5_000,
    timeoutMs: 5_000,
    runnerMaxRuns: 100,
    runnerMaxAgeMs: 30 * 60 * 1000,
    reasoningEffort: "low",
    provider: "luna-runner",
    mockResponse: null,
    promptDumpDir: null
  });

  try {
    await store.upsertWorkspace({ id: "auth-workspace", name: "Auth workspace", codexHome, cwd: root });
    await store.upsertAccount({ id: "saved-a", name: "Saved A", externalAccountId: "billing-a" });
    await store.upsertAccount({ id: "saved-b", name: "Saved B", externalAccountId: "billing-b" });

    await recordSummaryFixture(store, "auth-session-a", "auth-workspace", "saved-a");
    await summarizer.forceSummarizeSession("auth-session-a");
    assert.equal((await store.getSession("auth-session-a"))?.title, "billing-a");

    writeWorkspaceAuth("billing-b");
    await recordSummaryFixture(store, "auth-session-null", "auth-workspace", null);
    await summarizer.forceSummarizeSession("auth-session-null");
    assert.equal((await store.getSession("auth-session-null"))?.title, "billing-b");

    const usage = await store.runSqlQuery({
      sql: `SELECT session_id, account_id, input_tokens, output_tokens
        FROM token_usage
        WHERE usage_type = 'summarizer'
        ORDER BY session_id`,
      limit: 10
    });
    assert.deepEqual(usage.rows, [
      { session_id: "auth-session-a", account_id: "saved-a", input_tokens: 12, output_tokens: 3 },
      { session_id: "auth-session-null", account_id: "saved-b", input_tokens: 12, output_tokens: 3 }
    ]);
  } finally {
    summarizer.close();
    await store.close();
    if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = previousCodexPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarizer treats workspace credit exhaustion as a pending retry", () => {
  assert.equal(
    isSummarizerUsageLimitError(
      "Your workspace is out of credits. Ask your workspace owner to refill in order to continue."
    ),
    true
  );
  assert.equal(isSummarizerUsageLimitError("Agent CLI exec timed out."), false);
});

test("summarizer coalesces credit retries for sessions in the same workspace", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-summarizer-credit-test-"));
  const store = new SessionStore(resolve(root, "threadex.postgres"));
  await store.ready();
  const summarizer = new SessionSummarizer(store, {
    model: "gpt-5.6-luna",
    idleMs: 60_000,
    sweepMs: 60_000,
    pendingRetryMs: 60_000,
    maxInputChars: 5_000,
    timeoutMs: 5_000,
    runnerMaxRuns: 100,
    runnerMaxAgeMs: 30 * 60 * 1000,
    reasoningEffort: "low",
    provider: "luna-runner",
    mockResponse: null,
    promptDumpDir: null
  });
  const internals = summarizer as unknown as {
    runSummarizerLuna: () => Promise<never>;
    pendingRetries: Map<string, unknown>;
    pendingRetryTimers: Map<string, NodeJS.Timeout>;
  };
  let modelCalls = 0;
  internals.runSummarizerLuna = async () => {
    modelCalls += 1;
    throw new Error("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.");
  };

  try {
    for (const id of ["summary-a", "summary-b"]) {
      await store.upsertSession({ id, workspaceId: "default" });
      await store.recordSessionTurn({
        id: `${id}-turn`,
        sessionId: id,
        userInput: `Summarize ${id}`,
        agentResponse: "Done.",
        tokenIn: 1,
        tokenOut: 1,
        status: "done"
      });
    }

    await summarizer.forceSummarizeSession("summary-a");
    await summarizer.requestSummary("summary-b", "idle", false);
    await waitFor(() => internals.pendingRetries.size === 2);

    assert.equal(modelCalls, 1);
    assert.equal(internals.pendingRetryTimers.size, 1);
  } finally {
    summarizer.close();
    await store.close();
  }
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for summarizer state.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function recordSummaryFixture(
  store: SessionStore,
  sessionId: string,
  workspaceId: string,
  accountId: string | null
) {
  await store.upsertSession({ id: sessionId, workspaceId, accountId });
  await store.recordSessionTurn({
    id: `${sessionId}-turn`,
    sessionId,
    accountId,
    userInput: `Summarize ${sessionId}`,
    agentResponse: "Done.",
    tokenIn: 1,
    tokenOut: 1,
    status: "done"
  });
}

function session(input: Partial<SessionRecord> = {}): SessionRecord {
  const now = "2026-07-31T00:00:00.000Z";
  return {
    id: input.id ?? "session-1",
    threadId: input.threadId ?? "thread-1",
    workspaceId: input.workspaceId ?? "default",
    cwd: input.cwd ?? "/tmp/project",
    accountId: input.accountId ?? null,
    keywordWeights: input.keywordWeights ?? {},
    title: input.title ?? "Session",
    titleSource: input.titleSource ?? "initial",
    description: input.description ?? "",
    parentSessionId: input.parentSessionId ?? null,
    forkedFromTurnId: input.forkedFromTurnId ?? null,
    created: input.created ?? now,
    updated: input.updated ?? now
  };
}

function turn(userInput: string, input: Partial<SessionTurnRecord> = {}): SessionTurnRecord {
  return {
    id: input.id ?? "turn-1",
    sessionId: input.sessionId ?? "session-1",
    accountId: input.accountId ?? null,
    userInput,
    agentResponse: input.agentResponse ?? "Done.",
    tokenIn: input.tokenIn ?? 1,
    tokenOut: input.tokenOut ?? 1,
    usageSample: input.usageSample ?? null,
    status: input.status ?? "done",
    runnerPid: input.runnerPid ?? null,
    runnerStarted: input.runnerStarted ?? null,
    runnerHeartbeat: input.runnerHeartbeat ?? null,
    runnerLogPath: input.runnerLogPath ?? null,
    runnerExitCode: input.runnerExitCode ?? null,
    lastEventName: input.lastEventName ?? null,
    pendingReason: input.pendingReason ?? null,
    pendingLoadBalance: input.pendingLoadBalance ?? null,
    created: input.created ?? "2026-07-31T00:00:00.000Z"
  };
}
