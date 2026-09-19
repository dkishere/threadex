#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(rootDir, "src/server");
const serverEntry = resolve(serverDir, "index.ts");
const tsxCli = resolve(rootDir, "node_modules/tsx/dist/cli.mjs");
const pgDevScript = resolve(rootDir, "scripts/pg-dev.mjs");
const supervisorDir = resolve(process.env.SESSION_DATA_DIR ?? resolve(rootDir, "data"), "process-supervisors");
const supervisorPidPath = resolve(supervisorDir, "server.pid");
const supervisorLogPath = resolve(supervisorDir, "server.log");
const enablePgDev = !process.argv.includes("--no-pg-dev");

if (!existsSync(tsxCli)) {
  console.error("tsx is not installed. Run `npm install` first.");
  process.exit(1);
}

let child = null;
let restartTimer = null;
let restarting = false;
let restartPending = false;
let shuttingDown = false;
let buildChild = null;
let rebuildRequested = false;

mkdirSync(supervisorDir, { recursive: true });
writeFileSync(supervisorPidPath, `${process.pid}\n`, "utf8");
writeFileSync(supervisorLogPath, "", "utf8");

let sourceSnapshot = readSourceSnapshot();
const watcherInterval = setInterval(() => {
  try {
    const nextSnapshot = readSourceSnapshot();
    if (nextSnapshot !== sourceSnapshot) {
      sourceSnapshot = nextSnapshot;
      scheduleRestart("server source change");
    }
  } catch (error) {
    console.error(`Server watcher failed: ${error.message}`);
    void shutdown(1);
  }
}, 350);

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.on("SIGUSR1", () => {
  rebuildRequested = true;
  scheduleRestart("restart request");
});

const defaultDatabaseUrl = ensureLocalPostgres();
startServer();

function startServer() {
  if (shuttingDown) {
    return;
  }

  const env = { ...process.env };
  env.SESSION_DB_BACKEND = "postgres";
  env.SESSION_SERVER_SUPERVISOR_PID = String(process.pid);
  env.SESSION_SUPERVISOR_LOG_CAPTURE = "1";
  if (!env.SESSION_DATABASE_URL && !env.DATABASE_URL && defaultDatabaseUrl) {
    env.SESSION_DATABASE_URL = defaultDatabaseUrl;
  }
  delete env.ENABLE_DUCKDB_UI;

  child = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: rootDir,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  mirrorChildOutput(child);

  child.once("exit", (code, signal) => {
    child = null;

    if (shuttingDown) {
      process.exitCode = code ?? 0;
      return;
    }

    if (restarting) {
      restarting = false;
      console.log("Previous server exited cleanly; starting replacement.");
      startServer();
      if (restartPending) {
        restartPending = false;
        scheduleRestart("changes received during restart");
      }
      return;
    }

    console.error(`Server exited (${signal ?? code}). Waiting for a source change before retrying.`);
  });
}

function ensureLocalPostgres() {
  if (process.env.SESSION_DATABASE_URL || process.env.DATABASE_URL || !enablePgDev) {
    return null;
  }
  const start = spawnSync(process.execPath, [pgDevScript, "start"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (start.status !== 0) {
    console.error("Failed to start local PostgreSQL. Set SESSION_DATABASE_URL or run with --no-pg-dev to skip the helper.");
    process.exit(start.status ?? 1);
  }
  const url = spawnSync(process.execPath, [pgDevScript, "url"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (url.status !== 0) {
    console.error("Failed to read local PostgreSQL URL from pg-dev helper.");
    process.exit(url.status ?? 1);
  }
  return url.stdout.trim();
}

async function restartServer(filename) {
  if (shuttingDown) {
    return;
  }
  if (restarting || buildChild) {
    restartPending = true;
    return;
  }
  if (rebuildRequested) {
    rebuildRequested = false;
    console.log("Restart requested; building TypeScript and frontend before restarting server.");
    const built = await buildBeforeRestart();
    if (shuttingDown) return;
    if (!built) {
      restartPending = false;
      console.error("Build failed; server restart cancelled. Fix the build error and request Restart again.");
      if (rebuildRequested) scheduleRestart("queued restart request");
      return;
    }
  }
  if (!child) {
    console.log(`Change in ${filename}; starting server.`);
    startServer();
    if (restartPending || rebuildRequested) {
      restartPending = false;
      scheduleRestart("queued restart request");
    }
    return;
  }

  restarting = true;
  console.log(`Change in ${filename}; stopping server before restart.`);
  child.kill("SIGTERM");

  setTimeout(() => {
    if (restarting && child) {
      console.warn("Server shutdown is taking longer than 15 seconds; still waiting to protect database state.");
    }
  }, 15_000).unref();
}

function buildBeforeRestart() {
  return new Promise((resolveBuild) => {
    const npmCli = process.env.npm_execpath;
    const builder = spawn(npmCli ? process.execPath : "npm", npmCli ? [npmCli, "run", "build"] : ["run", "build"], {
      cwd: rootDir,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    buildChild = builder;
    mirrorChildOutput(builder);
    builder.once("error", (error) => console.error(`Failed to launch build: ${error.message}`));
    builder.once("close", (code) => {
      buildChild = null;
      resolveBuild(code === 0);
    });
  });
}

function scheduleRestart(reason) {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartServer(reason);
  }, 200);
}

function readSourceSnapshot() {
  return readdirSync(serverDir)
    .filter((filename) => extname(filename) === ".ts")
    .sort()
    .map((filename) => {
      const stats = statSync(resolve(serverDir, filename), { bigint: true });
      return `${filename}:${stats.mtimeNs}:${stats.size}`;
    })
    .join("|");
}

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  rmSync(supervisorPidPath, { force: true });
  clearInterval(watcherInterval);
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  if (buildChild) {
    try {
      if (process.platform !== "win32") process.kill(-buildChild.pid, "SIGTERM");
      else buildChild.kill("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") console.error(`Failed to stop build: ${error.message}`);
    }
  }

  if (!child) {
    process.exit(code);
  }

  process.exitCode = code;
  child.kill("SIGTERM");
}

function mirrorChildOutput(childProcess) {
  childProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    appendFileSync(supervisorLogPath, chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(supervisorLogPath, chunk);
  });
}
