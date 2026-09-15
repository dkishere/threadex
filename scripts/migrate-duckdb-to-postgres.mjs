#!/usr/bin/env node

import { DuckDBInstance } from "@duckdb/node-api";
import pg from "pg";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/server/sessionStore.ts";

const { Pool } = pg;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tableSpecs = [
  ["workspaces", ["id"]],
  ["accounts", ["id"]],
  ["workspace_account", ["workspace_id", "account_id"]],
  ["active_workspace", ["key"]],
  ["active_account", ["key"]],
  ["active_session", ["key"]],
  ["sessions", ["id"]],
  ["process_monitor", ["id"]],
  ["wait_event", ["id"]],
  ["wait_subscription", ["id"]],
  ["session_turn", ["id"]],
  ["session_side_chat", ["id"]],
  ["session_auto_model", ["session_id"]],
  ["session_todo_control", ["session_id"]],
  ["session_todo_item", ["id"]],
  ["session_todo_item_session", ["id"]],
  ["session_todo_message", ["session_id", "id"]],
  ["session_todo_comment", ["id"]],
  ["session_turn_event", ["id"]],
  ["session_live_item", ["turn_id", "item_id"]],
  ["local_session_file", ["path"]],
  ["local_session_event", ["source_path", "event_index"]],
  ["codex_command_call", ["id"]],
  ["account_token_usage_ratio", ["id"]],
  ["session_turn_token_usage_sample", ["id"]],
  ["token_usage", ["id"]],
  ["session_description_embedding", ["session_id"]],
  ["session_summary_state", ["session_id"]],
  ["keyword_appearance", ["workspace_id", "keyword"]]
];

const args = parseArgs(process.argv.slice(2));
const duckdbPath = resolve(rootDir, args.duckdb ?? process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
const postgresUrl = args.postgres ?? process.env.SESSION_DATABASE_URL ?? process.env.DATABASE_URL;
const batchSize = positiveInteger(args.batchSize ?? args["batch-size"], 250);
const truncate = Boolean(args.truncate);

if (!postgresUrl) {
  usage("Missing --postgres URL or SESSION_DATABASE_URL/DATABASE_URL.");
}

if (!existsSync(duckdbPath)) {
  usage(`DuckDB source does not exist: ${duckdbPath}`);
}

const source = await openDuckDbSource(duckdbPath);
const pool = new Pool({ connectionString: postgresUrl });

try {
  await ensurePostgresSchema(postgresUrl);
  const jsonColumns = await loadPostgresJsonColumns(pool);
  const postgresColumns = await loadPostgresColumns(pool);

  if (truncate) {
    await truncatePostgresTables(pool);
  }

  const copied = [];
  for (const [table, primaryKeys] of tableSpecs) {
    if (!(await duckDbTableExists(source.connection, table))) {
      copied.push({ table, skipped: true, sourceRows: 0, postgresRows: await countPostgresRows(pool, table) });
      continue;
    }

    const sourceColumns = await duckDbColumns(source.connection, table);
    const targetColumns = postgresColumns.get(table) ?? new Set();
    const columns = sourceColumns.filter((column) => targetColumns.has(column));
    const missingPrimaryKey = primaryKeys.find((column) => !columns.includes(column));
    if (missingPrimaryKey) {
      throw new Error(`Cannot migrate ${table}; primary key column ${missingPrimaryKey} is missing from source/target intersection.`);
    }
    const sourceRows = await countDuckDbRows(source.connection, table);
    let inserted = 0;
    for await (const rows of readDuckDbRows(source.connection, table, columns, batchSize)) {
      inserted += rows.length;
      await upsertPostgresRows(pool, table, columns, primaryKeys, rows, jsonColumns.get(table) ?? new Set());
    }
    const postgresRows = await countPostgresRows(pool, table);
    copied.push({ table, sourceRows, postgresRows, copiedRows: inserted });
    console.log(`${table}: copied ${inserted}, source ${sourceRows}, postgres ${postgresRows}`);
  }

  const mismatches = copied.filter((row) => !row.skipped && row.sourceRows !== row.postgresRows);
  if (mismatches.length > 0) {
    console.error("Migration row-count verification failed:");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch.table}: source ${mismatch.sourceRows}, postgres ${mismatch.postgresRows}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Migration row-count verification passed.");
  }
} finally {
  await pool.end().catch(() => undefined);
  source.connection.closeSync();
  source.instance.closeSync();
  if (source.snapshotDir) {
    rmSync(source.snapshotDir, { recursive: true, force: true });
  }
}

async function ensurePostgresSchema(postgresConnectionString) {
  const previousBackend = process.env.SESSION_DB_BACKEND;
  const previousUrl = process.env.SESSION_DATABASE_URL;
  process.env.SESSION_DB_BACKEND = "postgres";
  process.env.SESSION_DATABASE_URL = postgresConnectionString;
  const store = new SessionStore(duckdbPath);
  try {
    await store.ready();
  } finally {
    await store.close();
    restoreEnv("SESSION_DB_BACKEND", previousBackend);
    restoreEnv("SESSION_DATABASE_URL", previousUrl);
  }
}

async function openDuckDb(path) {
  const instance = await DuckDBInstance.create(path, {
    allow_unsigned_extensions: "true",
    extension_directory: resolve(rootDir, process.env.DUCKDB_EXTENSION_DIRECTORY ?? ".duckdb/extensions"),
    home_directory: resolve(rootDir, process.env.DUCKDB_HOME_DIRECTORY ?? ".duckdb/home")
  });
  const connection = await instance.connect();
  return { instance, connection };
}

async function openDuckDbSource(path) {
  try {
    return { ...(await openDuckDb(path)), snapshotDir: null };
  } catch (error) {
    if (!isDuckDbLockError(error)) {
      throw error;
    }
    const snapshotDir = mkdtempSync(resolve(tmpdir(), "threadex-duckdb-migration-"));
    const snapshotPath = resolve(snapshotDir, "threadex.duckdb");
    copyFileSync(path, snapshotPath);
    const walPath = `${path}.wal`;
    if (existsSync(walPath)) {
      copyFileSync(walPath, `${snapshotPath}.wal`);
    }
    console.warn(`DuckDB source is locked; migrating from temporary snapshot ${snapshotPath}`);
    return { ...(await openDuckDb(snapshotPath)), snapshotDir };
  }
}

async function loadPostgresJsonColumns(pool) {
  const { rows } = await pool.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND data_type IN ('json', 'jsonb')
    `
  );
  const columnsByTable = new Map();
  for (const row of rows) {
    const tableColumns = columnsByTable.get(row.table_name) ?? new Set();
    tableColumns.add(row.column_name);
    columnsByTable.set(row.table_name, tableColumns);
  }
  return columnsByTable;
}

async function loadPostgresColumns(pool) {
  const { rows } = await pool.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY ordinal_position
    `
  );
  const columnsByTable = new Map();
  for (const row of rows) {
    const tableColumns = columnsByTable.get(row.table_name) ?? new Set();
    tableColumns.add(row.column_name);
    columnsByTable.set(row.table_name, tableColumns);
  }
  return columnsByTable;
}

async function truncatePostgresTables(pool) {
  const tableList = tableSpecs.map(([table]) => quoteIdent(table)).join(", ");
  await pool.query(`TRUNCATE ${tableList}`);
}

async function duckDbTableExists(connection, table) {
  const result = await connection.run(
    `
      SELECT 1 AS found
      FROM information_schema.tables
      WHERE table_name = $table
      LIMIT 1
    `,
    { table }
  );
  return (await result.getRowObjectsJS()).length > 0;
}

async function duckDbColumns(connection, table) {
  const result = await connection.run(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = $table
      ORDER BY ordinal_position
    `,
    { table }
  );
  return (await result.getRowObjectsJS()).map((row) => String(row.column_name));
}

async function countDuckDbRows(connection, table) {
  const result = await connection.run(`SELECT count(*) AS total FROM ${quoteIdent(table)}`);
  const row = (await result.getRowObjectsJS())[0] ?? {};
  return Number(row.total ?? 0);
}

async function countPostgresRows(pool, table) {
  const { rows } = await pool.query(`SELECT count(*)::bigint AS total FROM ${quoteIdent(table)}`);
  return Number(rows[0]?.total ?? 0);
}

async function* readDuckDbRows(connection, table, columns, requestedBatchSize) {
  const batchSize = Math.max(1, Math.min(requestedBatchSize, Math.floor(60000 / Math.max(1, columns.length))));
  let offset = 0;
  while (true) {
    const result = await connection.run(
      `
        SELECT ${columns.map(quoteIdent).join(", ")}
        FROM ${quoteIdent(table)}
        LIMIT $limit OFFSET $offset
      `,
      { limit: batchSize, offset }
    );
    const rows = await result.getRowObjectsJS();
    if (rows.length === 0) {
      break;
    }
    yield rows;
    offset += rows.length;
  }
}

async function upsertPostgresRows(pool, table, columns, primaryKeys, rows, jsonColumns) {
  if (rows.length === 0) {
    return;
  }

  const placeholders = [];
  const values = [];
  for (const row of rows) {
    const rowPlaceholders = [];
    for (const column of columns) {
      values.push(normalizeValue(row[column], jsonColumns.has(column)));
      rowPlaceholders.push(`$${values.length}`);
    }
    placeholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  const conflictTarget = primaryKeys.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const updateSql =
    updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(", ")}`
      : "DO NOTHING";

  await pool.query(
    `
      INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")})
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (${conflictTarget}) ${updateSql}
    `,
    values
  );
}

function normalizeValue(value, isJsonColumn) {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (isJsonColumn && value !== null) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return value;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      usage(`Unexpected positional argument: ${arg}`);
    }
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf("=");
    const key = equalsIndex === -1 ? keyValue : keyValue.slice(0, equalsIndex);
    const value = equalsIndex === -1 ? rawArgs[index + 1] : keyValue.slice(equalsIndex + 1);
    if (key === "truncate") {
      parsed.truncate = true;
      continue;
    }
    if (value === undefined || value.startsWith("--")) {
      usage(`Missing value for --${key}`);
    }
    parsed[key] = value;
    if (equalsIndex === -1) {
      index += 1;
    }
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function isDuckDbLockError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("could not set lock") || normalized.includes("conflicting lock") || normalized.includes("database is locked");
}

function usage(message) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: npm run migrate:duckdb-to-postgres -- --duckdb data/threadex.duckdb --postgres postgres://user:password@127.0.0.1:5432/threadex [--truncate] [--batch-size 250]"
  );
  process.exit(1);
}
