#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let shuttingDown = false;

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

start("server", "watch-server.mjs", [], { PORT: "5173" });
start("Web VS Code", "watch-client.mjs", ["--web-vscode-only"]);

function start(label, script, args, overrides = {}) {
  const child = spawn(process.execPath, [resolve(rootDir, "scripts", script), ...args], {
    cwd: rootDir,
    env: { ...process.env, ...overrides },
    stdio: "inherit"
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`${label} watcher failed to start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    if (label === "Web VS Code" && code === 0) return;
    console.error(`${label} watcher exited (${signal ?? code}). Stopping serve.`);
    void shutdown(code || 1);
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const pending = [...children].map((child) => new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    child.kill("SIGTERM");
  }));
  await Promise.all(pending);
  process.exitCode = code;
}
