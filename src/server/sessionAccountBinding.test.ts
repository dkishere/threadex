import assert from "node:assert/strict";
import test from "node:test";

import { rebindSessionAccount } from "./sessionAccountBinding";
import type { AccountRecord, SessionRecord, SessionStore } from "./sessionStore";

test("account rotation preserves the same session id and Codex thread", async () => {
  const upserts: unknown[] = [];
  const switches: string[] = [];
  const store = {
    async upsertSession(input: unknown) {
      upserts.push(input);
      return session;
    },
    async switchSession(sessionId: string) {
      switches.push(sessionId);
      return session;
    }
  } as Pick<SessionStore, "upsertSession" | "switchSession">;
  const session = {
    id: "local-follow-up",
    threadId: "thread-follow-up",
    workspaceId: "workspace",
    cwd: "/workspace",
    accountId: "account-old",
    keywordWeights: { followup: 1 },
    title: "Continue this task",
    titleSource: "initial",
    description: "Keep all follow-ups together",
    parentSessionId: null,
    forkedFromTurnId: null,
    created: "2026-08-11T00:00:00Z",
    updated: "2026-08-11T00:00:00Z"
  } satisfies SessionRecord;
  const nextAccount = { id: "account-next" } as AccountRecord;

  await rebindSessionAccount(store, session, nextAccount);

  assert.deepEqual(upserts, [{
    id: session.id,
    threadId: session.threadId,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    accountId: nextAccount.id,
    title: session.title,
    titleSource: session.titleSource,
    description: session.description,
    parentSessionId: session.parentSessionId,
    forkedFromTurnId: session.forkedFromTurnId,
    keywordWeights: session.keywordWeights
  }]);
  assert.deepEqual(switches, [session.id]);
});
