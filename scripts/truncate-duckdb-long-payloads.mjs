#!/usr/bin/env node

import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(rootDir, args.db ?? process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
const storedJsonPayloadLimitBytes = Number(
  args.limitBytes ?? process.env.SESSION_EVENT_JSON_LIMIT_BYTES ?? 10 * 1024 * 1024,
);
const storedJsonPayloadMinStringChars = 1024;
const targets = [
  { table: "session_turn_event", keys: ["id"], column: "payload" },
  { table: "token_usage", keys: ["id"], column: "metadata" },
  { table: "local_session_event", keys: ["source_path", "event_index"], column: "payload" },
  { table: "local_session_event", keys: ["source_path", "event_index"], column: "raw" },
];

if (!Number.isSafeInteger(storedJsonPayloadLimitBytes) || storedJsonPayloadLimitBytes <= 0) {
  throw new Error("Payload limit must be a positive safe integer.");
}

let instance;
let connection;

try {
  instance = await DuckDBInstance.create(dbPath);
  connection = await instance.connect();

  const beforeBytes = statSync(dbPath).size;
  const summaries = [];
  for (const target of targets) {
    if (!(await targetExists(connection, target))) {
      continue;
    }
    summaries.push({ ...target, ...(await oversizedStats(connection, target)) });
  }
  const redundant = await redundantStats(connection);

  console.log(
    JSON.stringify(
      {
        dbPath,
        dryRun: args.dryRun,
        limitBytes: storedJsonPayloadLimitBytes,
        databaseBytesBefore: beforeBytes,
        redundant,
        targets: summaries,
      },
      jsonReplacer,
      2,
    ),
  );

  if (args.dryRun) {
    process.exitCode = 0;
  } else {
    let truncatedRows = 0;
    let originalJsonBytes = 0;
    let storedJsonBytes = 0;

    await deleteRedundantRows(connection);

    for (const target of summaries) {
      while (true) {
        const row = await nextOversizedRow(connection, target);
        if (!row) {
          break;
        }

        const originalJson = String(row.payload_json);
        const trimmedJson = stringifyStoredJson(JSON.parse(originalJson));
        await updatePayload(connection, target, row, trimmedJson);
        truncatedRows += 1;
        originalJsonBytes += Buffer.byteLength(originalJson);
        storedJsonBytes += Buffer.byteLength(trimmedJson);

        if (truncatedRows % 25 === 0) {
          console.log(`Truncated ${truncatedRows} oversized JSON payloads...`);
        }
      }
    }

    await connection.run("CHECKPOINT");

    const databaseBytesAfterRewrite = statSync(dbPath).size;
    connection.closeSync();
    connection = null;
    instance.closeSync();
    instance = null;

    const compacted = await compactDatabase(
      dbPath,
      args.existingCompact ? resolve(rootDir, args.existingCompact) : null,
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          truncatedRows,
          deletedSupersededItemRows: redundant.supersededItemRows,
          deletedLegacyLocalEventRows: redundant.legacyLocalEventRows,
          originalJsonBytes,
          storedJsonBytes,
          databaseBytesAfterRewrite,
          databaseBytesAfter: compacted.databaseBytesAfter,
          precompactBackupPath: compacted.precompactBackupPath,
        },
        jsonReplacer,
        2,
      ),
    );
  }
} finally {
  connection?.closeSync();
  instance?.closeSync();
}

async function redundantStats(db) {
  const itemResult = await db.run(`
    WITH ranked AS (
      SELECT
        octet_length(encode(CAST(payload AS VARCHAR))) AS payload_bytes,
        row_number() OVER (
          PARTITION BY turn_id, COALESCE(json_extract_string(payload, '$.id'), id)
          ORDER BY created DESC, id DESC
        ) AS row_number
      FROM session_turn_event
      WHERE event_name = 'item'
    )
    SELECT
      count(*) FILTER (WHERE row_number > 1) AS redundant_rows,
      COALESCE(sum(payload_bytes) FILTER (WHERE row_number > 1), 0) AS redundant_bytes
    FROM ranked
  `);
  const [itemRow] = await itemResult.getRowObjectsJS();

  const localTableExists = await tableExists(db, "local_session_event");
  let localRow = { redundant_rows: 0, redundant_bytes: 0 };
  if (localTableExists) {
    const localResult = await db.run(`
      SELECT
        count(*) AS redundant_rows,
        COALESCE(
          sum(octet_length(encode(CAST(payload AS VARCHAR))))
          + sum(octet_length(encode(CAST(raw AS VARCHAR)))),
          0
        ) AS redundant_bytes
      FROM local_session_event
    `);
    [localRow] = await localResult.getRowObjectsJS();
  }

  return {
    supersededItemRows: Number(itemRow?.redundant_rows ?? 0),
    supersededItemBytes: Number(itemRow?.redundant_bytes ?? 0),
    legacyLocalEventRows: Number(localRow?.redundant_rows ?? 0),
    legacyLocalEventBytes: Number(localRow?.redundant_bytes ?? 0),
  };
}

async function deleteRedundantRows(db) {
  await db.run(`
    DELETE FROM session_turn_event
    WHERE id IN (
      SELECT id
      FROM (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY turn_id, COALESCE(json_extract_string(payload, '$.id'), id)
            ORDER BY created DESC, id DESC
          ) AS row_number
        FROM session_turn_event
        WHERE event_name = 'item'
      ) AS ranked
      WHERE row_number > 1
    )
  `);
  if (await tableExists(db, "local_session_event")) {
    await db.run("DELETE FROM local_session_event");
  }
}

async function tableExists(db, table) {
  const result = await db.run(
    "SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema = 'main' AND table_name = $table",
    { table },
  );
  const [row] = await result.getRowObjectsJS();
  return Number(row?.table_count ?? 0) === 1;
}

async function compactDatabase(path, existingCompactPath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const compactPath = existingCompactPath ?? `${path}.compact-${timestamp}`;
  const precompactBackupPath = `${path}.precompact-${timestamp}`;
  if ((!existingCompactPath && existsSync(compactPath)) || existsSync(precompactBackupPath)) {
    throw new Error("Refusing to overwrite an existing compaction file.");
  }
  if (existingCompactPath && !existsSync(compactPath)) {
    throw new Error(`Existing compact database not found: ${compactPath}`);
  }

  const memoryInstance = await DuckDBInstance.create(":memory:");
  const db = await memoryInstance.connect();
  try {
    await db.run(`ATTACH '${escapeSqlString(path)}' AS source_db (READ_ONLY)`);
    await db.run(`ATTACH '${escapeSqlString(compactPath)}' AS compact_db${existingCompactPath ? " (READ_ONLY)" : ""}`);
    if (!existingCompactPath) {
      await db.run("COPY FROM DATABASE source_db TO compact_db");
      await db.run("CHECKPOINT compact_db");
    }

    await validateDatabaseCopy(db);

    await db.run("DETACH compact_db");
    await db.run("DETACH source_db");
  } finally {
    db.closeSync();
    memoryInstance.closeSync();
  }

  const databaseBytesAfter = statSync(compactPath).size;
  renameSync(path, precompactBackupPath);
  renameSync(compactPath, path);
  return { databaseBytesAfter, precompactBackupPath };
}

async function validateDatabaseCopy(db) {
  const result = await db.run(`
    SELECT database_name, table_name
    FROM duckdb_tables()
    WHERE database_name IN ('source_db', 'compact_db')
      AND schema_name = 'main'
    ORDER BY database_name, table_name
  `);
  const rows = await result.getRowObjectsJS();
  const sourceTables = rows.filter((row) => row.database_name === "source_db").map((row) => String(row.table_name));
  const compactTables = rows.filter((row) => row.database_name === "compact_db").map((row) => String(row.table_name));
  if (sourceTables.join("\n") !== compactTables.join("\n")) {
    throw new Error("Compacted database table-list validation failed.");
  }

  for (const table of sourceTables) {
    const quotedTable = quoteIdentifier(table);
    const counts = await db.run(`
      SELECT
        (SELECT count(*) FROM source_db.main.${quotedTable}) AS source_count,
        (SELECT count(*) FROM compact_db.main.${quotedTable}) AS compact_count
    `);
    const [row] = await counts.getRowObjectsJS();
    if (row?.source_count !== row?.compact_count) {
      throw new Error(`Compacted database row-count validation failed for table ${table}.`);
    }
  }
}

function parseArgs(argv) {
  const parsed = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--db") {
      parsed.db = requireValue(argv, ++index, arg);
    } else if (arg === "--limit-bytes") {
      parsed.limitBytes = Number(requireValue(argv, ++index, arg));
    } else if (arg === "--existing-compact") {
      parsed.existingCompact = requireValue(argv, ++index, arg);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/truncate-duckdb-long-payloads.mjs [--db PATH] [--limit-bytes N] [--dry-run] [--existing-compact PATH]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

async function targetExists(db, target) {
  const result = await db.run(
    `
      SELECT count(*) AS column_count
      FROM information_schema.columns
      WHERE table_schema = 'main'
        AND table_name = $table
        AND column_name IN (${[...target.keys, target.column].map((_, index) => `$column${index}`).join(", ")})
    `,
    Object.fromEntries([
      ["table", target.table],
      ...[...target.keys, target.column].map((column, index) => [`column${index}`, column]),
    ]),
  );
  const [row] = await result.getRowObjectsJS();
  return Number(row?.column_count ?? 0) === target.keys.length + 1;
}

async function oversizedStats(db, target) {
  const result = await db.run(`
    SELECT
      count(*) AS oversized_rows,
      COALESCE(sum(octet_length(encode(CAST(${quoteIdentifier(target.column)} AS VARCHAR)))), 0) AS oversized_bytes,
      COALESCE(max(octet_length(encode(CAST(${quoteIdentifier(target.column)} AS VARCHAR)))), 0) AS largest_bytes
    FROM ${quoteIdentifier(target.table)}
    WHERE octet_length(encode(CAST(${quoteIdentifier(target.column)} AS VARCHAR))) > ${storedJsonPayloadLimitBytes}
  `);
  const [row] = await result.getRowObjectsJS();
  return {
    oversizedRows: Number(row?.oversized_rows ?? 0),
    oversizedBytes: Number(row?.oversized_bytes ?? 0),
    largestBytes: Number(row?.largest_bytes ?? 0),
  };
}

async function nextOversizedRow(db, target) {
  const selectedKeys = target.keys.map(quoteIdentifier).join(", ");
  const result = await db.run(`
    SELECT ${selectedKeys}, CAST(${quoteIdentifier(target.column)} AS VARCHAR) AS payload_json
    FROM ${quoteIdentifier(target.table)}
    WHERE octet_length(encode(CAST(${quoteIdentifier(target.column)} AS VARCHAR))) > ${storedJsonPayloadLimitBytes}
    LIMIT 1
  `);
  const [row] = await result.getRowObjectsJS();
  return row ?? null;
}

async function updatePayload(db, target, row, payload) {
  const params = { payload };
  const predicates = target.keys.map((key, index) => {
    params[`key${index}`] = row[key];
    return `${quoteIdentifier(key)} = $key${index}`;
  });
  await db.run(
    `UPDATE ${quoteIdentifier(target.table)} SET ${quoteIdentifier(target.column)} = $payload::JSON WHERE ${predicates.join(" AND ")}`,
    params,
  );
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function stringifyStoredJson(value) {
  const json = JSON.stringify(value ?? null);
  const byteLength = Buffer.byteLength(json);
  if (byteLength <= storedJsonPayloadLimitBytes) {
    return json;
  }

  let maxStringChars = Math.max(storedJsonPayloadMinStringChars, Math.floor(storedJsonPayloadLimitBytes / 4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = addStoredJsonTruncationMetadata(trimStoredJsonStrings(value ?? null, maxStringChars), byteLength);
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

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? Number(value) : value;
}
