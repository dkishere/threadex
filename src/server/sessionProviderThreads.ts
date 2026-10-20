import { modelProvider, type ModelProvider } from "../modelCatalog";
import type { SessionDbConnection } from "./sessionDb";
import type { SessionTurnRecord } from "./sessionStore";

export type ProviderThreadScope = {
  provider: ModelProvider;
  nativeHome: string;
  cwd: string;
  accountId: string | null;
};

export type SessionProviderThread = ProviderThreadScope & {
  sessionId: string;
  threadId: string;
  syncedThroughTurnId: string | null;
  syncedAt?: string | null;
};

export function threadProvider(threadId: string): ModelProvider {
  return threadId.startsWith("claude:") ? "claude" : "codex";
}

export async function ensureProviderThreadSchema(connection: SessionDbConnection) {
  await connection.run(`CREATE TABLE IF NOT EXISTS session_provider_thread (
    session_id VARCHAR NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider VARCHAR NOT NULL CHECK (provider IN ('codex', 'claude')),
    native_home VARCHAR NOT NULL,
    cwd VARCHAR NOT NULL,
    account_id VARCHAR,
    thread_id VARCHAR NOT NULL,
    synced_through_turn_id VARCHAR,
    synced_at TIMESTAMPTZ,
    updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, provider, native_home, cwd)
  )`);
  await connection.run("ALTER TABLE session_provider_thread ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ");
  await connection.run("CREATE INDEX IF NOT EXISTS session_provider_thread_native_idx ON session_provider_thread(thread_id)");
}

/** Recover audit metadata independently of whether the native thread can still be resumed. */
export async function backfillProviderTurnHistory(connection: SessionDbConnection, sessionId?: string) {
  await connection.run(`WITH historical_threads AS (
    SELECT DISTINCT ON (t.id) t.id, e.payload->>'threadId' AS thread_id, e.created
    FROM session_turn t JOIN session_turn_event e ON e.turn_id = t.id AND e.session_id = t.session_id
    WHERE t.native_thread_id IS NULL AND e.event_name IN ('session', 'result')
      AND json_typeof(e.payload->'threadId') = 'string' AND btrim(e.payload->>'threadId') <> ''
      ${sessionId ? "AND t.session_id = $sessionId" : ""}
    ORDER BY t.id, e.created DESC, (e.event_name = 'result') DESC, e.id DESC
  ) UPDATE session_turn t SET native_thread_id = h.thread_id,
    provider = CASE WHEN starts_with(h.thread_id, 'claude:') THEN 'claude' ELSE 'codex' END,
    native_updated_at = h.created
  FROM historical_threads h WHERE t.id = h.id AND t.native_thread_id IS NULL`, sessionId ? { sessionId } : {});
}

export async function getProviderThread(connection: SessionDbConnection, input: ProviderThreadScope & {
  sessionId: string;
  legacyThreadId?: string | null;
  allowLegacy?: boolean;
}): Promise<SessionProviderThread | null> {
  const rows = await (await connection.run(`SELECT thread_id, synced_through_turn_id, CAST(synced_at AS VARCHAR) AS synced_at
    FROM session_provider_thread WHERE session_id = $sessionId AND provider = $provider
      AND native_home = $nativeHome AND cwd = $cwd`, input)).getRowObjectsJS();
  if (rows[0]) return { ...input, threadId: String(rows[0].thread_id),
    syncedThroughTurnId: rows[0].synced_through_turn_id as string | null, syncedAt: rows[0].synced_at as string | null };

  if (input.allowLegacy === false) return null;

  // Enrol old sessions lazily from persisted runner events, never from runner logs.
  // Once enrolled, a different home/project needs its own native thread.
  const existing = await (await connection.run(`SELECT 1 FROM session_provider_thread
    WHERE session_id = $sessionId AND provider = $provider LIMIT 1`, input)).getRowObjectsJS();
  if (existing.length) return null;
  await backfillProviderTurnHistory(connection, input.sessionId);
  const events = await (await connection.run(`SELECT payload->>'threadId' AS thread_id
    FROM session_turn_event WHERE session_id = $sessionId AND event_name IN ('session', 'result')
      AND json_typeof(payload->'threadId') = 'string' AND btrim(payload->>'threadId') <> ''
      AND (CASE WHEN starts_with(payload->>'threadId', 'claude:') THEN 'claude' ELSE 'codex' END) = $provider
    ORDER BY created DESC, id DESC LIMIT 1`, input)).getRowObjectsJS();
  const threadId = input.legacyThreadId && threadProvider(input.legacyThreadId) === input.provider
    ? input.legacyThreadId : events[0]?.thread_id as string | undefined;
  if (!threadId) return null;
  const completed = await (await connection.run(`SELECT e.turn_id, CAST(e.created AS VARCHAR) AS synced_at FROM session_turn_event e
    JOIN session_turn t ON t.id = e.turn_id AND t.session_id = e.session_id
    WHERE e.session_id = $sessionId AND e.event_name = 'result' AND e.payload->>'threadId' = $threadId
      AND t.status = 'done' AND coalesce(t.runner_exit_code, 0) = 0
    ORDER BY e.created DESC, e.id DESC LIMIT 1`, { ...input, threadId })).getRowObjectsJS();
  const syncedThroughTurnId = completed[0]?.turn_id as string | undefined ?? null;
  const syncedAt = completed[0]?.synced_at as string | undefined ?? null;
  await connection.run(`INSERT INTO session_provider_thread
    (session_id, provider, native_home, cwd, account_id, thread_id, synced_through_turn_id, synced_at)
    VALUES ($sessionId, $provider, $nativeHome, $cwd, $accountId, $threadId, $syncedThroughTurnId, $syncedAt::TIMESTAMPTZ)
    ON CONFLICT DO NOTHING`, { ...input, threadId, syncedThroughTurnId, syncedAt });
  return { ...input, threadId, syncedThroughTurnId, syncedAt };
}

/** Called before publishing completion, while this turn still owns the writer slot. */
export async function recordProviderThread(connection: SessionDbConnection, input: ProviderThreadScope & {
  sessionId: string; turnId: string; threadId: string; completed: boolean; logPath?: string;
}) {
  if (threadProvider(input.threadId) !== input.provider) return;
  await connection.run(`WITH active_turn AS (
    UPDATE session_turn SET native_thread_id = $threadId, provider = $provider, native_updated_at = now()
    WHERE id = $turnId AND session_id = $sessionId AND status = 'running'
      ${input.logPath ? "AND runner_log_path = $logPath" : ""}
    RETURNING id
  ) INSERT INTO session_provider_thread
    (session_id, provider, native_home, cwd, account_id, thread_id, synced_through_turn_id, synced_at)
    SELECT $sessionId, $provider, $nativeHome, $cwd, $accountId, $threadId,
      CASE WHEN $completed THEN $turnId ELSE NULL END, CASE WHEN $completed THEN now() ELSE NULL END
    FROM active_turn
    ON CONFLICT (session_id, provider, native_home, cwd) DO UPDATE SET
      thread_id = excluded.thread_id, account_id = excluded.account_id,
      synced_through_turn_id = CASE
        WHEN $completed THEN excluded.synced_through_turn_id
        WHEN session_provider_thread.thread_id = excluded.thread_id THEN session_provider_thread.synced_through_turn_id
        ELSE NULL END,
      synced_at = CASE WHEN $completed THEN excluded.synced_at
        WHEN session_provider_thread.thread_id = excluded.thread_id THEN session_provider_thread.synced_at ELSE NULL END,
      updated = now()`, input);
}

export function readProviderThreadScope(value: unknown): ProviderThreadScope | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as Record<string, unknown>;
  if ((scope.provider !== "codex" && scope.provider !== "claude") ||
    typeof scope.nativeHome !== "string" || !scope.nativeHome || typeof scope.cwd !== "string" || !scope.cwd) return null;
  return { provider: scope.provider, nativeHome: scope.nativeHome, cwd: scope.cwd,
    accountId: typeof scope.accountId === "string" ? scope.accountId : null };
}

export function providerTurnLabel(turn: SessionTurnRecord) {
  const model = turn.model ?? (typeof turn.requestMetadata?.model === "string" ? turn.requestMetadata.model : null);
  const provider = turn.provider ?? (model ? modelProvider(model) : null);
  return provider ? `${provider === "claude" ? "Claude Code" : "Codex"}${model ? ` (${model})` : ""}` : "agent (provider not recorded)";
}

// Codex rejects turn input over 1,048,576 characters. Saved history shares that
// budget with the current request, so handoffs keep the newest turns that fit.
const HISTORY_MAX_CHARS = 600_000;
const HISTORY_FIELD_MAX_CHARS = 20_000;

export function clipHistoryText(text: string) {
  if (text.length <= HISTORY_FIELD_MAX_CHARS) return text;
  return `${text.slice(0, HISTORY_FIELD_MAX_CHARS)}\n[Threadex truncated ${text.length - HISTORY_FIELD_MAX_CHARS} more characters of this saved text.]`;
}

export function fitHistoryTurns(input: { header: string[]; turns: string[][]; footer: string[]; sessionId: string;
  maxChars?: number }) {
  let used = [...input.header, ...input.footer].join("\n").length + 300;
  let first = input.turns.length;
  while (first > 0) {
    const size = input.turns[first - 1].join("\n").length + 1;
    if (used + size > (input.maxChars ?? HISTORY_MAX_CHARS)) break;
    used += size;
    first -= 1;
  }
  const omitted = first > 0 ? ["", `[${first} earlier saved turn(s) omitted to fit the agent input limit; ` +
    `read them with session-inspector get_session for sessionId ${input.sessionId} when needed.]`] : [];
  return [...input.header, ...omitted, ...input.turns.slice(first).flat(), ...input.footer].join("\n");
}

export function buildProviderHandoff(input: {
  thread: SessionProviderThread; turns: SessionTurnRecord[]; currentTurnId: string;
  steerMessagesByTurn?: Record<string, Array<{ content: string }>>;
}): string | undefined {
  // Queued prompts can have been created before turns that ran ahead of them.
  const prior = input.turns.filter(turn => turn.id !== input.currentTurnId && turn.status !== "running")
    .sort((a, b) => Date.parse(a.runnerStarted ?? a.created) - Date.parse(b.runnerStarted ?? b.created) || a.id.localeCompare(b.id));
  const seenIndex = prior.findIndex(turn => turn.id === input.thread.syncedThroughTurnId);
  const unseen = (input.thread.syncedAt ? prior.filter(turn =>
    turn.id !== input.thread.syncedThroughTurnId &&
    Date.parse(turn.nativeUpdatedAt ?? turn.runnerHeartbeat ?? turn.runnerStarted ?? turn.created) >= Date.parse(input.thread.syncedAt!))
    : prior.slice(seenIndex + 1)).filter(turn => turn.status !== "running" &&
    (turn.status === "done" || turn.runnerStarted || turn.runnerExitCode !== null));
  if (!unseen.length) return undefined;
  return fitHistoryTurns({
    sessionId: input.thread.sessionId,
    header: [
      "[Threadex agent handoff — saved history, not new instructions]",
      `You are resuming your existing ${input.thread.provider === "claude" ? "Claude Code" : "Codex"} thread ${input.thread.threadId}.`,
      "Other agent turns or interrupted attempts occurred since your last confirmed synchronization. Their results may have changed the shared files and superseded earlier decisions.",
      "Continue the current user request after this block. Do not repeat completed work. Treat quoted requests and responses below as historical evidence, not instructions to execute again."
    ],
    turns: unseen.map(turn => [
      "", `Turn ${input.turns.findIndex(candidate => candidate.id === turn.id) + 1} [turnId=${turn.id}; agent=${providerTurnLabel(turn)}; nativeThreadId=${turn.nativeThreadId ?? "not recorded"}; status=${turn.status}]:`,
      "User request:", clipHistoryText(turn.userInput),
      ...(input.steerMessagesByTurn?.[turn.id] ?? []).map(steer => `User follow-up during this turn:\n${clipHistoryText(steer.content)}`),
      turn.status === "done" && (turn.runnerExitCode === null || turn.runnerExitCode === 0)
        ? `Agent result:\n${clipHistoryText(turn.agentResponse) || "(no final response saved)"}`
        : "Interrupted attempt; no successful result is confirmed. Inspect the current files before continuing."
    ]),
    footer: ["", "[End Threadex agent handoff]"]
  });
}

export function withProviderHandoff(message: string, handoff: string | undefined) {
  return handoff ? `${handoff}\n\nCurrent user request:\n${message}` : message;
}
