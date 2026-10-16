import assert from "node:assert/strict";
import test from "node:test";
import {
  answerSessionQuestion,
  answerTransientSessionQuestion,
  stopSessionQuestionRunners,
  buildSessionQuestionDeveloperInstructions,
  buildSideChatRoomPrompt,
  buildSideChatSessionInspectorConfig,
  isSideChatReasoningEffort
} from "./sessionQuestion.js";
import type { SessionRecord } from "./sessionStore.js";
import type { SideChatTranscriptEntry } from "../sideChatRoom.js";
import { IsolatedLunaRunner, type IsolatedLunaRunnerOptions } from "./isolatedLunaRunner.js";

const session: SessionRecord = {
  id: "session-1",
  threadId: "thread-1",
  workspaceId: "workspace-2",
  cwd: "/tmp/project",
  accountId: null,
  keywordWeights: {},
  title: "Fix the failure",
  titleSource: "summarizer",
  description: "A saved session about a failure",
  parentSessionId: null,
  forkedFromTurnId: null,
  created: "2026-07-12T10:00:00.000Z",
  updated: "2026-07-12T10:05:00.000Z"
};

test("side-chat developer instructions identify the target and enforce read-only inspection", () => {
  const instructions = buildSessionQuestionDeveloperInstructions(session);

  assert.match(instructions, /side chat for Threadex session session-1/i);
  assert.match(instructions, /Target workspace id: workspace-2/);
  assert.match(instructions, /Target Codex thread id: thread-1/);
  assert.match(instructions, /session-inspector get_session/);
  assert.match(instructions, /includeSideChats=true/);
  assert.match(instructions, /across Codex homes\/workspaces/);
  assert.match(instructions, /Only get_session and search_sessions are available/);
  assert.match(instructions, /Never.*fork.*goal.*todo/i);
});

test("side-chat CLI config exposes only saved-history commands", () => {
  const config = buildSideChatSessionInspectorConfig({
    serverUrl: "http://127.0.0.1:8787",
    session
  });
  assert.deepEqual(config.approvedCommands, ["get_session", "search_sessions"]);
  assert.equal(config.env.RUNNER_SERVER_URL, "http://127.0.0.1:8787");
  assert.equal(config.env.THREADEX_SESSION_ID, "session-1");
  assert.equal(config.env.THREADEX_TODO_AGENT_ROLE, "side_chat");

  assert.equal(config.env.THREADEX_WORKSPACE_MANAGER, "0");
  assert.equal(config.env.THREADEX_CONTEXT_FORK_REQUEST, "0");
});

test("validates selectable side-chat reasoning efforts", () => {
  assert.equal(isSideChatReasoningEffort("minimal"), true);
  assert.equal(isSideChatReasoningEffort("ultra"), true);
  assert.equal(isSideChatReasoningEffort("impossible"), false);
});

test("Claude side chats resume one Claude session per Threadex session", async () => {
  const calls: Array<Parameters<NonNullable<Parameters<typeof answerSessionQuestion>[0]["runClaude"]>>[0]> = [];
  let configDir = "/accounts/a";
  let fail = false;
  const ask = (question: string) => answerSessionQuestion({
    question, context: { session: { ...session, id: "claude-side-chat" } },
    workspace: { id: "workspace-2", name: "W", codexHome: "/tmp/home", cwd: "/tmp/project", created: "", updated: "" },
    serverUrl: "http://127.0.0.1:8787", model: "haiku", reasoningEffort: "medium",
    resolveClaudeConfigDir: async () => configDir,
    runClaude: async (options) => {
      calls.push(options);
      if (fail) throw new Error("Claude API error");
      return { responseText: `Answer ${calls.length}`, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
        sessionId: options.resume ?? `claude-${calls.length}` };
    }
  });
  try {
    assert.deepEqual(await ask("First"), { model: "claude-haiku-5-5", answer: "Answer 1", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } });
    await ask("Second");
    assert.deepEqual(calls.map((call) => call.resume), [null, "claude-1"]);
    assert.equal(calls[0].persistSession, true);
    assert.equal(calls[0].timeoutMs, 600_000);
    assert.equal(calls[0].idleTimeout, true);
    assert.equal(calls[0].configDir, "/accounts/a");
    assert.deepEqual(calls[0].allowedTools, ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"]);
    assert.deepEqual(calls[0].inspectorCli?.approvedCommands, ["get_session", "search_sessions", "prompt_session"]);
    assert.equal(calls[0].inspectorCli?.env.THREADEX_SIDE_CHAT_HOST_PROMPT, "1");
    assert.match(calls[0].systemPrompt, /When the user explicitly asks/);
    assert.doesNotMatch(calls[0].systemPrompt, /Never ask another side-chat agent, prompt a session/);
    assert.equal(calls[0].mcpServers, undefined);
    assert.match(calls[0].systemPrompt, /side chat for Threadex session claude-side-chat/);
    // Investigates read-only: writes only in a stable private scratch cwd, loopback but no external network.
    assert.ok(calls[0].scratchDir && calls[0].scratchDir === calls[1].scratchDir, "a resumed session keeps its cwd");
    assert.equal(calls[0].allowLocalNetwork, true);
    assert.match(calls[0].systemPrompt, /project directory \(read by absolute path\): "\/tmp\/project"/);
    assert.match(calls[0].systemPrompt, /never run INSERT, UPDATE, DELETE/);
    assert.doesNotMatch(calls[0].systemPrompt, /run shell commands, browse the web/);

    configDir = "/accounts/b";
    await ask("Other account");
    assert.equal(calls[2].resume, null, "a saved session is only resumable from its own account");

    fail = true;
    await assert.rejects(ask("Fails"));
    fail = false;
    await ask("After failure");
    assert.equal(calls[4].resume, null, "a failed run starts a fresh Claude session");
  } finally {
    stopSessionQuestionRunners();
  }
});

test("side chat room actors keep separate threads and only receive messages they have not seen", async () => {
  const calls: Array<Parameters<NonNullable<Parameters<typeof answerSessionQuestion>[0]["runClaude"]>>[0]> = [];
  const robin = { id: "robin", name: "Robin", model: "haiku", effort: "high", systemPrompt: "Challenge assumptions." };
  const willow = { id: "willow", name: "Willow", model: "haiku", effort: "low", systemPrompt: "" };
  const history: SideChatTranscriptEntry[] = [];
  const ask = async (actor: typeof robin | null, question: string, roundId: string, replyToId: string | null = null) => {
    const messageId = `m${history.length + 1}`;
    const result = await answerSessionQuestion({
      question, context: { session: { ...session, id: "room" } },
      workspace: { id: "workspace-2", name: "W", codexHome: "/tmp/home", cwd: "/tmp/project", created: "", updated: "" },
      serverUrl: "http://127.0.0.1:8787", model: "haiku", reasoningEffort: "medium",
      resolveClaudeConfigDir: async () => null,
      room: { actor, participants: ["Robin", "Willow"], history: [...history], replyTo: history.find((entry) => entry.id === replyToId) ?? null, messageId },
      runClaude: async (options) => {
        calls.push(options);
        return { responseText: `${actor?.name ?? "Default"} says ${calls.length}`, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 },
          sessionId: options.resume ?? `claude-${actor?.id ?? "default"}` };
      }
    });
    history.push({ id: messageId, roundId, replyToId, question, answer: result.answer, model: result.model, actor: actor && { id: actor.id, name: actor.name, model: actor.model, effort: actor.effort } });
    return result;
  };
  try {
    await ask(robin, "Plan A?", "r1");
    await ask(willow, "Plan A?", "r1");
    assert.match(calls[0].systemPrompt, /participant named "Robin"[\s\S]*Challenge assumptions\./);
    assert.equal(calls[0].reasoningEffort, "high", "actors use their own effort");
    assert.match(calls[0].prompt, /you are Robin · also present: Willow[\s\S]*New message from the user:\n\nPlan A\?/);
    assert.match(calls[1].prompt, /Room messages since your last reply:[\s\S]*Robin: Robin says 1/, "a fresh speaker reads the room so far");

    await ask(robin, "Please respond", "r2", "m2");
    assert.equal(calls[2].resume, "claude-robin", "each actor resumes its own thread");
    assert.doesNotMatch(calls[2].prompt, /Robin: Robin says 1/, "an actor never re-reads its own reply");
    assert.match(calls[2].prompt, /Willow: Willow says 2[\s\S]*reply to this message from Willow/);

    await ask(null, "Summarise", "r3");
    assert.equal(calls[3].resume, null);
    assert.equal(calls[3].reasoningEffort, "medium", "the gearbox assistant keeps the requested effort");
    assert.doesNotMatch(calls[3].systemPrompt, /participant named/);
  } finally {
    stopSessionQuestionRunners();
  }
});

test("Codex side chats sign in with the managed account and restart when its login changes", async (t) => {
  const runs: { runner: IsolatedLunaRunner; authRaw: string | undefined }[] = [];
  t.mock.method(IsolatedLunaRunner.prototype, "run", async function (this: IsolatedLunaRunner) {
    runs.push({ runner: this, authRaw: (this as unknown as { options: { authRaw?: string } }).options.authRaw });
    return { responseText: "Answer", usage: null };
  });
  t.mock.method(IsolatedLunaRunner.prototype, "stop", () => undefined);
  const ask = (authRaw: string) => answerSessionQuestion({
    question: "Why?", context: { session: { ...session, id: "codex-auth" } },
    workspace: { id: "workspace-2", name: "W", codexHome: "/tmp/home", cwd: "/tmp/project", created: "", updated: "" },
    serverUrl: "http://127.0.0.1:8787", model: "gpt-5.5", reasoningEffort: "medium", authRaw
  });
  try {
    await ask("login-a");
    await ask("login-a");
    await ask("login-b");
    assert.deepEqual(runs.map((run) => run.authRaw), ["login-a", "login-a", "login-b"]);
    assert.equal(runs[0].runner, runs[1].runner, "an unchanged login keeps the thread");
    assert.notEqual(runs[1].runner, runs[2].runner, "a new login starts a new app-server");
    const options = (runs[0].runner as unknown as { options: IsolatedLunaRunnerOptions }).options;
    assert.equal(options.scratchWrite, true, "writes stay in the runner's private scratch workspace");
    assert.equal(options.allowWorkspaceRead, undefined, "the project is never the writable cwd");
    assert.equal(options.networkAccess, true);
    assert.ok(options.inspectorCli?.approvedCommands.includes("prompt_session"));
    assert.equal(options.inspectorCli?.env.THREADEX_SIDE_CHAT_HOST_PROMPT, "1");
    assert.equal(options.timeoutMs, 600_000);
    assert.ok(options.appServerConfigArgs?.includes("tools.web_search=true"));
    assert.match(options.developerInstructions ?? "", /project directory \(read by absolute path\): "\/tmp\/project"/);
  } finally {
    stopSessionQuestionRunners();
  }
});

test("a lone gearbox side chat sends the plain question", () => {
  assert.equal(buildSideChatRoomPrompt({ question: "Why?", actor: null, participants: [], history: [], unseen: [], replyTo: null }), "Why?");
});

test("temporary side chats on Claude never persist or resume a session", async () => {
  const calls: any[] = [];
  const answer = await answerTransientSessionQuestion({
    question: "Draft a task", context: { session },
    workspace: { id: "workspace-2", name: "W", codexHome: "/tmp/home", cwd: "/tmp/project", created: "", updated: "" },
    serverUrl: "http://127.0.0.1:8787", model: "claude-sonnet-5-5", reasoningEffort: "high",
    resolveClaudeConfigDir: async () => "/accounts/a",
    runClaude: async (options) => {
      calls.push(options);
      return { responseText: "{\"title\":\"T\",\"prompt\":\"P\"}", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, sessionId: "claude-x" };
    }
  });
  assert.equal(answer.model, "claude-sonnet-5-5");
  assert.equal(calls[0].scratchDir, undefined, "drafting jobs stay transcript-only");
  assert.match(calls[0].systemPrompt, /run shell commands other than the supplied session-inspector CLI, browse the web/);
  assert.equal(calls[0].persistSession, false);
  assert.equal(calls[0].timeoutMs, 90_000);
  assert.equal(calls[0].resume, null);
  assert.equal(calls[0].reasoningEffort, "high");
  assert.equal(calls[0].configDir, "/accounts/a");
});
