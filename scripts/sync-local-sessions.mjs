#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const codexHome = resolveUserPath(args.codexHome ?? process.env.SESSION_LOCAL_CODEX_HOME ?? "~/.codex");
  const defaultWorkspaceCodexHome = resolveUserPath(
    process.env.THREADEX_DEFAULT_WORKSPACE_CODEX_HOME ?? "~/.codex",
  );
  const sourceCodexHomes = uniqueCodexHomeSources([
    { codexHome: defaultWorkspaceCodexHome, workspaceId: "default" },
    { codexHome },
  ]);
  const quietMs = args.quietMs ?? Number(process.env.SESSION_LOCAL_SYNC_QUIET_MS ?? process.env.CODEX_SESSION_FILE_POLL_QUIET_MS ?? 5000);
  const storeId = args.storeId ?? args.db ?? process.env.SESSION_STORE_ID ?? process.env.SESSION_DB_PATH ?? "default";
  const duckdbPath = resolve(rootDir, args.db ?? process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
  let sourceSessions = inspectCodexHomes(sourceCodexHomes.map((source) => source.codexHome), { quietMs });
  let snapshotDir = null;
  let comparison;
  try {
    const inspection = args.check
      ? await inspectManagerSessionsForCheck({ storeId, duckdbPath })
      : { sessions: await inspectManagerSessions(storeId), snapshotDir: null };
    snapshotDir = inspection.snapshotDir;
    comparison = compareSessions(sourceSessions, inspection.sessions);

    printComparison(comparison, sourceSessions.length);
    if (comparison.stale.length === 0) {
      console.log("Local Codex sessions are in sync with manager sessions.");
      return;
    }

    if (args.check) {
      process.exitCode = 1;
      return;
    }
  } finally {
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
  }

  console.log(`Syncing ${comparison.stale.length} stale or missing session file(s) with the standard local-session importer...`);
  for (const source of sourceCodexHomes) {
    runStandardImporter({ ...source, storeId, duckdbPath, rawEvents: args.rawEvents });
  }

  sourceSessions = inspectCodexHomes(sourceCodexHomes.map((source) => source.codexHome), { quietMs });
  const syncedManagerSessions = await inspectManagerSessions(storeId);
  const verified = compareSessions(sourceSessions, syncedManagerSessions);
  printComparison(verified, sourceSessions.length, "Verification");
  if (verified.stale.length > 0) {
    throw new Error(`${verified.stale.length} session file(s) remain out of sync after import`);
  }
  console.log("Local Codex sessions are now in sync with manager sessions.");
}

function inspectCodexHomes(codexHomes, options = {}) {
  return codexHomes.flatMap((codexHome) => inspectCodexSessions(codexHome, options));
}

export function inspectCodexSessions(codexHome, options = {}) {
  const index = readSessionIndex(resolve(codexHome, "session_index.jsonl"));
  return discoverSessionFiles(codexHome).flatMap((path) => {
    const stat = statSync(path);
    if (options.quietMs > 0 && Date.now() - stat.mtimeMs < options.quietMs) return [];
    const sessionFileInfo = readSessionFileInfo(path);
    if (sessionFileInfo.ignored || sessionFileInfo.isMaintenanceSummarizer) return [];
    const threadId = sessionFileInfo.threadId ?? idFromFilename(path);
    return [{
      path,
      codexHome,
      threadId,
      sessionId: threadId ? localSessionIdForCodexSessionId(threadId) : null,
      sessionMetaCount: sessionFileInfo.sessionMetaCount,
      turnIds: sessionFileInfo.turnIds,
      hasParseErrors: sessionFileInfo.hasParseErrors,
      modifiedAt: stat.mtime.toISOString(),
      lastActionAt: index.get(threadId)?.updatedAt ?? null,
    }];
  });
}

function uniqueCodexHomeSources(sources) {
  const seen = new Set();
  const unique = [];
  for (const source of sources) {
    const resolved = resolve(source.codexHome);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push({ ...source, codexHome: resolved });
  }
  return unique;
}

export function compareSessions(sourceSessions, managerSessions) {
  const managerByPath = new Map(managerSessions.map((session) => [resolve(session.path), session]));
  const sourceTurnIdCounts = new Map();
  for (const source of sourceSessions) {
    for (const turnId of source.turnIds ?? []) {
      sourceTurnIdCounts.set(turnId, (sourceTurnIdCounts.get(turnId) ?? 0) + 1);
    }
  }
  const stale = [];
  const current = [];

  for (const source of sourceSessions) {
    const manager = managerByPath.get(resolve(source.path));
    let reason = null;
    if (!manager) {
      reason = "missing import record";
    } else if (source.sessionId && manager.sessionId !== source.sessionId && manager.threadId !== source.threadId) {
      reason = "session id mismatch";
    } else if (hasMissingImportedTurns(source, manager, sourceTurnIdCounts)) {
      reason = "source turn id is missing from manager";
    } else if (!sameInstant(source.modifiedAt, manager.fileModifiedAt)) {
      reason = "source modified_at changed";
    } else if (source.lastActionAt && isBefore(manager.lastActionAt, source.lastActionAt)) {
      reason = "manager last action is older";
    }

    (reason ? stale : current).push({ source, manager, reason });
  }

  return { stale, current };
}

async function inspectManagerSessions(dbPath) {
  if (process.env.SESSION_SYNC_BACKEND === "duckdb") {
    return inspectManagerSessionsDuckDb(dbPath);
  }
  const { tsImport } = await import("tsx/esm/api");
  const { SessionStore } = await tsImport(resolve(rootDir, "src/server/sessionStore.ts"), import.meta.url);
  const store = new SessionStore(dbPath);
  try {
    await store.ready();
    const rows = await store.listImportedLocalSessionSyncState();
    return rows.map((row) => ({
      ...row,
      allTurnIds: new Set(row.allTurnIds),
    }));
  } finally {
    await store.close();
  }
}

async function inspectManagerSessionsDuckDb(dbPath) {
  if (!existsSync(dbPath)) return [];
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const extensionDir = resolve(rootDir, process.env.DUCKDB_EXTENSION_DIRECTORY ?? ".duckdb/extensions");
  const duckdbHome = resolve(rootDir, process.env.DUCKDB_HOME_DIRECTORY ?? ".duckdb/home");
  const instance = await DuckDBInstance.create(dbPath, {
    allow_unsigned_extensions: "true",
    extension_directory: extensionDir,
    home_directory: duckdbHome,
  });
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`
      SELECT
        local_session_file.path,
        local_session_file.session_id,
        sessions.thread_id,
        local_session_file.turn_count,
        CAST(local_session_file.file_mtime AS VARCHAR) AS file_modified_at,
        CAST(coalesce(local_session_file.updated, sessions.updated) AS VARCHAR) AS last_action_at,
        count(session_turn.id) AS stored_turn_count
      FROM local_session_file
      LEFT JOIN sessions ON sessions.id = local_session_file.session_id
      LEFT JOIN session_turn ON session_turn.session_id = local_session_file.session_id
      GROUP BY
        local_session_file.path,
        local_session_file.session_id,
        sessions.thread_id,
        local_session_file.turn_count,
        local_session_file.file_mtime,
        local_session_file.updated,
        sessions.updated
    `);
    const turnReader = await connection.runAndReadAll("SELECT id FROM session_turn");
    const allTurnIds = new Set(turnReader.getRowObjects().map((row) => String(row.id)));
    return reader.getRowObjects().map((row) => ({
      path: String(row.path),
      sessionId: nullableString(row.session_id),
      threadId: nullableString(row.thread_id),
      allTurnIds,
      importedTurnCount: nullableNumber(row.turn_count) ?? 0,
      storedTurnCount: nullableNumber(row.stored_turn_count) ?? 0,
      fileModifiedAt: nullableString(row.file_modified_at),
      lastActionAt: nullableString(row.last_action_at),
    }));
  } catch (error) {
    if (String(error).includes("local_session_file")) return [];
    throw error;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function inspectManagerSessionsForCheck({ storeId, duckdbPath }) {
  if (process.env.SESSION_SYNC_BACKEND !== "duckdb") {
    return { sessions: await inspectManagerSessions(storeId), snapshotDir: null };
  }
  try {
    return { sessions: await inspectManagerSessions(duckdbPath), snapshotDir: null };
  } catch (error) {
    if (!isDuckDbLockError(error) || !existsSync(duckdbPath)) throw error;
    const snapshot = copyDuckDbSnapshot(duckdbPath);
    console.warn(`Manager DuckDB is locked; checking temporary snapshot at ${snapshot.dbPath}`);
    return { sessions: await inspectManagerSessions(snapshot.dbPath), snapshotDir: snapshot.dir };
  }
}

function copyDuckDbSnapshot(dbPath) {
  const dir = mkdtempSync(resolve(tmpdir(), "threadex-sync-check-"));
  const snapshotDbPath = resolve(dir, "threadex.duckdb");
  copyFileSync(dbPath, snapshotDbPath);
  const walPath = `${dbPath}.wal`;
  if (existsSync(walPath)) copyFileSync(walPath, `${snapshotDbPath}.wal`);
  return { dir, dbPath: snapshotDbPath };
}

function runStandardImporter({ codexHome, workspaceId, storeId, duckdbPath, rawEvents }) {
  const importerArgs = [resolve(rootDir, "scripts/import-local-sessions.mjs"), "--codex-home", codexHome];
  if (workspaceId) importerArgs.push("--workspace-id", workspaceId);
  const env = { ...process.env };
  if (process.env.SESSION_SYNC_BACKEND === "duckdb") {
    importerArgs.push("--db", duckdbPath);
    env.SESSION_IMPORT_BACKEND = "duckdb";
  } else {
    importerArgs.push("--store-id", storeId);
  }
  if (!rawEvents) importerArgs.push("--no-raw-events");
  const result = spawnSync(process.execPath, importerArgs, { cwd: rootDir, env, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`standard local-session importer exited with status ${result.status ?? "unknown"}`);
}

function readSessionIndex(path) {
  const index = new Map();
  if (!existsSync(path)) return index;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.id === "string") {
        index.set(record.id, { updatedAt: normalizeTimestamp(record.updated_at) });
      }
    } catch {
      // Match the importer: malformed index lines do not block session discovery.
    }
  }
  return index;
}

function hasMissingImportedTurns(source, manager, sourceTurnIdCounts = new Map()) {
  // The importer skips malformed JSONL records and can still persist the
  // remaining transcript. In that case, individual turn ids are not a
  // reliable completeness signal; modification time still triggers reimport.
  if (source.hasParseErrors) return false;
  if (!Array.isArray(source.turnIds) || source.turnIds.length === 0 || !(manager.allTurnIds instanceof Set)) {
    return false;
  }
  if (Number(manager.importedTurnCount ?? 0) === 0) {
    return false;
  }
  const missingNativeTurnId = source.turnIds.some((turnId) => {
    if (manager.allTurnIds.has(turnId)) return false;
    return Number(sourceTurnIdCounts.get(turnId) ?? 0) <= 1;
  });
  if (!missingNativeTurnId) return false;
  return Number(manager.storedTurnCount ?? 0) < source.turnIds.length;
}

function readSessionFileInfo(path) {
  let threadId = null;
  let sessionMetaCount = 0;
  let currentTurnId = null;
  let firstUserInput = null;
  let foundSessionMeta = false;
  let ignored = false;
  let parseErrorCount = 0;
  const turnsById = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const payload = record.payload;
      if (!foundSessionMeta && record.type === "session_meta" && isRecord(payload)) {
        sessionMetaCount += 1;
        threadId ??= stringValue(payload.session_id) ?? stringValue(payload.id);
        ignored = ignored || isInternalSubagentSessionMeta(payload);
        foundSessionMeta = true;
      }
      const payloadTurnId = extractTurnId(payload);
      if (isRecord(payload) && (payload.type === "task_started" || record.type === "turn_context") && payloadTurnId) {
        currentTurnId = payloadTurnId;
      }
      const turnId = payloadTurnId ?? currentTurnId;
      const turn = turnId ? getTurn(turnsById, turnId) : null;
      const userInput = importedUserInput(record, payload, turn);
      if (userInput && turn) {
        firstUserInput ??= userInput;
        turn.userInput ||= userInput;
      }
      if (turn && isRecord(payload) && payload.type === "task_complete") {
        turn.status = "done";
      }
      if (isRecord(payload) && payload.type === "task_complete" && (!payloadTurnId || payloadTurnId === currentTurnId)) {
        currentTurnId = null;
      }
    } catch {
      // Match the importer: one malformed JSONL line must not make the sync
      // check discard later records or report an already-imported turn stale.
      parseErrorCount += 1;
      continue;
    }
  }
  const turnIds = importableTurnIds(turnsById, ignored);
  return {
    threadId,
    sessionMetaCount,
    turnIds,
    hasParseErrors: parseErrorCount > 0,
    ignored,
    isMaintenanceSummarizer: isMaintenanceSummarizerPrompt(firstUserInput),
  };
}

function getTurn(turnsById, id) {
  const existing = turnsById.get(id);
  if (existing) return existing;
  const turn = { id, userInput: "", status: "running", ignored: false };
  turnsById.set(id, turn);
  return turn;
}

function importableTurnIds(turnsById, ignored) {
  if (ignored) return [];
  return [...turnsById.values()]
    .filter((turn) => turn.status === "done" && turn.userInput && !turn.ignored)
    .map((turn) => turn.id);
}

function importedUserInput(record, payload, turn) {
  if (!isRecord(payload)) return false;
  let rawText = "";
  if (record.type === "event_msg" && payload.type === "user_message") {
    rawText = stringValue(payload.message) ?? "";
  } else if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
    rawText = contentToText(payload.content);
  } else {
    return null;
  }

  const text = normalizeUserInput(rawText);
  if (turn && (looksLikeSyntheticReviewerInput(rawText) || looksLikeSyntheticReviewerInput(text))) {
    turn.ignored = true;
    return null;
  }
  return text && !looksLikeContextOnly(text) ? text : null;
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

function looksLikeContextOnly(value) {
  const text = value.trim();
  return (
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<recommended_plugins>") ||
    text.startsWith("<codex_internal_context") ||
    text.startsWith("<turn_aborted>")
  );
}

function looksLikeSyntheticReviewerInput(value) {
  const text = value.trim();
  return (
    text.startsWith("The following is the Codex agent history added since your last approval assessment.") ||
    text.includes(">>> APPROVAL REQUEST START") ||
    text.includes(">>> TRANSCRIPT DELTA START") ||
    text.includes(">>> TRANSCRIPT END") ||
    text.includes("Reviewed Codex session id:")
  );
}

function normalizeUserInput(value) {
  const text = value.trim();
  const marker = "\nUser request:";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return normalizeInternalContext(text.slice(markerIndex + marker.length).trim());
  }
  return normalizeInternalContext(text);
}

function normalizeInternalContext(value) {
  const text = value.trim();
  if (!text.startsWith("<codex_internal_context")) {
    return text;
  }
  const objectiveMatch = /<objective>\s*([\s\S]*?)\s*<\/objective>/i.exec(text);
  return objectiveMatch?.[1]?.trim() ?? text;
}

function isInternalSubagentSessionMeta(payload) {
  const source = isRecord(payload.source) ? payload.source : null;
  const baseInstructions = isRecord(payload.base_instructions) ? payload.base_instructions : null;
  const baseText = stringValue(baseInstructions?.text) ?? "";
  return (
    payload.thread_source === "subagent" ||
    Boolean(source?.subagent) ||
    baseText.startsWith("You are judging one planned coding-agent action.")
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

function discoverSessionFiles(home) {
  const files = [];
  for (const directory of [resolve(home, "sessions"), resolve(home, "archived_sessions")]) {
    if (existsSync(directory)) files.push(...walkJsonl(directory));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function walkJsonl(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...walkJsonl(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

function idFromFilename(path) {
  return path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

function localSessionIdForCodexSessionId(sessionId) {
  return `tx_${sessionId?.replace(/^(local_|tx_)/, "")}`;
}

function parseArgs(argv) {
  const parsed = { check: false, rawEvents: true, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--codex-home") parsed.codexHome = requiredValue(argv[++index], arg);
    else if (arg === "--store-id") parsed.storeId = requiredValue(argv[++index], arg);
    else if (arg === "--db") {
      parsed.db = requiredValue(argv[++index], arg);
      parsed.storeId = parsed.db;
    }
    else if (arg === "--check" || arg === "--dry-run") parsed.check = true;
    else if (arg === "--quiet-ms") parsed.quietMs = parseNonNegativeInteger(requiredValue(argv[++index], arg), arg);
    else if (arg === "--no-raw-events") parsed.rawEvents = false;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  throw new Error(`${flag} must be a non-negative integer`);
}

function requiredValue(value, flag) {
  if (value && !value.startsWith("--")) return value;
  throw new Error(`${flag} requires a value`);
}

function printUsage() {
  console.log("Usage: npm run sync:local-sessions -- [--codex-home ~/.codex] [--store-id ID] [--check] [--quiet-ms 5000] [--no-raw-events]");
}

function printComparison(comparison, total, label = "Check") {
  console.log(`${label}: ${comparison.current.length}/${total} session file(s) current; ${comparison.stale.length} stale or missing.`);
  for (const item of comparison.stale.slice(0, 20)) {
    console.log(`- ${item.source.sessionId ?? item.source.path}: ${item.reason}`);
  }
  if (comparison.stale.length > 20) console.log(`- ...and ${comparison.stale.length - 20} more`);
}

function sameInstant(left, right) {
  if (!left || !right) return false;
  return Math.abs(Date.parse(left) - Date.parse(right)) < 1;
}

function isBefore(left, right) {
  if (!left) return true;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime < rightTime;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function nullableString(value) {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDuckDbLockError(error) {
  return errorMessage(error).includes("Could not set lock on file");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveUserPath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function isMain(url) {
  return process.argv[1] && resolve(fileURLToPath(url)) === resolve(process.argv[1]);
}
