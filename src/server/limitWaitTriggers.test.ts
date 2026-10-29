import assert from "node:assert/strict";
import test from "node:test";
import { codexAccountSwitchLimitWaitScopes, type AccountSwitchPendingTurn } from "./limitWaitTriggers";

function turn(sessionId: string, overrides: Partial<AccountSwitchPendingTurn> = {}): AccountSwitchPendingTurn {
  return {
    sessionId,
    workspaceId: "ws-1",
    provider: "codex",
    rateLimited: true,
    sessionAccountId: null,
    turnAccountId: "old",
    usesWorkspacePool: false,
    ...overrides
  };
}

const sessionIds = (scopes: ReturnType<typeof codexAccountSwitchLimitWaitScopes>) => scopes.map((scope) => scope.sessionId);

test("a session switch releases the rebound session's rate-limit wait", () => {
  const scopes = codexAccountSwitchLimitWaitScopes([turn("s-1", { sessionAccountId: "new" })], {
    workspaceId: "ws-1", accountId: "new", previousActiveAccountId: "new", session: { id: "s-1", previousAccountId: "old" }
  });
  assert.deepEqual(scopes, [{ provider: "codex", workspaceId: "ws-1", sessionId: "s-1" }]);
});

test("reselecting the same account releases nothing", () => {
  const pending = [turn("s-1", { sessionAccountId: "old" }), turn("s-2")];
  assert.deepEqual(codexAccountSwitchLimitWaitScopes(pending, {
    workspaceId: "ws-1", accountId: "old", previousActiveAccountId: "old", session: { id: "s-1", previousAccountId: "old" }
  }), []);
});

test("a workspace switch releases sessions that follow the workspace account or its pool", () => {
  const pending = [
    turn("follows"),
    turn("pool", { sessionAccountId: "old", usesWorkspacePool: true }),
    turn("pinned", { sessionAccountId: "other" }),
    turn("already-new", { turnAccountId: "new" })
  ];
  assert.deepEqual(sessionIds(codexAccountSwitchLimitWaitScopes(pending, {
    workspaceId: "ws-1", accountId: "new", previousActiveAccountId: "old"
  })), ["follows", "pool"]);
});

test("account switches stay inside the workspace and the Codex provider", () => {
  const pending = [
    turn("other-ws", { workspaceId: "ws-2" }),
    turn("claude", { provider: "claude" }),
    turn("mine")
  ];
  assert.deepEqual(sessionIds(codexAccountSwitchLimitWaitScopes(pending, {
    workspaceId: "ws-1", accountId: "new", previousActiveAccountId: "old"
  })), ["mine"]);
});

test("only rate-limited turns are released, so stopped, auth and queued turns stay put", () => {
  const pending = [turn("stopped", { rateLimited: false }), turn("s-1", { rateLimited: false, sessionAccountId: "new" })];
  assert.deepEqual(codexAccountSwitchLimitWaitScopes(pending, {
    workspaceId: "ws-1", accountId: "new", previousActiveAccountId: "old", session: { id: "s-1", previousAccountId: "old" }
  }), []);
});

test("each session is released once even when it matches both the rebind and the workspace switch", () => {
  const pending = [turn("s-1"), turn("s-1"), turn("s-2"), turn("s-2")];
  assert.deepEqual(sessionIds(codexAccountSwitchLimitWaitScopes(pending, {
    workspaceId: "ws-1", accountId: "new", previousActiveAccountId: "old", session: { id: "s-1", previousAccountId: "old" }
  })), ["s-1", "s-2"]);
});
