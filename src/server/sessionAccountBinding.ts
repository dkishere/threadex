import type { AccountRecord, SessionRecord, SessionStore } from "./sessionStore";

type SessionAccountStore = Pick<SessionStore, "upsertSession" | "switchSession">;

/** Rotate execution credentials without changing the logical task or Codex thread. */
export async function rebindSessionAccount(
  store: SessionAccountStore,
  session: SessionRecord,
  account: AccountRecord | null
) {
  await store.upsertSession({
    id: session.id,
    threadId: session.threadId,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    accountId: account?.id ?? null,
    title: session.title,
    titleSource: session.titleSource,
    description: session.description,
    parentSessionId: session.parentSessionId,
    forkedFromTurnId: session.forkedFromTurnId,
    keywordWeights: session.keywordWeights
  });
  await store.switchSession(session.id);
}
