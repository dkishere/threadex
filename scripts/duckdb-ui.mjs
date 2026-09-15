#!/usr/bin/env node

import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const appDbPath = resolve(rootDir, args[0] ?? process.env.SESSION_DB_PATH ?? "data/threadex.duckdb");
const uiCatalogPath = resolve(rootDir, process.env.DUCKDB_UI_CATALOG_PATH ?? "data/threadex-ui.duckdb");
const extensionDir = resolve(rootDir, process.env.DUCKDB_EXTENSION_DIRECTORY ?? ".duckdb/extensions");
const duckdbHome = resolve(rootDir, process.env.DUCKDB_HOME_DIRECTORY ?? ".duckdb/home");
const assetPort = parsePort(process.env.DBXLITE_ASSET_PORT, 8080);
const uiPort = parsePort(process.env.DUCKDB_UI_PORT, 4213);
const attachAlias = sanitizeIdentifier(process.env.DUCKDB_UI_ATTACH_ALIAS ?? "threadex");
const dbxliteCli = resolve(rootDir, "node_modules/dbxlite-ui/dist/cli.js");

if (!existsSync(dbxliteCli)) {
  console.error("dbxlite-ui is not installed. Run `npm install` first.");
  process.exit(1);
}

mkdirSync(dirname(uiCatalogPath), { recursive: true });
mkdirSync(extensionDir, { recursive: true });
mkdirSync(duckdbHome, { recursive: true });
mkdirSync(resolve(duckdbHome, ".duckdb"), { recursive: true });

const assetServer = spawn(process.execPath, [dbxliteCli, "--port", String(assetPort)], {
  cwd: rootDir,
  stdio: ["ignore", "pipe", "pipe"],
});

assetServer.stdout.on("data", (chunk) => process.stdout.write(prefixLines("dbxlite", chunk)));
assetServer.stderr.on("data", (chunk) => process.stderr.write(prefixLines("dbxlite", chunk)));
assetServer.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`dbxlite asset server exited (${signal ?? code}).`);
    process.exit(code ?? 1);
  }
});

let instance;
let connection;
let shuttingDown = false;

try {
  await waitForHttp(`http://127.0.0.1:${assetPort}/`, 10_000);

  instance = await DuckDBInstance.create(uiCatalogPath, {
    allow_unsigned_extensions: "true",
    extension_directory: extensionDir,
    home_directory: duckdbHome,
  });
  connection = await instance.connect();

  await run("INSTALL ui");
  await run("LOAD ui");
  await run(`SET ui_local_port = ${uiPort}`);
  await run(`SET ui_remote_url = 'http://127.0.0.1:${assetPort}'`);
  await run(`ATTACH '${escapeSqlString(appDbPath)}' AS "${attachAlias}" (READ_ONLY)`);
  await run(`USE "${attachAlias}"`);

  console.log(`DuckDB UI catalog: ${uiCatalogPath}`);
  console.log(`Attached app DB read-only as "${attachAlias}": ${appDbPath}`);
  console.log(`Starting DuckDB UI on http://localhost:${uiPort}`);

  const startPromise = run("CALL start_ui_server()");
  startPromise
    .then(() => console.log("DuckDB UI server returned."))
    .catch((error) => {
      console.error(`Failed to start DuckDB UI: ${error.message}`);
      void shutdown(1);
    });

  setTimeout(() => {
    if (!shuttingDown) {
      console.log(`Open http://localhost:${uiPort}`);
    }
  }, 1_500);
} catch (error) {
  console.error(error.message);
  await shutdown(1);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.stdin.resume();

async function run(sql) {
  return connection.run(sql);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (connection) {
      try {
        await connection.run("CALL stop_ui_server()");
      } catch {
        // The UI extension may not have loaded or the server may already be stopped.
      }
      connection.closeSync();
    }
    instance?.closeSync();
  } finally {
    assetServer.kill("SIGTERM");
    process.exit(code);
  }
}

function parsePort(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  throw new Error(`Invalid port: ${value}`);
}

function sanitizeIdentifier(value) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
  throw new Error(`Invalid DuckDB attach alias: ${value}`);
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part, index, parts) => {
      if (part === "\n" || part === "\r\n" || part.length === 0) return part;
      const previous = parts[index - 1];
      return index === 0 || previous === "\n" || previous === "\r\n" ? `[${label}] ${part}` : part;
    })
    .join("");
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));
  }

  throw new Error(`dbxlite asset server did not become ready at ${url}: ${lastError?.message ?? "timeout"}`);
}
