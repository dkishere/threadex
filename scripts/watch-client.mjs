#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareWebVsCodeDevLaunch,
  reclaimOrphanedWebVsCodeDevServer,
  removeWebVsCodeSupervisorPid,
  writeWebVsCodeSupervisorPid
} from "./web-vscode-dev.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteCli = resolve(rootDir, "node_modules/vite/bin/vite.js");
const supervisorDir = resolve(process.env.SESSION_DATA_DIR ?? resolve(rootDir, "data"), "process-supervisors");
const supervisorPidPath = resolve(supervisorDir, "client.pid");
const supervisorLogPath = resolve(supervisorDir, "client.log");

if (!existsSync(viteCli)) {
  console.error("Vite is not installed. Run npm install first.");
  process.exit(1);
}

mkdirSync(supervisorDir, { recursive: true });
writeFileSync(supervisorPidPath, `${process.pid}\n`, "utf8");
writeFileSync(supervisorLogPath, "", "utf8");

let viteChild = null;
let webVsCodeChild = null;
let viteRestarting = false;
let webVsCodeRestarting = false;
let shuttingDown = false;
let viteRetryTimer = null;
let webVsCodeRetryTimer = null;
let webVsCodeStarting = false;

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
process.on("SIGUSR1", () => restartAll());

startVite();
void startWebVsCode();

function startVite() {
  if (shuttingDown) return;
  const child = spawn(process.execPath, [viteCli, "--host", "0.0.0.0", "--port", "5173", "--strictPort"], {
    cwd: rootDir,
    env: { ...process.env, SESSION_SUPERVISOR_LOG_CAPTURE: "1" },
    stdio: ["inherit", "pipe", "pipe"]
  });
  viteChild = child;
  mirrorChildOutput(child, "Vite");
  child.once("exit", (code, signal) => {
    if (viteChild === child) viteChild = null;
    if (shuttingDown) return;
    if (viteRestarting) {
      viteRestarting = false;
      startVite();
      return;
    }
    console.error(`Vite client exited (${signal ?? code}). Retrying in 1 second.`);
    viteRetryTimer = setTimeout(() => {
      viteRetryTimer = null;
      startVite();
    }, 1_000);
  });
}

async function startWebVsCode() {
  if (shuttingDown || webVsCodeStarting) return;
  webVsCodeStarting = true;
  const launch = prepareWebVsCodeDevLaunch(rootDir);
  if (!launch.enabled) {
    console.log(`Web VS Code development startup skipped: ${launch.reason}.`);
    webVsCodeStarting = false;
    return;
  }
  try {
    const portState = await reclaimOrphanedWebVsCodeDevServer(launch);
    if (portState.state === "foreign") {
      console.error(`Web VS Code did not start: port ${launch.port} is in use by another process (PID ${portState.process.pid}).`);
      return;
    }
    if (portState.state === "supervised") {
      console.log(`Web VS Code is already running under another Threadex dev client (PID ${portState.process.pid}).`);
      return;
    }

    const child = spawn(launch.command, launch.args, {
      cwd: rootDir,
      env: launch.env,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(launch.command),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    webVsCodeChild = child;
    writeWebVsCodeSupervisorPid(launch, child.pid);
    mirrorChildOutput(child, "Web VS Code");
    console.log(`Starting Web VS Code on http://127.0.0.1:${launch.port}`);

    let portConflict = false;
    child.stderr?.on("data", (chunk) => {
      if (String(chunk).includes("EADDRINUSE")) portConflict = true;
    });
    let settled = false;
    const finish = (description) => {
      if (settled) return;
      settled = true;
      removeWebVsCodeSupervisorPid(launch, child.pid);
      if (webVsCodeChild === child) webVsCodeChild = null;
      if (shuttingDown) return;
      if (webVsCodeRestarting) {
        webVsCodeRestarting = false;
        void startWebVsCode();
        return;
      }
      if (portConflict) {
        console.error(`Web VS Code stopped: port ${launch.port} became occupied. Restarting is paused to avoid an EADDRINUSE loop.`);
        return;
      }
      if (isMissingExecutableError(description)) {
        console.error(`Web VS Code startup skipped: ${launch.command} was not found. Install code-server or set CODE_SERVER_COMMAND.`);
        return;
      }
      console.error(`Web VS Code exited (${description}). Retrying in 1 second.`);
      webVsCodeRetryTimer = setTimeout(() => {
        webVsCodeRetryTimer = null;
        void startWebVsCode();
      }, 1_000);
    };
    child.once("error", (error) => finish(error.message));
    child.once("exit", (code, signal) => finish(signal ?? code));
  } finally {
    webVsCodeStarting = false;
  }
}

function restartAll() {
  restartVite();
  restartWebVsCode();
}

function restartVite() {
  if (shuttingDown || viteRestarting) return;
  if (!viteChild) {
    startVite();
    return;
  }
  viteRestarting = true;
  viteChild.kill("SIGTERM");
}

function restartWebVsCode() {
  if (shuttingDown || webVsCodeRestarting) return;
  if (!webVsCodeChild) {
    void startWebVsCode();
    return;
  }
  webVsCodeRestarting = true;
  signalChild(webVsCodeChild, "SIGTERM", true);
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (viteRetryTimer) clearTimeout(viteRetryTimer);
  if (webVsCodeRetryTimer) clearTimeout(webVsCodeRetryTimer);
  viteRetryTimer = null;
  webVsCodeRetryTimer = null;
  await Promise.all([
    stopChild(viteChild, "Vite"),
    stopChild(webVsCodeChild, "Web VS Code", true)
  ]);
  removeSupervisorPidIfOwned();
  process.exit(code);
}

function removeSupervisorPidIfOwned() {
  try {
    if (readFileSync(supervisorPidPath, "utf8").trim() === String(process.pid)) {
      rmSync(supervisorPidPath, { force: true });
    }
  } catch {
    // The watcher may be shutting down after another supervisor took over.
  }
}

function stopChild(childProcess, label, processGroup = false) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveStop) => {
    let finished = false;
    const complete = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      resolveStop();
    };
    const forceTimer = setTimeout(() => {
      console.warn(`${label} did not stop within 8 seconds; forcing termination.`);
      signalChild(childProcess, "SIGKILL", processGroup);
    }, 8_000);
    childProcess.once("exit", complete);
    try {
      signalChild(childProcess, "SIGTERM", processGroup);
    } catch {
      complete();
    }
  });
}

function signalChild(childProcess, signal, processGroup = false) {
  if (!childProcess) return false;
  if (processGroup && process.platform !== "win32" && childProcess.pid) {
    try {
      process.kill(-childProcess.pid, signal);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return childProcess.kill(signal);
}

function mirrorChildOutput(childProcess, label) {
  childProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    appendFileSync(supervisorLogPath, chunk);
  });
  childProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    appendFileSync(supervisorLogPath, chunk);
  });
  childProcess.once("error", (error) => {
    const message = `${label} failed to start: ${error.message}\n`;
    process.stderr.write(message);
    appendFileSync(supervisorLogPath, message);
  });
}

function isMissingExecutableError(description) {
  return typeof description === "string" && /(?:spawn|ENOENT)/i.test(description) && /ENOENT/i.test(description);
}
