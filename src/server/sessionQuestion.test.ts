import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionQuestionDeveloperInstructions,
  buildSideChatMcpCliConfigArgs,
  buildSideChatSessionInspectorConfig,
  isSideChatReasoningEffort
} from "./sessionQuestion.js";
import type { SessionRecord } from "./sessionStore.js";

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
  assert.match(instructions, /mcp__session_inspector__get_session/);
  assert.match(instructions, /includeSideChats=true/);
  assert.match(instructions, /across Codex homes\/workspaces/);
  assert.match(instructions, /Only get_session and search_sessions are available/);
  assert.match(instructions, /Never.*fork.*goal.*todo/i);
});

test("side-chat app-server config contains only the isolated session inspector MCP", () => {
  const config = buildSideChatSessionInspectorConfig({
    serverUrl: "http://127.0.0.1:8787",
    session
  });
  assert.equal(config.required, true);
  assert.deepEqual(config.enabled_tools, ["get_session", "search_sessions"]);
  assert.deepEqual(Object.keys(config.tools), ["get_session", "search_sessions"]);
  assert.equal(config.env.SESSION_INSPECTOR_SERVER_URL, "http://127.0.0.1:8787");
  assert.equal(config.env.THREADEX_SESSION_ID, "session-1");
  assert.equal(config.env.THREADEX_TODO_AGENT_ROLE, "side_chat");

  const args = buildSideChatMcpCliConfigArgs(config);
  assert.ok(args.includes('mcp_servers.session_inspector.tools.get_session.approval_mode="approve"'));
  assert.ok(args.includes('mcp_servers.session_inspector.tools.search_sessions.approval_mode="approve"'));
  assert.ok(args.includes('mcp_servers.session_inspector.enabled_tools=["get_session", "search_sessions"]'));
  assert.equal(args.some((arg) => arg.includes("prompt_session")), false);
  assert.equal(args.some((arg) => arg.includes("todo_")), false);
});

test("validates selectable side-chat reasoning efforts", () => {
  assert.equal(isSideChatReasoningEffort("minimal"), true);
  assert.equal(isSideChatReasoningEffort("ultra"), true);
  assert.equal(isSideChatReasoningEffort("impossible"), false);
});
