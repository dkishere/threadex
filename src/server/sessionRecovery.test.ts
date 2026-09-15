import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionRecoveryContext,
  isRecoverableThreadResumeError,
  recoveryPrompt,
  shouldForcePersistedRecovery
} from "./sessionRecovery";
import type { SessionRecord, SessionTurnRecord } from "./sessionStore";

const session = {
  id: "local-original",
  threadId: "thread-old",
  workspaceId: "threadex",
  cwd: "/workspace",
  accountId: "account-new",
  keywordWeights: {},
  title: "Fix the interrupted task",
  titleSource: "user",
  description: "Preserve the original objective and decisions",
  parentSessionId: "local-parent",
  forkedFromTurnId: "parent-turn",
  created: "2026-09-04T00:00:00Z",
  updated: "2026-09-04T00:00:00Z"
} satisfies SessionRecord;

function turn(input: Partial<SessionTurnRecord> & Pick<SessionTurnRecord, "id" | "userInput">): SessionTurnRecord {
  return {
    sessionId: session.id,
    accountId: "account-old",
    agentResponse: "",
    tokenIn: 0,
    tokenOut: 0,
    usageSample: null,
    status: "done",
    runnerPid: null,
    runnerStarted: null,
    runnerHeartbeat: null,
    runnerLogPath: null,
    runnerExitCode: 0,
    lastEventName: null,
    pendingReason: null,
    pendingLoadBalance: null,
    created: "2026-09-04T00:00:00Z",
    ...input
  };
}

test("builds a deterministic recovery handoff from persisted lineage and successful turns", () => {
  const recovery = buildSessionRecoveryContext({
    session,
    currentTurnId: "retry-turn",
    sourceThreadId: "thread-old",
    reason: "account_changed",
    turns: [
      turn({ id: "goal-turn", userInput: "Implement the original objective", agentResponse: "Changed files A and B; next run focused tests." }),
      turn({
        id: "failed-turn",
        userInput: "go",
        agentResponse: "Codex error: refresh token was revoked",
        runnerExitCode: 1,
        status: "todo",
        pendingReason: "auth"
      }),
      turn({ id: "retry-turn", userInput: "go", status: "running" })
    ]
  });

  assert.ok(recovery);
  const prompt = recoveryPrompt("go", recovery);
  assert.match(prompt, /sessionId: local-original/);
  assert.match(prompt, /parentSessionId: local-parent/);
  assert.match(prompt, /sourceThreadId: thread-old/);
  assert.match(prompt, /Implement the original objective/);
  assert.match(prompt, /Changed files A and B; next run focused tests/);
  assert.match(prompt, /Interrupted or pending; no successful agent result should be inferred\. reason=auth/);
  assert.doesNotMatch(prompt, /Codex error: refresh token was revoked/);
  assert.match(prompt, /Current user request:\ngo$/);
});

test("recognizes only thread-resume failures as recoverable", () => {
  assert.equal(isRecoverableThreadResumeError("No rollout found for thread id abc"), true);
  assert.equal(isRecoverableThreadResumeError("thread was not found"), true);
  assert.equal(isRecoverableThreadResumeError("refresh token was revoked"), false);
});

test("forces one persisted handoff when the current native thread was created after an auth failure", () => {
  const turns = [
    turn({
      id: "auth-failure",
      userInput: "go",
      agentResponse: "Codex error: refresh token was revoked",
      runnerExitCode: 1,
      created: "2026-09-04T20:00:00Z"
    }),
    turn({ id: "empty-new-thread", userInput: "go", agentResponse: "What would you like me to work on?", created: "2026-09-04T20:01:00Z" }),
    turn({ id: "current", userInput: "continue", status: "running", created: "2026-09-04T20:02:00Z" })
  ];
  const sessionEvents = [{
    id: "new-thread-event",
    sessionId: session.id,
    turnId: "empty-new-thread",
    eventName: "session",
    payload: { threadId: "thread-old" },
    created: "2026-09-04T20:01:01Z"
  }];

  assert.equal(shouldForcePersistedRecovery({
    session,
    turns,
    currentTurnId: "current",
    sessionEvents,
    recoveryEvents: []
  }), true);
  assert.equal(shouldForcePersistedRecovery({
    session,
    turns,
    currentTurnId: "current",
    sessionEvents,
    recoveryEvents: [{
      id: "recovered",
      sessionId: session.id,
      turnId: "current",
      eventName: "context_recovery",
      payload: { threadId: "thread-old" },
      created: "2026-09-04T20:02:01Z"
    }]
  }), false);
});
