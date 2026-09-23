#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const codexHome = resolveUserPath(args.codexHome ?? process.env.SESSION_LOCAL_CODEX_HOME ?? "~/.codex");
const storeId = args.storeId ?? args.db ?? process.env.SESSION_STORE_ID ?? process.env.SESSION_DB_PATH ?? "default";
const duckdbPath = resolve(rootDir, args.db ?? process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
const extensionDir = resolve(rootDir, process.env.DUCKDB_EXTENSION_DIRECTORY ?? ".duckdb/extensions");
const duckdbHome = resolve(rootDir, process.env.DUCKDB_HOME_DIRECTORY ?? ".duckdb/home");
const threadexWorkspaceId = "threadex";
const threadexWorkspaceCwd = resolveUserPath(process.env.THREADEX_WORKSPACE_CWD ?? rootDir);
const defaultWorkspaceCodexHome = resolveUserPath(
  process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME ?? "~/.codex",
);
const defaultWorkspaceCodexHomeIsAuthoritative = true;
const threadexWorkspaceCodexHome = resolveUserPath(
  process.env.THREADEX_WORKSPACE_CODEX_HOME ?? resolve(rootDir, "data/codex-homes/threadex"),
);
const importRawEvents = args.rawEvents !== false;
const storedJsonPayloadLimitBytes = Number(process.env.SESSION_EVENT_JSON_LIMIT_BYTES ?? 10 * 1024 * 1024);
const storedJsonPayloadMinStringChars = 1024;
const sessionLiveItemOutputTailBytes = 64 * 1024;

if (process.env.SESSION_IMPORT_BACKEND !== "duckdb") {
  await importWithSessionStore();
  process.exit(process.exitCode ?? 0);
}

mkdirSync(dirname(duckdbPath), { recursive: true });
mkdirSync(extensionDir, { recursive: true });
mkdirSync(resolve(duckdbHome, ".duckdb"), { recursive: true });

let instance;
let connection;

try {
  const started = Date.now();
  const index = readSessionIndex(resolve(codexHome, "session_index.jsonl"));
  const files = selectFiles(discoverSessionFiles(codexHome), args);

  instance = await openDuckDB(duckdbPath);
  connection = await instance.connect();
  await ensureSchema(connection);
  await tuneConnection(connection);
  await ensureWorkspaces(connection);
  if (args.cleanImported) {
    await cleanImportedRows(connection);
  }
  const workspaceCodexHomes = await readWorkspaceCodexHomes(connection);
  mirrorSessionIndex(resolve(codexHome, "session_index.jsonl"), workspaceCodexHomes);

  const totals = {
    files: 0,
    sessions: 0,
    turns: 0,
    events: 0,
    errors: 0,
  };

  console.log(`Importing ${files.length} local Codex session files from ${codexHome}`);
  for (const [fileIndex, file] of files.entries()) {
    const parsed = parseSessionFile(file, index);
    if (isMaintenanceSummarizerSession(parsed)) {
      await connection.run("BEGIN TRANSACTION");
      try {
        await deleteImportedSessionRows(connection, parsed);
        await connection.run("COMMIT");
      } catch (error) {
        await connection.run("ROLLBACK");
        throw error;
      }
      continue;
    }

    totals.files += 1;
    totals.sessions += parsed.sessionId ? 1 : 0;
    totals.turns += parsed.turns.length;
    totals.events += parsed.events.length;
    totals.errors += parsed.parseErrors.length;

    await connection.run("BEGIN TRANSACTION");
    try {
      if (parsed.sessionId) {
        await upsertSession(connection, parsed);
        await reconcileImportedTurnIds(connection, parsed);
        for (const turn of parsed.turns) {
          await upsertTurn(connection, parsed, turn);
        }
        for (const commandCall of parsed.commandCalls) {
          await upsertCommandCall(connection, parsed, commandCall);
        }
        await deleteImportedLiveItems(connection, parsed.sessionId);
        for (const liveItem of parsed.liveItems) {
          await upsertLiveItemEvent(connection, parsed, liveItem);
        }
        if (importRawEvents) {
          for (const event of parsed.events) {
            if (event.turnId && shouldPersistImportedAuditEvent(event)) {
              await upsertSessionEvent(connection, parsed, event);
            }
          }
        }
      }

      await upsertImportFile(connection, parsed);
      await connection.run("COMMIT");
      mirrorSessionFile(parsed, workspaceCodexHomes);
    } catch (error) {
      await connection.run("ROLLBACK");
      throw error;
    }

    if ((fileIndex + 1) % 25 === 0 || fileIndex + 1 === files.length) {
      console.log(`Imported ${fileIndex + 1}/${files.length} files`);
    }
  }

  await refreshFtsIndex(connection);
  await normalizeSessionWorkspaces(connection);
  await cleanupWorkspaceRows(connection);
  const elapsedSeconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `Imported ${totals.sessions} sessions, ${totals.turns} turns, ${totals.events} events in ${elapsedSeconds}s`,
  );
  if (totals.errors > 0) {
    console.warn(`Skipped ${totals.errors} malformed JSONL lines. See local_session_file.parse_error.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  connection?.closeSync();
  instance?.closeSync();
}

async function importWithSessionStore() {
  const started = Date.now();
  const files = selectFiles(discoverSessionFiles(codexHome), args);
  const { tsImport } = await import("tsx/esm/api");
  const { SessionStore } = await tsImport(resolve(rootDir, "src/server/sessionStore.ts"), import.meta.url);
  const store = new SessionStore(storeId);
  const totals = {
    files: 0,
    sessions: 0,
    turns: 0,
    events: 0,
    errors: 0,
  };

  try {
    await store.ready();
    if (args.cleanImported) {
      await store.cleanImportedLocalSessions();
    }

    console.log(`Importing ${files.length} local Codex session files from ${codexHome}`);
    for (const [fileIndex, file] of files.entries()) {
      const result = await store.importLocalCodexSessionFile({
        path: file.path,
        codexHome,
        workspaceId: args.workspaceId,
        rawEvents: importRawEvents,
      });
      totals.files += result.skipped ? 0 : 1;
      totals.sessions += result.sessionId ? 1 : 0;
      totals.turns += result.turns;
      totals.events += result.events;
      if ((fileIndex + 1) % 25 === 0 || fileIndex + 1 === files.length) {
        console.log(`Imported ${fileIndex + 1}/${files.length} files`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  } finally {
    await store.close();
  }

  const elapsedSeconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Imported ${totals.sessions} sessions, ${totals.turns} turns, ${totals.events} events in ${elapsedSeconds}s`);
  if (totals.errors > 0) {
    console.warn(`Skipped ${totals.errors} malformed JSONL lines. See local_session_file.parse_error.`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--codex-home") {
      parsed.codexHome = argv[++index];
    } else if (arg === "--store-id") {
      parsed.storeId = argv[++index];
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = argv[++index];
    } else if (arg === "--db") {
      parsed.db = argv[++index];
      parsed.storeId = parsed.db;
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(argv[++index], "--limit");
    } else if (arg === "--session-id") {
      parsed.sessionId = argv[++index];
    } else if (arg === "--no-raw-events") {
      parsed.rawEvents = false;
    } else if (arg === "--clean-imported") {
      parsed.cleanImported = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run import:local-sessions -- [--codex-home ~/.codex] [--workspace-id ID] [--store-id ID] [--limit N] [--session-id ID] [--clean-imported] [--no-raw-events]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${flag} must be a positive integer`);
}

async function openDuckDB(path) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  try {
    return await DuckDBInstance.create(path, {
      allow_unsigned_extensions: "true",
      extension_directory: extensionDir,
      home_directory: duckdbHome,
    });
  } catch (error) {
    const message = errorMessage(error);
    const walPath = `${path}.wal`;
    if (!message.includes("replaying WAL") || !existsSync(walPath)) {
      throw error;
    }

    const backupPath = `${walPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(walPath, backupPath);
    console.warn(`DuckDB WAL replay failed. Moved WAL to ${backupPath} and retrying.`);
    return DuckDBInstance.create(path, {
      allow_unsigned_extensions: "true",
      extension_directory: extensionDir,
      home_directory: duckdbHome,
    });
  }
}

async function ensureSchema(db) {
  await db.run("INSTALL fts");
  await db.run("LOAD fts");
  await db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR PRIMARY KEY,
      thread_id VARCHAR,
      workspace_id VARCHAR NOT NULL DEFAULT 'default',
      cwd VARCHAR NOT NULL DEFAULT '',
      account_id VARCHAR,
      keyword_weights JSON NOT NULL DEFAULT '{}'::JSON,
      title VARCHAR NOT NULL DEFAULT 'Untitled session',
      title_source VARCHAR NOT NULL DEFAULT 'initial',
      description VARCHAR NOT NULL DEFAULT '',
      parent_session_id VARCHAR,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_source VARCHAR DEFAULT 'initial'");
  await db.run(`
    UPDATE sessions
    SET title_source = 'initial'
    WHERE title_source IS NULL OR title_source NOT IN ('initial', 'summarizer', 'user')
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      codex_home VARCHAR NOT NULL,
      cwd VARCHAR NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS active_workspace (
      key VARCHAR PRIMARY KEY,
      workspace_id VARCHAR,
      updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS workspace_account (
      workspace_id VARCHAR NOT NULL,
      account_id VARCHAR NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (workspace_id, account_id)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS session_turn (
      id VARCHAR PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      account_id VARCHAR,
      user_input VARCHAR NOT NULL,
      agent_response VARCHAR NOT NULL,
      token_in BIGINT NOT NULL DEFAULT 0,
      token_out BIGINT NOT NULL DEFAULT 0,
      status VARCHAR NOT NULL DEFAULT 'done',
      runner_pid BIGINT,
      runner_started TIMESTAMPTZ,
      runner_heartbeat TIMESTAMPTZ,
      runner_log_path VARCHAR,
      runner_exit_code BIGINT,
      last_event_name VARCHAR,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS session_turn_event (
      id VARCHAR PRIMARY KEY,
      turn_id VARCHAR NOT NULL,
      session_id VARCHAR NOT NULL,
      event_name VARCHAR NOT NULL,
      payload JSON NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS session_live_item (
      turn_id VARCHAR NOT NULL,
      item_id VARCHAR NOT NULL,
      session_id VARCHAR NOT NULL,
      item_type VARCHAR NOT NULL,
      event_type VARCHAR NOT NULL,
      event_rank BIGINT NOT NULL DEFAULT 0,
      is_final BOOLEAN NOT NULL DEFAULT false,
      payload JSON NOT NULL,
      source_event_id VARCHAR,
      jsonl_index BIGINT,
      sequence BIGINT,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      finalized_at TIMESTAMPTZ,
      PRIMARY KEY (turn_id, item_id)
    )
  `);
  await db.run("CREATE INDEX IF NOT EXISTS session_live_item_session_idx ON session_live_item(session_id)");
  await db.run("CREATE INDEX IF NOT EXISTS session_live_item_turn_idx ON session_live_item(turn_id)");
  await db.run(`
    CREATE TABLE IF NOT EXISTS local_session_file (
      path VARCHAR PRIMARY KEY,
      source VARCHAR NOT NULL,
      session_id VARCHAR,
      title VARCHAR,
      cwd VARCHAR,
      file_size BIGINT NOT NULL DEFAULT 0,
      file_mtime TIMESTAMPTZ,
      event_count BIGINT NOT NULL DEFAULT 0,
      turn_count BIGINT NOT NULL DEFAULT 0,
      parse_error VARCHAR,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      created TIMESTAMPTZ,
      updated TIMESTAMPTZ
    )
  `);
  await db.run("ALTER TABLE local_session_file ADD COLUMN IF NOT EXISTS workspace_id VARCHAR");
  await db.run(`
    CREATE TABLE IF NOT EXISTS local_session_event (
      source_path VARCHAR NOT NULL,
      event_index BIGINT NOT NULL,
      session_id VARCHAR,
      turn_id VARCHAR,
      event_type VARCHAR NOT NULL,
      payload_type VARCHAR,
      event_timestamp TIMESTAMPTZ,
      payload JSON,
      raw JSON NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (source_path, event_index)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS codex_command_call (
      id VARCHAR PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      turn_id VARCHAR NOT NULL,
      item_id VARCHAR NOT NULL,
      first_event_id VARCHAR,
      last_event_id VARCHAR,
      first_jsonl_index BIGINT,
      last_jsonl_index BIGINT,
      command VARCHAR NOT NULL,
      command_length BIGINT NOT NULL DEFAULT 0,
      response_length BIGINT NOT NULL DEFAULT 0,
      command_part_1 VARCHAR,
      command_part_2 VARCHAR,
      command_part_3 VARCHAR,
      status VARCHAR NOT NULL DEFAULT '',
      exit_code BIGINT,
      created TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
      updated TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )
  `);
  await db.run("CREATE INDEX IF NOT EXISTS codex_command_call_turn_idx ON codex_command_call(turn_id)");
  await db.run("CREATE INDEX IF NOT EXISTS codex_command_call_session_idx ON codex_command_call(session_id)");
}

async function tuneConnection(db) {
  await db.run("SET preserve_insertion_order = false");
  await db.run("SET threads = 4");
}

async function ensureWorkspaces(db) {
  await db.run(
    `
      INSERT INTO workspaces (id, name, codex_home, cwd, created, updated)
      VALUES ('default', 'Default', $codexHome, $cwd, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        codex_home = CASE
          WHEN $codexHomeIsAuthoritative
            OR workspaces.codex_home IS NULL
            OR workspaces.codex_home = ''
          THEN excluded.codex_home
          ELSE workspaces.codex_home
        END,
        cwd = COALESCE(NULLIF(workspaces.cwd, ''), excluded.cwd),
        updated = now()
    `,
    {
      codexHome: defaultWorkspaceCodexHome,
      codexHomeIsAuthoritative: defaultWorkspaceCodexHomeIsAuthoritative,
      cwd: rootDir,
    },
  );
  await db.run(
    `
      INSERT INTO workspaces (id, name, codex_home, cwd, created, updated)
      VALUES ($id, 'Threadex', $codexHome, $cwd, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        codex_home = COALESCE(NULLIF(workspaces.codex_home, ''), excluded.codex_home),
        cwd = COALESCE(NULLIF(workspaces.cwd, ''), excluded.cwd),
        updated = now()
    `,
    {
      id: threadexWorkspaceId,
      codexHome: threadexWorkspaceCodexHome,
      cwd: threadexWorkspaceCwd,
    },
  );
}

async function readWorkspaceCodexHomes(db) {
  const result = await db.run("SELECT id, codex_home FROM workspaces");
  const rows = await result.getRowObjectsJS();
  return new Map(
    rows
      .map((row) => [stringValue(row.id), stringValue(row.codex_home)])
      .filter(([id, codexHome]) => id && codexHome),
  );
}

async function cleanImportedRows(db) {
  await db.run("CREATE TEMP TABLE imported_session_ids AS SELECT DISTINCT session_id FROM local_session_file WHERE session_id IS NOT NULL");
  await db.run("DELETE FROM codex_command_call WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_live_item WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_turn_event WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_turn WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM sessions WHERE id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM local_session_event");
  await db.run("DELETE FROM local_session_file");
  await db.run("DROP TABLE imported_session_ids");
}

async function deleteImportedSessionRows(db, session) {
  await db.run(
    `
      CREATE TEMP TABLE imported_session_ids AS
      SELECT DISTINCT session_id
      FROM local_session_file
      WHERE (path = $path OR session_id = $sessionId) AND session_id IS NOT NULL
      UNION
      SELECT $sessionId
      WHERE $sessionId IS NOT NULL
    `,
    {
      path: session.path,
      sessionId: session.sessionId ?? null,
    },
  );
  await deleteIfTableExists(db, "DELETE FROM token_usage WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await deleteIfTableExists(db, "DELETE FROM session_turn_token_usage_sample WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await deleteIfTableExists(db, "DELETE FROM session_summary_state WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await deleteIfTableExists(db, "DELETE FROM session_description_embedding WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM codex_command_call WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_live_item WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_turn_event WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM session_turn WHERE session_id IN (SELECT session_id FROM imported_session_ids)");
  await db.run("DELETE FROM sessions WHERE id IN (SELECT session_id FROM imported_session_ids)");
  await db.run(
    "DELETE FROM local_session_event WHERE source_path = $path OR session_id IN (SELECT session_id FROM imported_session_ids)",
    { path: session.path },
  );
  await db.run(
    "DELETE FROM local_session_file WHERE path = $path OR session_id IN (SELECT session_id FROM imported_session_ids)",
    { path: session.path },
  );
  await db.run("DROP TABLE imported_session_ids");
}

async function deleteIfTableExists(db, sql) {
  try {
    await db.run(sql);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }
}

function readSessionIndex(path) {
  const index = new Map();
  if (!existsSync(path)) return index;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.id === "string") {
        index.set(record.id, {
          title: typeof record.thread_name === "string" ? record.thread_name : null,
          updated: normalizeTimestamp(record.updated_at),
        });
      }
    } catch {
      // Ignore malformed index lines; the session JSONL files are the source of truth.
    }
  }
  return index;
}

function discoverSessionFiles(home) {
  const roots = [
    { dir: resolve(home, "sessions"), source: "sessions" },
    { dir: resolve(home, "archived_sessions"), source: "archived_sessions" },
  ];
  const files = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const path of walkJsonl(root.dir)) {
      files.push({ path, source: root.source });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function selectFiles(files, options) {
  const requestedCodexSessionId = options.sessionId?.replace(/^(local_|tx_)/, "");
  const selected = options.sessionId
    ? files.filter((file) => idFromFilename(file.path) === requestedCodexSessionId)
    : files;
  return options.limit ? selected.slice(0, options.limit) : selected;
}

function walkJsonl(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkJsonl(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
  return found;
}

function parseSessionFile(file, index) {
  const stat = statSync(file.path);
  const lines = readFileSync(file.path, "utf8").split(/\r?\n/);
  const events = [];
  const turnsById = new Map();
  const commandCallsByCallId = new Map();
  const collaborationCallsByCallId = new Map();
  const liveItems = [];
  const parseErrors = [];
  let codexSessionId = idFromFilename(file.path);
  let cwd = "";
  let created = null;
  let updated = null;
  let currentTurnId = null;
  let foundSessionMeta = false;
  let parentSessionId = null;

  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      parseErrors.push(`line ${lineIndex + 1}: ${errorMessage(error)}`);
      continue;
    }

    const timestamp = normalizeTimestamp(raw.timestamp);
    created = minTimestamp(created, timestamp);
    updated = maxTimestamp(updated, timestamp);

    const payload = raw.payload ?? {};
    if (!foundSessionMeta && raw.type === "session_meta" && isRecord(payload)) {
      codexSessionId = stringValue(payload.session_id) ?? stringValue(payload.id) ?? codexSessionId;
      cwd = stringValue(payload.cwd) ?? cwd;
      parentSessionId = parentSessionId ?? importedParentSessionId(payload);
      foundSessionMeta = true;
    }

    const payloadTurnId = extractTurnId(payload);
    if (isRecord(payload) && (payload.type === "task_started" || raw.type === "turn_context") && payloadTurnId) {
      currentTurnId = payloadTurnId;
    }
    const turnId = payloadTurnId ?? currentTurnId;
    if (isRecord(payload) && raw.type === "turn_context") {
      cwd = stringValue(payload.cwd) ?? cwd;
      parentSessionId = parentSessionId ?? importedParentSessionId(payload);
    }

    const event = {
      index: lineIndex,
      timestamp,
      raw,
      payload,
      turnId,
      eventType: stringValue(raw.type) ?? "unknown",
      payloadType: isRecord(payload) ? stringValue(payload.type) : null,
    };
    events.push(event);

    if (turnId) {
      const turn = getTurn(turnsById, turnId, timestamp);
      turn.created = minTimestamp(turn.created, timestamp) ?? turn.created;
      applyEventToTurn(turn, event);
      applyEventToImportedItems(turn, event, commandCallsByCallId, collaborationCallsByCallId, liveItems);
    }
  }

  const titleRecord = codexSessionId ? index.get(codexSessionId) : null;
  updated = maxTimestamp(updated, titleRecord?.updated ?? null) ?? normalizeTimestamp(stat.mtime.toISOString());
  created = created ?? normalizeTimestamp(stat.birthtime.toISOString()) ?? updated;
  const turns = [...turnsById.values()]
    .filter((turn) => !turn.ignored && (turn.userInput || turn.assistantMessages.length > 0 || turn.finalResponses.length > 0))
    .sort((left, right) => left.created.localeCompare(right.created));
  const firstUserInput = turns.find((turn) => turn.userInput)?.userInput ?? "";
  const title = cleanTitle(titleRecord?.title) ?? cleanTitle(firstUserInput) ?? codexSessionId ?? "Untitled session";
  const description = firstUserInput.slice(0, 500);

  return {
    path: file.path,
    source: file.source,
    stat,
    sessionId: localSessionIdForCodexSessionId(codexSessionId),
    threadId: codexSessionId,
    cwd,
    title,
    description,
    parentSessionId,
    created,
    updated,
    events,
    turns,
    commandCalls: [...commandCallsByCallId.values()],
    liveItems: dedupeRenderedAgentMessageLiveItems(turns, liveItems),
    parseErrors,
  };
}

function isMaintenanceSummarizerSession(session) {
  const firstUserInput = session.turns.find((turn) => turn.userInput)?.userInput ?? "";
  return isMaintenanceSummarizerPrompt(firstUserInput) || isMaintenanceSummarizerPrompt(session.title);
}

function isMaintenanceSummarizerPrompt(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return (
    text.startsWith("You are a keyword-first session metadata generator for a coding workspace.")
    || (
      text.startsWith("You are a session summarizer for a coding workspace.")
      && text.includes("Read the compact turn log")
    )
  );
}

function localSessionIdForCodexSessionId(sessionId) {
  return `tx_${sessionId?.replace(/^(local_|tx_)/, "")}`;
}

function importedParentSessionId(payload) {
  const rawParentId =
    stringValue(payload.parent_session_id)
    ?? stringValue(payload.parentSessionId)
    ?? stringValue(payload.parent_id)
    ?? stringValue(payload.parentId);
  return rawParentId ? localSessionIdForCodexSessionId(rawParentId) : null;
}

function applyEventToTurn(turn, event) {
  const payload = event.payload;
  if (!isRecord(payload)) return;

  if (event.eventType === "event_msg" && payload.type === "user_message") {
    const rawText = stringValue(payload.message) ?? "";
    const text = normalizeLocalCodexUserInput(rawText);
    if (looksLikeSyntheticReviewerInput(rawText) || looksLikeSyntheticReviewerInput(text)) {
      turn.ignored = true;
    } else if (text && !looksLikeContextOnly(text)) {
      turn.userInput ||= text;
    }
  } else if (event.eventType === "response_item" && payload.type === "message" && payload.role === "user") {
    const rawText = contentToText(payload.content);
    const text = normalizeLocalCodexUserInput(rawText);
    if (looksLikeSyntheticReviewerInput(rawText) || looksLikeSyntheticReviewerInput(text)) {
      turn.ignored = true;
    } else if (text && !looksLikeContextOnly(text)) {
      turn.userInput ||= text;
    }
  }

  if (event.eventType === "turn_context") {
    turn.model = stringValue(payload.model) ?? turn.model;
  }

  if (event.eventType === "event_msg" && payload.type === "agent_message") {
    const message = stringValue(payload.message);
    if (message && payload.phase === "final_answer") {
      pushUniqueText(turn.finalResponses, message);
    } else if (message) {
      pushUniqueText(turn.assistantMessages, message);
    }
  } else if (event.eventType === "response_item" && payload.type === "message" && payload.role === "assistant") {
    const text = contentToText(payload.content);
    if (text && payload.phase === "final_answer") {
      pushUniqueText(turn.finalResponses, text);
    } else if (text) {
      pushUniqueText(turn.assistantMessages, text);
    }
  }

  if (event.eventType === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
    const usage = isRecord(payload.info.last_token_usage)
      ? payload.info.last_token_usage
      : payload.info.total_token_usage;
    if (isRecord(usage)) {
      turn.tokenIn = Math.max(turn.tokenIn, numberValue(usage.input_tokens) ?? 0);
      turn.tokenOut = Math.max(turn.tokenOut, numberValue(usage.output_tokens) ?? 0);
    }
  }

  if (event.eventType === "event_msg" && payload.type === "task_complete") {
    turn.status = "done";
  }
}

function applyEventToImportedItems(turn, event, commandCallsByCallId, collaborationCallsByCallId, liveItems) {
  const payload = event.payload;
  if (!isRecord(payload)) return;

  if (event.eventType === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `${turn.id}:${event.index}`;
    const itemId = stringValue(payload.id) ?? callId;
    if (isCollaborationCall(payload)) {
      const args = parseJsonObject(stringValue(payload.arguments));
      const taskName = stringValue(args?.task_name) ?? stringValue(args?.target);
      const prompt = readableCollaborationPrompt(args?.message);
      collaborationCallsByCallId.set(callId, { turnId: turn.id, itemId });
      liveItems.push({
        turnId: turn.id,
        jsonlIndex: event.index,
        created: event.timestamp,
        item: {
          id: itemId,
          eventType: "item.completed",
          itemType: "subagent",
          tool: stringValue(payload.name) ?? "agent",
          status: "inProgress",
          ...(taskName ? { label: taskName } : {}),
          receiverThreadIds: [],
          ...(prompt ? { prompt } : {}),
          agents: [],
        },
      });
      return;
    }
    const command = commandFromCallPayload(payload);
    if (!command) return;
    const commandCall = {
      id: `${turn.id}:${itemId}`,
      turnId: turn.id,
      itemId,
      callId,
      firstEventId: stringValue(payload.id) ?? `local:${event.index}`,
      lastEventId: stringValue(payload.id) ?? `local:${event.index}`,
      firstJsonlIndex: event.index,
      lastJsonlIndex: event.index,
      command,
      responseLength: 0,
      status: stringValue(payload.status) ?? "started",
      exitCode: null,
    };
    commandCallsByCallId.set(callId, commandCall);
    liveItems.push({
      turnId: turn.id,
      jsonlIndex: event.index,
      created: event.timestamp,
      item: {
        id: itemId,
        eventType: "item.completed",
        itemType: "command_execution",
        command,
        aggregatedOutput: "",
        status: commandCall.status,
      },
    });
    return;
  }

  if (event.eventType === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
    const callId = stringValue(payload.call_id);
    if (!callId) return;
    const collaborationCall = collaborationCallsByCallId.get(callId);
    if (collaborationCall) {
      const liveItem = liveItems.find(
        (candidate) => candidate.turnId === turn.id && candidate.item.id === collaborationCall.itemId,
      );
      if (liveItem?.item.itemType === "subagent") {
        const output = toolOutputToText(payload.output);
        const parsedOutput = parseJsonObject(output);
        const agents = importedCollaborationAgents(parsedOutput);
        const taskName = stringValue(parsedOutput?.task_name);
        if (liveItem.item.tool === "wait_agent" && agents.length === 0 && !liveItem.item.label && !liveItem.item.prompt) {
          liveItems.splice(liveItems.indexOf(liveItem), 1);
          return;
        }
        liveItem.jsonlIndex = event.index;
        liveItem.created = event.timestamp;
        liveItem.item = {
          ...liveItem.item,
          status: /failed|error/i.test(output) ? "failed" : "completed",
          ...(taskName ? { label: taskName } : {}),
          ...(agents.length > 0 ? { agents } : {}),
        };
      }
      return;
    }
    const commandCall = commandCallsByCallId.get(callId);
    if (!commandCall) return;
    const output = toolOutputToText(payload.output);
    commandCall.responseLength = Math.max(commandCall.responseLength, output.length);
    commandCall.lastJsonlIndex = event.index;
    commandCall.lastEventId = `local:${event.index}`;
    commandCall.status = output.includes("Process exited with code 0") ? "completed" : "completed";
    commandCall.exitCode = exitCodeFromOutput(output);
    const liveItem = liveItems.find((candidate) => candidate.turnId === turn.id && candidate.item.id === commandCall.itemId);
    if (liveItem?.item.itemType === "command_execution") {
      liveItem.jsonlIndex = event.index;
      liveItem.created = event.timestamp;
      liveItem.item = {
        ...liveItem.item,
        aggregatedOutput: output,
        responseLength: output.length,
        status: commandCall.status,
        ...(commandCall.exitCode === null ? {} : { exitCode: commandCall.exitCode }),
      };
    }
    return;
  }

  if (event.eventType === "event_msg" && payload.type === "patch_apply_end") {
    const changes = fileChangesFromPatchPayload(payload);
    if (changes.length === 0) return;
    liveItems.push({
      turnId: turn.id,
      jsonlIndex: event.index,
      created: event.timestamp,
      item: {
        id: `file:${stringValue(payload.call_id) ?? event.index}`,
        eventType: "item.completed",
        itemType: "file_change",
        changes,
        status: stringValue(payload.status) ?? (payload.success === true ? "completed" : "failed"),
      },
    });
  }
}

function isCollaborationCall(payload) {
  const name = stringValue(payload.name) ?? "";
  return stringValue(payload.namespace) === "collaboration"
    || new Set(["spawn_agent", "send_message", "followup_task", "wait_agent", "list_agents", "interrupt_agent"]).has(name);
}

function readableCollaborationPrompt(value) {
  const prompt = stringValue(value);
  if (!prompt || /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(prompt)) return null;
  return prompt;
}

function importedCollaborationAgents(value) {
  if (!isRecord(value) || !Array.isArray(value.agents)) return [];
  return value.agents.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const name = stringValue(candidate.agent_name);
    if (!name || name === "/root") return [];
    const rawStatus = candidate.agent_status;
    let status = stringValue(rawStatus) ?? "unknown";
    let message = stringValue(candidate.last_task_message);
    if (isRecord(rawStatus)) {
      const terminal = Object.entries(rawStatus).find(([, result]) => typeof result === "string");
      if (terminal) {
        status = terminal[0];
        message = terminal[1];
      }
    }
    return [{ id: name, name, status, ...(message ? { message } : {}) }];
  });
}

function commandFromCallPayload(payload) {
  const name = stringValue(payload.name) ?? "tool";
  const args = parseJsonObject(stringValue(payload.arguments));
  if (name === "exec_command") {
    return stringValue(args?.cmd) ?? name;
  }
  if (name === "apply_patch") {
    return "apply_patch";
  }
  if (name === "multi_tool_use.parallel") {
    const count = Array.isArray(args?.tool_uses) ? args.tool_uses.length : null;
    return count ? `multi_tool_use.parallel (${count} calls)` : name;
  }
  return name;
}

function fileChangesFromPatchPayload(payload) {
  if (!isRecord(payload.changes)) return [];
  return Object.entries(payload.changes)
    .map(([path, change]) => {
      if (!isRecord(change)) {
        return { path, kind: "update" };
      }
      const kind = stringValue(change.type) ?? "update";
      const content = stringValue(change.content);
      const unifiedDiff = stringValue(change.unified_diff) ?? stringValue(change.unifiedDiff);
      return {
        path,
        kind,
        ...(content === null ? {} : { currentContent: content, afterContent: content }),
        ...(unifiedDiff === null ? {} : { unifiedDiff, patch: unifiedDiff, diff: unifiedDiff }),
        ...(stringValue(change.move_path) === null ? {} : { movePath: stringValue(change.move_path) }),
      };
    })
    .filter((change) => change.path);
}

function getTurn(turnsById, id, timestamp) {
  const existing = turnsById.get(id);
  if (existing) return existing;
  const turn = {
    id,
    created: timestamp ?? new Date(0).toISOString(),
    userInput: "",
    assistantMessages: [],
    finalResponses: [],
    model: null,
    tokenIn: 0,
    tokenOut: 0,
    status: "done",
    ignored: false,
  };
  turnsById.set(id, turn);
  return turn;
}

function dedupeRenderedAgentMessageLiveItems(turns, liveItems) {
  const renderedTextByTurn = new Map(
    turns.map((turn) => [
      turn.id,
      new Set((turn.finalResponses.length > 0 ? turn.finalResponses : turn.assistantMessages).map(normalizeTextBlock)),
    ]),
  );
  return liveItems.filter((liveItem) => {
    if (liveItem.item?.itemType !== "agent_message") return true;
    const renderedTexts = renderedTextByTurn.get(liveItem.turnId);
    const text = normalizeTextBlock(liveItem.item.text);
    return !text || !renderedTexts?.has(text);
  });
}

async function upsertSession(db, session) {
  // Re-importing a pre-tx_ database must reuse the existing session and its history.
  const existing = await db.run(
    "SELECT id FROM sessions WHERE thread_id = $threadId AND workspace_id = $workspaceId ORDER BY updated DESC LIMIT 1",
    { threadId: session.threadId, workspaceId: workspaceIdForSession(session) }
  );
  const [row] = await existing.getRowObjectsJS();
  if (row) session.sessionId = String(row.id);
  await db.run(
    `
      INSERT INTO sessions (
        id,
        thread_id,
        workspace_id,
        cwd,
        account_id,
        keyword_weights,
        title,
        title_source,
        description,
        parent_session_id,
        created,
        updated
      )
      VALUES (
        $id,
        $threadId,
        $workspaceId,
        $cwd,
        NULL,
        $keywordWeights::JSON,
        $title,
        'initial',
        $description,
        $parentSessionId,
        $created,
        $updated
      )
      ON CONFLICT (id) DO UPDATE SET
        thread_id = excluded.thread_id,
        workspace_id = excluded.workspace_id,
        cwd = excluded.cwd,
        keyword_weights = excluded.keyword_weights,
        title = CASE
          WHEN sessions.title_source = 'initial' THEN excluded.title
          ELSE sessions.title
        END,
        description = excluded.description,
        parent_session_id = coalesce(sessions.parent_session_id, excluded.parent_session_id),
        updated = excluded.updated
    `,
    {
      id: session.sessionId,
      threadId: session.threadId,
      workspaceId: workspaceIdForSession(session),
      cwd: session.cwd,
      keywordWeights: JSON.stringify(keywordWeightsFromText(`${session.title}\n${session.description}`)),
      title: session.title,
      description: session.description,
      parentSessionId: session.parentSessionId,
      created: session.created,
      updated: session.updated,
    },
  );
}

async function upsertTurn(db, session, turn) {
  await db.run(
    `
      INSERT INTO session_turn (
        id,
        session_id,
        account_id,
        user_input,
        agent_response,
        token_in,
        token_out,
        status,
        runner_pid,
        runner_started,
        runner_heartbeat,
        runner_log_path,
        runner_exit_code,
        last_event_name,
        created
      )
      VALUES (
        $id,
        $sessionId,
        NULL,
        $userInput,
        $agentResponse,
        $tokenIn,
        $tokenOut,
        $status,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        'local.imported',
        $created
      )
      ON CONFLICT (id) DO UPDATE SET
        session_id = excluded.session_id,
        user_input = excluded.user_input,
        agent_response = excluded.agent_response,
        token_in = excluded.token_in,
        token_out = excluded.token_out,
        status = excluded.status,
        last_event_name = CASE
          WHEN session_turn.last_event_name LIKE 'local.%' THEN excluded.last_event_name
          ELSE session_turn.last_event_name
        END
    `,
    {
      id: turn.id,
      sessionId: session.sessionId,
      userInput: turn.userInput,
      agentResponse: turn.finalResponses.join("\n\n") || turn.assistantMessages.join("\n\n"),
      tokenIn: turn.tokenIn,
      tokenOut: turn.tokenOut,
      status: turn.status,
      created: turn.created,
    },
  );
  await db.run(
    `
      INSERT INTO token_usage (
        id, usage_type, source, session_id, turn_id, account_id, model,
        input_tokens, output_tokens, total_tokens, source_timestamp, created, updated
      )
      VALUES (
        $id, 'agent', 'local_import', $sessionId, $turnId, NULL, $model,
        $inputTokens, $outputTokens, $totalTokens, $created::TIMESTAMPTZ, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        source = excluded.source,
        model = COALESCE(excluded.model, token_usage.model),
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        source_timestamp = excluded.source_timestamp,
        updated = now()
    `,
    {
      id: `agent:turn:${turn.id}`,
      sessionId: session.sessionId,
      turnId: turn.id,
      model: turn.model,
      inputTokens: turn.tokenIn,
      outputTokens: turn.tokenOut,
      totalTokens: turn.tokenIn + turn.tokenOut,
      created: turn.created,
    },
  );
}

async function reconcileImportedTurnIds(db, session) {
  if (!session.sessionId || session.turns.length === 0) return;
  const result = await db.run(
    `
      SELECT id, user_input, last_event_name, CAST(created AS VARCHAR) AS created
      FROM session_turn
      WHERE session_id = $sessionId
      ORDER BY created ASC, id ASC
    `,
    { sessionId: session.sessionId },
  );
  const existingTurns = (await result.getRowObjectsJS())
    .map((row) => ({
      id: stringValue(row.id),
      userInput: stringValue(row.user_input),
      lastEventName: stringValue(row.last_event_name),
      created: stringValue(row.created),
    }))
    .filter((turn) => turn.id && turn.userInput);
  const usedIds = new Set();
  const turnIdMap = new Map();

  for (const turn of session.turns) {
    const candidates = existingTurns
      .filter((candidate) => !usedIds.has(candidate.id))
      .filter((candidate) => importedTurnPromptsMatch(candidate.userInput, turn.userInput))
      .sort((left, right) => {
        const leftManagerOwned = !isImportedTurnRow(left.lastEventName);
        const rightManagerOwned = !isImportedTurnRow(right.lastEventName);
        if (leftManagerOwned !== rightManagerOwned) return leftManagerOwned ? -1 : 1;
        const leftIsNativeId = left.id === turn.id;
        const rightIsNativeId = right.id === turn.id;
        if (leftIsNativeId !== rightIsNativeId) return leftIsNativeId ? -1 : 1;
        return Math.abs(Date.parse(left.created ?? turn.created) - Date.parse(turn.created)) -
          Math.abs(Date.parse(right.created ?? turn.created) - Date.parse(turn.created));
      });
    const matched = candidates[0];
    if (!matched) continue;

    usedIds.add(matched.id);
    turnIdMap.set(turn.id, matched.id);
    if (matched.id !== turn.id && isImportedTurnRow(matched.lastEventName)) {
      await deleteImportedTurn(db, session.sessionId, turn.id);
    }
  }

  if (turnIdMap.size === 0) return;
  for (const turn of session.turns) {
    turn.id = turnIdMap.get(turn.id) ?? turn.id;
  }
  for (const commandCall of session.commandCalls) {
    commandCall.turnId = turnIdMap.get(commandCall.turnId) ?? commandCall.turnId;
  }
  for (const liveItem of session.liveItems) {
    liveItem.turnId = turnIdMap.get(liveItem.turnId) ?? liveItem.turnId;
  }
  for (const event of session.events) {
    if (event.turnId) event.turnId = turnIdMap.get(event.turnId) ?? event.turnId;
  }
}

async function deleteImportedTurn(db, sessionId, turnId) {
  await db.run(
    `
      DELETE FROM token_usage
      WHERE turn_id = $turnId
        AND session_id = $sessionId
        AND starts_with(COALESCE(source, ''), 'local')
    `,
    { turnId, sessionId },
  );
  await db.run(
    `
      DELETE FROM session_turn_event
      WHERE turn_id = $turnId
        AND session_id = $sessionId
        AND event_name LIKE 'local.%'
    `,
    { turnId, sessionId },
  );
  await db.run(
    `
      DELETE FROM session_live_item
      WHERE turn_id = $turnId
        AND session_id = $sessionId
        AND starts_with(COALESCE(source_event_id, ''), 'local-live:')
    `,
    { turnId, sessionId },
  );
  await db.run(
    `
      DELETE FROM session_turn
      WHERE id = $turnId
        AND session_id = $sessionId
        AND last_event_name LIKE 'local.%'
    `,
    { turnId, sessionId },
  );
}

function isImportedTurnRow(lastEventName) {
  return lastEventName === "local.hook_imported" || lastEventName === "local.imported";
}

function importedTurnPromptsMatch(left, right) {
  const normalizePrompt = (value) => decodeHtmlEntities(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(?:\[Attached files\]|Attached files:|<attached_file\b)[\s\S]*$/i, "")
    .trim();
  return normalizePrompt(left) === normalizePrompt(right);
}

function decodeHtmlEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/gi, (entity) => {
    const numeric = /^&#(x[\da-f]+|\d+);$/i.exec(entity);
    if (numeric) {
      const codePoint = Number.parseInt(numeric[1], numeric[1].toLowerCase().startsWith("x") ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: return entity;
    }
  });
}

async function upsertSessionEvent(db, session, event) {
  const eventId = `local:${shortHash(`${session.path}:${event.index}`)}`;
  await db.run(
    `
      INSERT INTO session_turn_event (
        id,
        turn_id,
        session_id,
        event_name,
        payload,
        created
      )
      VALUES (
        $id,
        $turnId,
        $sessionId,
        $eventName,
        $payload::JSON,
        $created
      )
      ON CONFLICT (id) DO UPDATE SET
        turn_id = excluded.turn_id,
        session_id = excluded.session_id,
        event_name = excluded.event_name,
        payload = excluded.payload
    `,
    {
      id: eventId,
      turnId: event.turnId,
      sessionId: session.sessionId,
      eventName: localEventName(event),
      payload: stringifyStoredJson(event.raw),
      created: event.timestamp ?? session.created,
    },
  );
}

async function upsertLiveItemEvent(db, session, liveItem) {
  const item = normalizeSessionLiveItemPayload(liveItem.item);
  if (!item) return;
  const eventType = stringValue(item.eventType) ?? "item.completed";
  await db.run(
    `
      INSERT INTO session_live_item (
        turn_id, item_id, session_id, item_type, event_type, event_rank, is_final,
        payload, source_event_id, jsonl_index, sequence, created, updated, finalized_at
      )
      VALUES (
        $turnId, $itemId, $sessionId, $itemType, $eventType, $eventRank, true,
        $payload::JSON, $sourceEventId, $jsonlIndex, NULL,
        COALESCE($created::TIMESTAMPTZ, now()), COALESCE($created::TIMESTAMPTZ, now()),
        COALESCE($created::TIMESTAMPTZ, now())
      )
      ON CONFLICT (turn_id, item_id) DO UPDATE SET
        session_id = excluded.session_id,
        item_type = excluded.item_type,
        event_type = excluded.event_type,
        event_rank = excluded.event_rank,
        is_final = true,
        payload = excluded.payload,
        source_event_id = excluded.source_event_id,
        jsonl_index = excluded.jsonl_index,
        updated = excluded.updated,
        finalized_at = excluded.finalized_at
      WHERE session_live_item.jsonl_index IS NULL
         OR excluded.jsonl_index IS NULL
         OR excluded.jsonl_index >= session_live_item.jsonl_index
    `,
    {
      turnId: liveItem.turnId,
      sessionId: session.sessionId,
      itemId: item.id,
      itemType: item.itemType,
      eventType,
      eventRank: sessionLiveItemEventRank(eventType),
      sourceEventId: `local-live:${liveItem.turnId}:${item.id}:${liveItem.jsonlIndex ?? "final"}`,
      jsonlIndex: liveItem.jsonlIndex ?? null,
      created: liveItem.created ?? session.updated,
      payload: stringifyStoredJson(item),
    },
  );
}

async function deleteImportedLiveItems(db, sessionId) {
  await db.run(
    `DELETE FROM session_live_item
     WHERE session_id = $sessionId
       AND starts_with(COALESCE(source_event_id, ''), 'local-live:')`,
    { sessionId },
  );
}

async function upsertCommandCall(db, session, commandCall) {
  const commandParts = commandHeadParts(commandCall.command);
  await db.run(
    `
      INSERT INTO codex_command_call (
        id,
        session_id,
        turn_id,
        item_id,
        first_event_id,
        last_event_id,
        first_jsonl_index,
        last_jsonl_index,
        command,
        command_length,
        response_length,
        command_part_1,
        command_part_2,
        command_part_3,
        status,
        exit_code,
        created,
        updated
      )
      VALUES (
        $id,
        $sessionId,
        $turnId,
        $itemId,
        $firstEventId,
        $lastEventId,
        $firstJsonlIndex,
        $lastJsonlIndex,
        $command,
        $commandLength,
        $responseLength,
        $commandPart1,
        $commandPart2,
        $commandPart3,
        $status,
        $exitCode,
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        first_event_id = excluded.first_event_id,
        last_event_id = excluded.last_event_id,
        first_jsonl_index = excluded.first_jsonl_index,
        last_jsonl_index = excluded.last_jsonl_index,
        command = excluded.command,
        command_length = excluded.command_length,
        response_length = excluded.response_length,
        command_part_1 = excluded.command_part_1,
        command_part_2 = excluded.command_part_2,
        command_part_3 = excluded.command_part_3,
        status = excluded.status,
        exit_code = excluded.exit_code,
        updated = now()
    `,
    {
      id: commandCall.id,
      sessionId: session.sessionId,
      turnId: commandCall.turnId,
      itemId: commandCall.itemId,
      firstEventId: commandCall.firstEventId,
      lastEventId: commandCall.lastEventId,
      firstJsonlIndex: commandCall.firstJsonlIndex,
      lastJsonlIndex: commandCall.lastJsonlIndex,
      command: commandCall.command,
      commandLength: commandCall.command.length,
      responseLength: commandCall.responseLength,
      commandPart1: commandParts[0] ?? null,
      commandPart2: commandParts[1] ?? null,
      commandPart3: commandParts[2] ?? null,
      status: commandCall.status,
      exitCode: commandCall.exitCode,
    },
  );
}

async function upsertImportFile(db, session) {
  await db.run(
    `
      INSERT INTO local_session_file (
        path,
        source,
        workspace_id,
        session_id,
        title,
        cwd,
        file_size,
        file_mtime,
        event_count,
        turn_count,
        parse_error,
        imported_at,
        created,
        updated
      )
      VALUES (
        $path,
        $source,
        $workspaceId,
        $sessionId,
        $title,
        $cwd,
        $fileSize,
        $fileMtime,
        $eventCount,
        $turnCount,
        $parseError,
        now(),
        $created,
        $updated
      )
      ON CONFLICT (path) DO UPDATE SET
        source = excluded.source,
        workspace_id = excluded.workspace_id,
        session_id = excluded.session_id,
        title = excluded.title,
        cwd = excluded.cwd,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        event_count = excluded.event_count,
        turn_count = excluded.turn_count,
        parse_error = excluded.parse_error,
        imported_at = now(),
        created = excluded.created,
        updated = excluded.updated
    `,
    {
      path: session.path,
      source: session.source,
      workspaceId: workspaceIdForSession(session),
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
      fileSize: session.stat.size,
      fileMtime: session.stat.mtime.toISOString(),
      eventCount: session.events.length,
      turnCount: session.turns.length,
      parseError: session.parseErrors.join("\n").slice(0, 4000) || null,
      created: session.created,
      updated: session.updated,
    },
  );
}

async function refreshFtsIndex(db) {
  await db.run(`
    PRAGMA create_fts_index(
      'session_turn',
      'id',
      'user_input',
      'agent_response',
      overwrite = 1
    )
  `);
}

function mirrorSessionIndex(sourcePath, workspaceCodexHomes) {
  if (!existsSync(sourcePath)) return;
  for (const codexHome of new Set(workspaceCodexHomes.values())) {
    copyIfDifferentPath(sourcePath, resolve(codexHome, "session_index.jsonl"));
  }
}

function mirrorSessionFile(session, workspaceCodexHomes) {
  const targetCodexHome = workspaceCodexHomes.get(workspaceIdForSession(session));
  if (!targetCodexHome || !existsSync(session.path)) return;

  const sourceRoot = resolve(codexHome, session.source);
  const relativePath = relative(sourceRoot, session.path);
  if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) return;

  copyIfDifferentPath(session.path, resolve(targetCodexHome, session.source, relativePath));
}

function copyIfDifferentPath(sourcePath, targetPath) {
  if (resolve(sourcePath) === resolve(targetPath)) return;
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

async function normalizeSessionWorkspaces(db) {
  await db.run(
    `
      UPDATE sessions
      SET workspace_id = CASE
        WHEN cwd = $threadexCwd OR cwd LIKE $threadexCwdPrefix THEN $threadexWorkspaceId
        ELSE 'default'
      END
    `,
    {
      threadexCwd: threadexWorkspaceCwd,
      threadexCwdPrefix: `${threadexWorkspaceCwd}/%`,
      threadexWorkspaceId,
    },
  );
}

async function cleanupWorkspaceRows(db) {
  await db.run(
    `
      INSERT INTO active_workspace (key, workspace_id, updated)
      VALUES ('active', $threadexWorkspaceId, now())
      ON CONFLICT (key) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        updated = now()
    `,
    { threadexWorkspaceId },
  );
}

function extractTurnId(payload) {
  if (!isRecord(payload)) return null;
  return (
    stringValue(payload.turn_id) ??
    (isRecord(payload.internal_chat_message_metadata_passthrough)
      ? stringValue(payload.internal_chat_message_metadata_passthrough.turn_id)
      : null)
  );
}

function contentToText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      return stringValue(part.text) ?? stringValue(part.output_text) ?? stringValue(part.input) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolOutputToText(output) {
  return stringValue(output) ?? contentToText(output);
}

function pushUniqueText(values, value) {
  const normalized = normalizeTextBlock(value);
  if (!normalized) return;
  if (!values.some((existing) => normalizeTextBlock(existing) === normalized)) {
    values.push(value);
  }
}

function normalizeTextBlock(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function looksLikeContextOnly(value) {
  const text = value.trim();
  return (
    text.startsWith("# AGENTS.md instructions")
    || text.startsWith("<environment_context>")
    || text.startsWith("<recommended_plugins>")
    || text.startsWith("<codex_internal_context")
    || text.startsWith("<turn_aborted>")
  );
}

function looksLikeSyntheticReviewerInput(value) {
  const text = value.trim();
  return (
    text.startsWith("The following is the Codex agent history added since your last approval assessment.")
    || text.includes(">>> APPROVAL REQUEST START")
    || text.includes(">>> TRANSCRIPT DELTA START")
    || text.includes(">>> TRANSCRIPT END")
    || text.includes("Reviewed Codex session id:")
  );
}

function normalizeLocalCodexUserInput(value) {
  const text = value.trim();
  const marker = "\nUser request:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalizeLocalCodexInternalContext(text.slice(markerIndex + marker.length).trim());
  }
  return normalizeLocalCodexInternalContext(text);
}

function normalizeLocalCodexInternalContext(value) {
  const text = value.trim();
  if (!text.startsWith("<codex_internal_context")) {
    return text;
  }
  const objectiveMatch = /<objective>\s*([\s\S]*?)\s*<\/objective>/i.exec(text);
  return objectiveMatch?.[1]?.trim() ?? text;
}

function idFromFilename(path) {
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1] ?? null;
}

function cleanTitle(value) {
  const text = stringValue(value)?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

function keywordWeightsFromText(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word.length <= 40);
  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  return Object.fromEntries(
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 24)
      .map(([word, count]) => [word, Number((count / max).toFixed(3))]),
  );
}

function commandHeadParts(command) {
  return command.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((part) => part.slice(0, 64));
}

function localEventName(event) {
  return ["local", event.eventType, event.payloadType].filter(Boolean).join(".");
}

function shouldPersistImportedAuditEvent(event) {
  if (event.eventType === "response_item") return false;
  return !new Set([
    "agent_message",
    "agent_reasoning",
    "reasoning",
    "patch_apply_begin",
    "patch_apply_end"
  ]).has(event.payloadType);
}

function normalizeSessionLiveItemPayload(value) {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const itemType = stringValue(value.itemType);
  if (!id || !itemType) return null;
  const eventType = stringValue(value.eventType) ?? "item.completed";
  const normalized = { ...value, id, itemType, eventType: "item.completed" };
  if (itemType !== "command_execution") return normalized;

  const rawOutput = stringValue(value.aggregatedOutput) ?? "";
  const previouslyOmitted = Math.max(0, numberValue(value.omittedOutputChars) ?? 0);
  const visibleOutput = previouslyOmitted > 0
    ? rawOutput.replace(/^\[output truncated: omitted [^\n]+\]\n/, "")
    : rawOutput;
  const totalOutputLength = Math.max(
    visibleOutput.length,
    numberValue(value.aggregatedOutputLength) ?? previouslyOmitted + visibleOutput.length,
  );
  const outputTail = utf8Tail(visibleOutput, sessionLiveItemOutputTailBytes);
  const omittedOutputChars = Math.max(0, totalOutputLength - outputTail.length);
  return {
    ...normalized,
    command: stringValue(value.command) ?? "",
    status: stringValue(value.status) ?? "",
    ...(numberValue(value.exitCode) === null ? {} : { exitCode: numberValue(value.exitCode) }),
    aggregatedOutput: outputTail,
    aggregatedOutputLength: totalOutputLength,
    outputTruncated: omittedOutputChars > 0,
    omittedOutputChars,
  };
}

function utf8Tail(value, maxBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function sessionLiveItemEventRank(eventType) {
  if (eventType === "item.completed") return 3;
  if (eventType === "item.updated") return 2;
  if (eventType === "item.started") return 1;
  return 0;
}

function workspaceIdForSession(session) {
  const requestedWorkspaceId = stringValue(args.workspaceId);
  if (requestedWorkspaceId) return requestedWorkspaceId;
  const cwd = stringValue(session.cwd);
  if (!cwd) return "default";
  const normalizedCwd = resolveUserPath(cwd);
  const pathFromThreadex = relative(threadexWorkspaceCwd, normalizedCwd);
  if (pathFromThreadex === "" || (!pathFromThreadex.startsWith("..") && !pathFromThreadex.startsWith("/"))) {
    return threadexWorkspaceId;
  }
  return "default";
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function minTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxTimestamp(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringifyStoredJson(value) {
  const json = JSON.stringify(value ?? null);
  const byteLength = Buffer.byteLength(json);
  if (byteLength <= storedJsonPayloadLimitBytes) {
    return json;
  }

  let maxStringChars = Math.max(storedJsonPayloadMinStringChars, Math.floor(storedJsonPayloadLimitBytes / 4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = addStoredJsonTruncationMetadata(
      trimStoredJsonStrings(value ?? null, maxStringChars),
      byteLength,
    );
    const trimmedJson = JSON.stringify(payload);
    if (Buffer.byteLength(trimmedJson) <= storedJsonPayloadLimitBytes) {
      return trimmedJson;
    }
    maxStringChars = Math.max(storedJsonPayloadMinStringChars, Math.floor(maxStringChars / 2));
  }

  return stringifyStoredJsonFallback(json, byteLength);
}

function addStoredJsonTruncationMetadata(value, originalJsonBytes) {
  const metadata = {
    threadexPayloadTruncated: true,
    threadexPayloadOriginalJsonBytes: originalJsonBytes,
    threadexPayloadLimitBytes: storedJsonPayloadLimitBytes,
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value, ...metadata };
  }
  return { value, ...metadata };
}

function trimStoredJsonStrings(value, maxStringChars) {
  if (typeof value === "string") {
    return trimStoredString(value, maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => trimStoredJsonStrings(item, maxStringChars));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimStoredJsonStrings(item, maxStringChars)]),
    );
  }
  return value;
}

function trimStoredString(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = `\n[stored payload truncated: omitted ${(value.length - maxChars).toLocaleString()} chars]\n`;
  const contentChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(contentChars / 2);
  const tailChars = contentChars - headChars;
  return `${value.slice(0, headChars)}${marker}${tailChars > 0 ? value.slice(-tailChars) : ""}`;
}

function stringifyStoredJsonFallback(json, originalJsonBytes) {
  let previewChars = Math.min(json.length, Math.floor(storedJsonPayloadLimitBytes / 2));
  while (previewChars >= 0) {
    const fallback = JSON.stringify({
      threadexPayloadTruncated: true,
      threadexPayloadOriginalJsonBytes: originalJsonBytes,
      threadexPayloadLimitBytes: storedJsonPayloadLimitBytes,
      threadexPayloadFallback: true,
      preview: trimStoredString(json, previewChars),
    });
    if (Buffer.byteLength(fallback) <= storedJsonPayloadLimitBytes) {
      return fallback;
    }
    previewChars = Math.floor(previewChars / 2);
  }
  return JSON.stringify({
    threadexPayloadTruncated: true,
    threadexPayloadOriginalJsonBytes: originalJsonBytes,
    threadexPayloadLimitBytes: storedJsonPayloadLimitBytes,
    threadexPayloadFallback: true,
  });
}

function exitCodeFromOutput(output) {
  const match = /Process exited with code (-?\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function resolveUserPath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function isMissingTableError(error) {
  const message = errorMessage(error);
  return message.includes("Table with name") && message.includes("does not exist");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
