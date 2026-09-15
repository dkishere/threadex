import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(rootDir, process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
const dataDir = resolve(rootDir, "data");
const referenceTables = [
  "active_session",
  "local_session_event",
  "local_session_file",
  "session_turn",
  "session_turn_event",
];

const db = await DuckDBInstance.create(dbPath);
const connection = await db.connect();

try {
  const mappings = await buildMappings(connection);
  if (mappings.length === 0) {
    console.log("No non-local session ids found.");
  } else {
    await migrateDatabase(connection, mappings);
    const rewrittenFiles = rewriteDataFiles(mappings);
    console.log(`Migrated ${mappings.length} session id${mappings.length === 1 ? "" : "s"}.`);
    console.log(`Rewrote ${rewrittenFiles} runner data file${rewrittenFiles === 1 ? "" : "s"}.`);
  }
} finally {
  connection.closeSync();
  db.closeSync();
}

async function buildMappings(connection) {
  const result = await connection.run("SELECT id FROM sessions WHERE id NOT LIKE 'local_%' ORDER BY created, id");
  const rows = await result.getRowObjectsJS();
  return rows.map((row) => {
    const oldId = String(row.id);
    return { oldId, newId: `local_${oldId}` };
  });
}

async function migrateDatabase(connection, mappings) {
  await connection.run("BEGIN TRANSACTION");
  try {
    await connection.run("CREATE TEMP TABLE session_id_migration (old_id VARCHAR PRIMARY KEY, new_id VARCHAR NOT NULL)");
    for (const mapping of mappings) {
      await connection.run("INSERT INTO session_id_migration (old_id, new_id) VALUES ($oldId, $newId)", mapping);
    }

    if (await hasColumn(connection, "codex_command_call", "session_id")) {
      await rebuildCodexCommandCall(connection);
    }

    for (const tableName of referenceTables) {
      if (await hasColumn(connection, tableName, "session_id")) {
        await connection.run(`
          UPDATE ${tableName}
          SET session_id = migration.new_id
          FROM session_id_migration AS migration
          WHERE ${tableName}.session_id = migration.old_id
        `);
      }
    }

    await connection.run(`
      UPDATE sessions
      SET parent_session_id = migration.new_id
      FROM session_id_migration AS migration
      WHERE sessions.parent_session_id = migration.old_id
    `);

    await connection.run(`
      UPDATE sessions
      SET id = migration.new_id
      FROM session_id_migration AS migration
      WHERE sessions.id = migration.old_id
    `);

    await connection.run("COMMIT");
    await connection.run("CHECKPOINT");
  } catch (error) {
    await connection.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function rebuildCodexCommandCall(connection) {
  await connection.run("DROP TABLE IF EXISTS codex_command_call_migrated");
  await connection.run(`
    CREATE TABLE codex_command_call_migrated (
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
  await connection.run(`
    INSERT INTO codex_command_call_migrated (
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
    SELECT
      command_call.id,
      COALESCE(migration.new_id, command_call.session_id),
      command_call.turn_id,
      command_call.item_id,
      command_call.first_event_id,
      command_call.last_event_id,
      command_call.first_jsonl_index,
      command_call.last_jsonl_index,
      command_call.command,
      command_call.command_length,
      command_call.response_length,
      command_call.command_part_1,
      command_call.command_part_2,
      command_call.command_part_3,
      command_call.status,
      command_call.exit_code,
      command_call.created,
      command_call.updated
    FROM codex_command_call AS command_call
    LEFT JOIN session_id_migration AS migration
      ON command_call.session_id = migration.old_id
  `);
  await connection.run("DROP TABLE codex_command_call");
  await connection.run("ALTER TABLE codex_command_call_migrated RENAME TO codex_command_call");
  await connection.run("CREATE INDEX IF NOT EXISTS codex_command_call_turn_idx ON codex_command_call(turn_id)");
  await connection.run("CREATE INDEX IF NOT EXISTS codex_command_call_session_idx ON codex_command_call(session_id)");
}

async function hasColumn(connection, tableName, columnName) {
  const result = await connection.run(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $tableName
        AND column_name = $columnName
      LIMIT 1
    `,
    { tableName, columnName },
  );
  return (await result.getRowObjectsJS()).length > 0;
}

function rewriteDataFiles(mappings) {
  const idMap = new Map(mappings.map(({ oldId, newId }) => [oldId, newId]));
  let rewritten = 0;

  for (const dir of [resolve(dataDir, "runner-logs"), resolve(dataDir, "pending-runner-logs")]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".ndjson") && rewriteNdjsonFile(resolve(dir, file), idMap)) {
        rewritten += 1;
      }
    }
  }

  const jobsDir = resolve(dataDir, "runner-jobs");
  if (existsSync(jobsDir)) {
    for (const file of readdirSync(jobsDir)) {
      if (file.endsWith(".json") && rewriteJsonFile(resolve(jobsDir, file), idMap)) {
        rewritten += 1;
      }
    }
  }

  return rewritten;
}

function rewriteNdjsonFile(path, idMap) {
  const original = readFileSync(path, "utf8");
  let changed = false;
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split(/\n/);
  if (hadTrailingNewline) lines.pop();

  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const parsed = JSON.parse(line);
      changed = replaceSessionIds(parsed, idMap) || changed;
      return JSON.stringify(parsed);
    } catch {
      return line;
    }
  });

  if (!changed) return false;
  writeAtomically(path, `${nextLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`);
  return true;
}

function rewriteJsonFile(path, idMap) {
  const original = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch {
    return false;
  }

  if (!replaceSessionIds(parsed, idMap)) {
    return false;
  }

  writeAtomically(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

function replaceSessionIds(value, idMap) {
  if (!value || typeof value !== "object") return false;

  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      changed = replaceSessionIds(item, idMap) || changed;
    }
    return changed;
  }

  for (const [key, current] of Object.entries(value)) {
    if ((key === "sessionId" || key === "session_id") && typeof current === "string" && idMap.has(current)) {
      value[key] = idMap.get(current);
      changed = true;
      continue;
    }
    changed = replaceSessionIds(current, idMap) || changed;
  }

  return changed;
}

function writeAtomically(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}
