import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnGrillMidTurnInputs, buildTurnGrillPrompt } from "./turnGrill";
import { buildTurnGrillInspectorConfig, buildTurnGrillSessionContext, isLongTurnGrill, turnGrillModel, TURN_GRILL_INSTRUCTIONS } from "./turnGrill";
import { createTurnGrillHistoryReader } from "./turnGrillContext";
import { USER_INPUT_METHOD, asyncAnswerText, asyncInputParams } from "../userInputRequest";
import type { SessionRecord } from "./sessionStore";

test("grill supplies a session URL and reuses only the existing inspector read tool", () => {
  const session = { id: "local_test", workspaceId: "workspace-a", threadId: "native-thread" } as SessionRecord;
  assert.deepEqual(buildTurnGrillSessionContext(session, "turn-a", [{ id: "earlier" }, { id: "turn-a" }, { id: "later" }]), {
    sessionUrl: "threadex://workspace-a/tx_test/turn-a",
    sessionId: "local_test", workspaceId: "workspace-a", turnId: "turn-a", currentTurnNumber: 2, totalTurns: 3
  });
  const config = buildTurnGrillInspectorConfig(session, "http://127.0.0.1:8787", "turn-a");
  assert.deepEqual(config.enabled_tools, ["get_session"]);
  assert.deepEqual(Object.keys(config.tools), ["get_session"]);
  assert.equal(config.env.THREADEX_SESSION_ID, "local_test");
  assert.equal(config.env.THREADEX_TODO_AGENT_ROLE, "turn_grill");
  assert.equal(config.env.THREADEX_GRILL_TURN_ID, "turn-a");
});

test("grill history enforces its source session and target turn", () => {
  const read = createTurnGrillHistoryReader("local_source", "target-turn");
  assert.throws(() => read({ sessionId: "other-session" }), /source session/);
  assert.throws(() => read({ threadId: "other-thread" }), /source session/);
  assert.throws(() => read({ turnId: "other-turn" }), /target turn/);
  const request = read({ sessionId: "local_source", turnId: "target-turn", turnLimit: 500, maxTextChars: 250000, includeLiveItems: true, includeEvents: true, includeSideChats: true, q: "permission" });
  assert.equal(request.sessionId, "local_source");
  assert.equal(request.threadId, undefined);
  assert.equal(request.turnId, "target-turn");
  assert.equal(request.turnLimit, 1);
  assert.equal(request.turnOffset, 0);
  assert.equal(request.maxTextChars, 250000);
  assert.equal(request.includeLiveItems, true);
  assert.equal(request.includeEvents, false);
  assert.equal(request.includeSideChats, false);
  assert.equal(request.q, "permission");
  assert.equal(read({ turnLimit: 3, turnOffset: 3, q: "permission" }).turnOffset, 0);
  assert.throws(() => read({}), /budget exhausted/);
});

test("single-turn grills can look up their source turn", () => {
  const session = { id: "local_test", workspaceId: "workspace-a", threadId: "native-thread" } as SessionRecord;
  const context = buildTurnGrillSessionContext(session, "only", [{ id: "only" }]);
  assert.equal(context.currentTurnNumber, 1);
  assert.equal(context.totalTurns, 1);
  assert.deepEqual(buildTurnGrillInspectorConfig(session, "http://localhost:8787", "only").enabled_tools, ["get_session"]);
  const read = createTurnGrillHistoryReader(session.id, "only");
  assert.equal(read({}).turnId, "only");
});

test("grill sends compact direct evidence and excludes embedded source, instructions and history", () => {
  const input = {
    userInput: "Show model and human tags",
    agentResponse: "Tests passed",
    fileChanges: [{ path: "src/tags.ts", kind: "update", additions: 3, deletions: 1 }],
    liveItems: [{ command: "npm test", output: "No tests found" }],
    steerMessages: [{ message: "Human decision overrides model" }],
    developerInstructions: [{ developerInstructions: "Use the local E2E harness" }],
    projectGuidance: { cwd: "/project", files: [{ path: "/project/AGENTS.md", content: "Run focused API fixtures before E2E", truncated: false }], unavailable: [] },
    parentHistory: [{ userInput: "Earlier prompt", agentResponse: "Earlier response" }]
  };
  assert.deepEqual(JSON.parse(buildTurnGrillPrompt(input)), {
    userInput: input.userInput,
    agentResponse: input.agentResponse,
    fileChanges: input.fileChanges
  });
});

test("grill includes answered QA and manual steers in time order without duplicating async answers", () => {
  const approval = {
    itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", sortCreated: "2026-09-23T10:02:00Z",
    params: { questions: [
      { id: "scope", header: "Scope", question: "Which API should change?" },
      { id: "token", header: "Token", question: "Which token?", isSecret: true }
    ] },
    decision: { answers: { scope: { answers: ["Use the existing API"] }, token: { answers: ["private-token"] } } }
  };
  const inputs = buildTurnGrillMidTurnInputs([approval], [
    { id: "manual", content: "Keep backwards compatibility", attachments: [{ name: "notes.txt" }], forcePlan: false, created: "2026-09-23T10:01:00Z" },
    { id: "async:thread:question", content: "Which API should change?\nAnswer: Use the existing API", attachments: [], forcePlan: false, created: "2026-09-23T10:03:00Z" }
  ]);
  assert.deepEqual(inputs, [
    { kind: "steer", created: "2026-09-23T10:01:00Z", content: "Keep backwards compatibility", attachmentNames: ["notes.txt"], forcePlan: false },
    { kind: "qa", created: "2026-09-23T10:02:00Z", questions: [
      { question: "Which API should change?", answer: "Use the existing API" },
      { question: "Which token?", answer: "[secret answer redacted]" }
    ] }
  ]);
  assert.equal(JSON.stringify(buildTurnGrillPrompt({ userInput: "Task", midTurnInputs: inputs, agentResponse: "Done", fileChanges: [] })).includes("private-token"), false);
});

test("grill excludes the real async QA steer even when its message contains a sensitive answer", () => {
  const questions = [{ title: "Which token?" }];
  const decision = { answers: { "0": { answers: ["private-token"] } } };
  const message = asyncAnswerText(questions, decision);
  const commandId = `async:thread-1:call_question`;
  assert.equal(message, "Which token?\nAnswer: private-token");
  assert.equal("isSecret" in asyncInputParams(questions).questions[0], false);
  const midTurnInputs = buildTurnGrillMidTurnInputs([{
    itemType: "approval", method: USER_INPUT_METHOD, status: "resolved", sortCreated: "2026-09-23T10:02:00Z",
    params: asyncInputParams(questions), decision
  }], [{ id: commandId, content: message, attachments: [], forcePlan: false, created: "2026-09-23T10:02:01Z" }]);
  assert.equal(midTurnInputs.length, 1);
  assert.equal(midTurnInputs[0].kind, "qa");
  const prompt = JSON.parse(buildTurnGrillPrompt({ userInput: "Task", midTurnInputs, agentResponse: "Done", fileChanges: [] }));
  assert.equal(prompt.midTurnInputs.some((input: { kind: string }) => input.kind === "steer"), false);
  assert.equal(prompt.midTurnInputs[0].questions[0].answer, "private-token");
});

test("grill accepts a long final response without a prompt-size cutoff", () => {
  const prompt = buildTurnGrillPrompt({
    userInput: "review", agentResponse: "x".repeat(600_001), fileChanges: []
  });
  assert.equal(JSON.parse(prompt).agentResponse.length, 600_001);
});

test("long turns switch to source-first review guidance", () => {
  assert.equal(isLongTurnGrill({ userInput: "short", agentResponse: "short", tokenIn: 1, tokenOut: 1 }), false);
  assert.equal(turnGrillModel(isLongTurnGrill({ userInput: "short", agentResponse: "short", tokenIn: 1, tokenOut: 1 })), "gpt-6-luna");
  assert.equal(isLongTurnGrill({ userInput: "short", agentResponse: "short", tokenIn: 100_000, tokenOut: 1 }), true);
  assert.equal(turnGrillModel(isLongTurnGrill({ userInput: "short", agentResponse: "short", tokenIn: 100_000, tokenOut: 1 })), "gpt-6-sol");
  assert.equal(isLongTurnGrill({ userInput: "x".repeat(100_000), agentResponse: "", tokenIn: 0, tokenOut: 0 }), true);
  assert.match(TURN_GRILL_INSTRUCTIONS, /Read the named project files yourself/);
});
