import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const EXTENSION_ID = "threadex.threadex-review";
const EXTENSION_VERSION = "0.1.0";
const EXTENSION_DIRECTORY_NAME = `${EXTENSION_ID}-${EXTENSION_VERSION}-universal`;

export function resolveWebVsCodeDevLaunch(rootDir, env = process.env, pathExists = existsSync) {
  if (env.WEB_VSCODE_URL?.trim()) {
    return { enabled: false, reason: "WEB_VSCODE_URL is configured" };
  }
  if (env.WEB_VSCODE_AUTOSTART === "false") {
    return { enabled: false, reason: "WEB_VSCODE_AUTOSTART=false" };
  }

  const port = Number(env.WEB_VSCODE_PORT ?? 8790);
  const homebrewCommand = "/opt/homebrew/opt/code-server/bin/code-server";
  const command = env.CODE_SERVER_COMMAND?.trim() || (pathExists(homebrewCommand) ? homebrewCommand : "code-server");
  const dataDir = resolve(env.SESSION_DATA_DIR ?? resolve(rootDir, "data"));
  const userDataDir = resolve(dataDir, "code-server", "user-data");
  const extensionsDir = resolve(dataDir, "code-server", "extensions");
  const reviewRequestDirectory = resolve(dataDir, "code-server", "review-requests");
  const walkthroughActionDirectory = resolve(dataDir, "code-server", "walkthrough-actions");
  const walkthroughResultDirectory = resolve(dataDir, "code-server", "walkthrough-results");
  const supervisorDir = resolve(dataDir, "process-supervisors");
  const supervisorPidPath = resolve(supervisorDir, "web-vscode.pid");

  return {
    enabled: true,
    command,
    port,
    userDataDir,
    extensionsDir,
    reviewRequestDirectory,
    walkthroughActionDirectory,
    walkthroughResultDirectory,
    supervisorDir,
    supervisorPidPath,
    bundledReviewExtension: resolve(rootDir, "extensions", "threadex-review"),
    args: [
      "--bind-addr", `127.0.0.1:${port}`,
      "--auth", "none",
      "--disable-telemetry",
      "--disable-update-check",
      "--disable-workspace-trust",
      "--user-data-dir", userDataDir,
      "--extensions-dir", extensionsDir
    ],
    env: {
      ...env,
      THREADEX_REVIEW_REQUEST_DIR: reviewRequestDirectory,
      THREADEX_WALKTHROUGH_ACTION_DIR: walkthroughActionDirectory,
      THREADEX_WALKTHROUGH_RESULT_DIR: walkthroughResultDirectory
    }
  };
}

export function prepareWebVsCodeDevLaunch(rootDir, env = process.env) {
  const launch = resolveWebVsCodeDevLaunch(rootDir, env);
  if (!launch.enabled) return launch;

  launch.command = resolveCommandForSpawn(launch.command, env);
  mkdirSync(launch.userDataDir, { recursive: true });
  mkdirSync(launch.extensionsDir, { recursive: true });
  mkdirSync(launch.reviewRequestDirectory, { recursive: true });
  mkdirSync(launch.walkthroughActionDirectory, { recursive: true });
  mkdirSync(launch.walkthroughResultDirectory, { recursive: true });
  mkdirSync(launch.supervisorDir, { recursive: true });
  installBundledReviewExtension(launch.bundledReviewExtension, launch.extensionsDir);
  return launch;
}

/**
 * Windows' command lookup can find extensionless Unix shims and PowerShell
 * scripts, but Node's spawn() cannot execute either without a shell. Prefer
 * the generated .cmd launcher when a bare command resolves to one.
 */
function resolveCommandForSpawn(command, env) {
  if (process.platform !== "win32" || /[\\/]/.test(command) || !/^[\w.-]+$/.test(command)) {
    return command;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const pathEntries = pathKey ? String(env[pathKey] ?? "").split(";").filter(Boolean) : [];
  for (const directory of pathEntries) {
    for (const extension of [".cmd", ".bat", ".exe", ".com"]) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * code-server starts a small launcher which then starts the actual server.
 * It is safe to reclaim only a launcher whose command includes every
 * Threadex-specific address and data directory. This intentionally does not
 * treat an arbitrary listener on the same port as ours.
 */
export function isThreadexWebVsCodeCommand(command, launch) {
  if (typeof command !== "string") return false;
  return command.includes("code-server")
    && command.includes(`--bind-addr 127.0.0.1:${launch.port}`)
    && command.includes(`--user-data-dir ${launch.userDataDir}`)
    && command.includes(`--extensions-dir ${launch.extensionsDir}`);
}

export function writeWebVsCodeSupervisorPid(launch, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  mkdirSync(launch.supervisorDir, { recursive: true });
  writeFileSync(launch.supervisorPidPath, `${pid}\n`, "utf8");
}

export function removeWebVsCodeSupervisorPid(launch, pid) {
  try {
    if (readFileSync(launch.supervisorPidPath, "utf8").trim() === String(pid)) {
      rmSync(launch.supervisorPidPath, { force: true });
    }
  } catch {
    // A later supervisor may already own the pid file.
  }
}

export function inspectWebVsCodeDevServer(launch, system = localProcessSystem) {
  const recordedPid = readPidFile(launch.supervisorPidPath);
  if (recordedPid) {
    const recordedProcess = system.getProcess(recordedPid);
    if (recordedProcess && isThreadexWebVsCodeCommand(recordedProcess.command, launch)) {
      return { state: "owned", process: recordedProcess, source: "pid-file" };
    }
    removeWebVsCodeSupervisorPid(launch, recordedPid);
  }

  const listenerPid = system.getListeningProcessId(launch.port);
  if (!listenerPid) return { state: "available" };

  const listener = system.getProcess(listenerPid);
  if (listener && isThreadexWebVsCodeCommand(listener.command, launch)) {
    return { state: "owned", process: listener, source: "listener" };
  }

  const parent = listener?.ppid > 1 ? system.getProcess(listener.ppid) : null;
  if (parent && isThreadexWebVsCodeCommand(parent.command, launch)) {
    return { state: "owned", process: parent, source: "listener-parent" };
  }

  return { state: "foreign", process: listener ?? { pid: listenerPid, ppid: null, command: "unknown" } };
}

/**
 * Reclaim a previous server only when it is orphaned. A live watcher is left
 * alone: a second `dev:client` should not be allowed to terminate it.
 */
export async function reclaimOrphanedWebVsCodeDevServer(launch, system = localProcessSystem) {
  const initial = inspectWebVsCodeDevServer(launch, system);
  if (initial.state === "available") return initial;
  if (initial.state === "foreign") return initial;
  if (initial.process.ppid !== 1) {
    return { state: "supervised", process: initial.process, source: initial.source };
  }

  signalOwnedProcessGroup(system, initial.process.pid, "SIGTERM");
  if (await waitForProcessExit(initial.process.pid, system, 7_000)) {
    removeWebVsCodeSupervisorPid(launch, initial.process.pid);
  } else {
    signalOwnedProcessGroup(system, initial.process.pid, "SIGKILL");
    await waitForProcessExit(initial.process.pid, system, 1_000);
    removeWebVsCodeSupervisorPid(launch, initial.process.pid);
  }

  await waitForPortRelease(launch.port, system, 7_000);
  return inspectWebVsCodeDevServer(launch, system);
}

export function installBundledReviewExtension(sourceDirectory, extensionsDirectory) {
  if (!existsSync(sourceDirectory)) return null;
  const targetDirectory = resolve(extensionsDirectory, EXTENSION_DIRECTORY_NAME);
  const legacyTargetDirectory = resolve(extensionsDirectory, `${EXTENSION_ID}-${EXTENSION_VERSION}`);
  rmSync(legacyTargetDirectory, { recursive: true, force: true });
  cpSync(sourceDirectory, targetDirectory, { recursive: true, force: true });

  const registryPath = resolve(extensionsDirectory, "extensions.json");
  const registry = readJsonArray(registryPath)
    .filter((entry) => entry.identifier?.id !== EXTENSION_ID);
  registry.push({
    identifier: { id: EXTENSION_ID },
    version: EXTENSION_VERSION,
    location: { $mid: 1, path: targetDirectory, scheme: "file" },
    relativeLocation: EXTENSION_DIRECTORY_NAME,
    metadata: {
      installedTimestamp: Date.now(),
      pinned: true,
      source: "vsix",
      targetPlatform: "universal",
      updated: false,
      private: true,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false
    }
  });
  atomicWriteJson(registryPath, registry);

  const obsoletePath = resolve(extensionsDirectory, ".obsolete");
  const obsolete = readJsonObject(obsoletePath);
  for (const key of Object.keys(obsolete)) {
    if (key === `${EXTENSION_ID}-${EXTENSION_VERSION}` || key === EXTENSION_DIRECTORY_NAME) {
      delete obsolete[key];
    }
  }
  atomicWriteJson(obsoletePath, obsolete);
  return targetDirectory;
}

function readJsonArray(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
  } catch {
    return [];
  }
}

function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.threadex-tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), "utf8");
  renameSync(temporaryPath, path);
}

function readPidFile(path) {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid, system, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (system.getProcess(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return true;
}

function signalOwnedProcessGroup(system, pid, signal) {
  if (typeof system.signalProcessGroup === "function") {
    system.signalProcessGroup(pid, signal);
    return;
  }
  system.signal(pid, signal);
}

async function waitForPortRelease(port, system, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (system.getListeningProcessId(port)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return true;
}

const localProcessSystem = {
  getListeningProcessId(port) {
    try {
      const output = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const pid = Number(output.trim().split(/\s+/)[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  },
  getProcess(pid) {
    try {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const match = output.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    } catch {
      return null;
    }
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  },
  signalProcessGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EINVAL") {
        this.signal(pid, signal);
        return;
      }
      throw error;
    }
  }
};
