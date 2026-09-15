import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type {
  CreateProcessMonitorInput,
  ProcessMonitorRecord,
  ProcessMonitorStatus,
  SessionStore,
  UpdateProcessMonitorInput,
  WorkspaceRecord
} from "./sessionStore";

export type MonitorProcessInput = {
  label: string;
  command?: string | null;
  exe?: string | null;
  dockerImage?: string | null;
  /** Alias accepted for callers that use the shorter Docker terminology. */
  image?: string | null;
  dockerRunArgs?: string[];
  args?: string[];
  /** Optional workspace-relative file receiving combined stdout/stderr. */
  logFile?: string | null;
  entryPoints?: string[] | null;
  /** Legacy single-value input retained for API compatibility. */
  entryPoint?: string | null;
  pid?: number | null;
  cwd?: string | null;
  wakePrompt?: string | null;
  wakeSessionId?: string | null;
  wakeThreadId?: string | null;
  timeoutSeconds?: number | null;
};

export type AdoptProcessMonitorInput = Omit<MonitorProcessInput, "label" | "wakePrompt" | "wakeSessionId" | "wakeThreadId" | "timeoutSeconds"> & {
  label?: string | null;
  pid: number;
};

export type ProcessMonitorWake = {
  monitor: ProcessMonitorRecord;
  prompt: string;
  sessionId: string;
  threadId: string | null;
};

type ProcessMonitorOptions = {
  /** Durable event hook invoked for every completed process, even without a legacy wake prompt. */
  onExit?: (monitor: ProcessMonitorRecord) => Promise<void>;
  onWake?: (wake: ProcessMonitorWake) => Promise<void>;
  /** When configured, managed process stdout and stderr are captured here. */
  logDir?: string;
};

export type ProcessMonitorLog = {
  monitorId: string;
  content: string;
  size: number;
  truncated: boolean;
  updatedAt: string | null;
};

const monitorPollMs = Number(process.env.PROCESS_MONITOR_POLL_MS ?? 2_000);

export class ProcessMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private children = new Map<string, ChildProcess>();

  constructor(
    private readonly store: SessionStore,
    private readonly options: ProcessMonitorOptions = {}
  ) {}

  async start() {
    await this.syncAll();
    if (monitorPollMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        void this.syncAll().catch((error) => {
          console.warn(`Process monitor sweep failed: ${errorMessage(error)}`);
        });
      }, monitorPollMs);
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async list(workspaceId?: string | null) {
    const records = await this.store.listProcessMonitors(workspaceId);
    const synced = await Promise.all(records.map((record) => this.syncRecord(record)));
    return synced.filter((record): record is ProcessMonitorRecord => Boolean(record));
  }

  async monitor(workspace: WorkspaceRecord, input: MonitorProcessInput) {
    const label = normalizeLabel(input.label);
    const command = normalizeCommand(input.command);
    const executable = normalizeExecutable(input.exe);
    if (input.dockerImage !== undefined && input.image !== undefined && input.dockerImage !== input.image) {
      throw new Error("Provide only one Docker image reference.");
    }
    const dockerImage = normalizeDockerImage(input.dockerImage ?? input.image);
    const dockerRunArgs = normalizeArgs(input.dockerRunArgs);
    const args = normalizeArgs(input.args);
    const logFile = normalizeLogFile(workspace, input.logFile);
    const entryPoints = normalizeEntryPoints(input.entryPoints, input.entryPoint);
    const pid = normalizePid(input.pid);
    const wakePrompt = normalizeWakePrompt(input.wakePrompt);
    const wakeSessionId = normalizeOptionalString(input.wakeSessionId);
    const wakeThreadId = normalizeOptionalString(input.wakeThreadId);
    const timeoutSeconds = normalizeTimeoutSeconds(input.timeoutSeconds);
    if (wakePrompt && !wakeSessionId) {
      throw new Error("wakePrompt requires a sessionId.");
    }
    const monitorOptions = {
      wakePrompt,
      wakeSessionId,
      wakeThreadId,
      timeoutAt: timeoutSeconds === null ? null : new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
      wakeStatus: wakePrompt ? "pending" as const : "none" as const
    };
    if (!label) throw new Error("label is required.");
    const launchCount = Number(Boolean(command)) + Number(Boolean(executable)) + Number(Boolean(dockerImage));
    if ((pid === null && launchCount !== 1) || launchCount > 1) {
      throw new Error("Provide a pid optionally paired with exactly one launch spec, or exactly one of command, exe, or dockerImage.");
    }
    if (executable === null && dockerImage === null && input.args?.length) throw new Error("args requires exe or dockerImage.");
    if (dockerImage === null && dockerRunArgs.length > 0) throw new Error("dockerRunArgs requires dockerImage.");
    validateExecutableArgs(executable, args);
    const cwd = normalizeCwd(workspace, input.cwd);
    if (pid !== null) {
      if (!isProcessAlive(pid)) throw new Error(`Process ${pid} is not running.`);
      return this.store.createProcessMonitor({
        workspaceId: workspace.id,
        label,
        command,
        executable,
        dockerImage,
        dockerRunArgs,
        args,
        logFile,
        entryPoints,
        cwd,
        pid,
        status: "running",
        managed: launchCount > 0,
        // An attached PID is never owned by this monitor until it is restarted.
        // Keep it after exit when it has a launch spec so the user can restart it.
        removeOnExit: launchCount === 0,
        ...monitorOptions,
        startedAt: new Date().toISOString()
      });
    }

    const record = await this.store.createProcessMonitor({
      workspaceId: workspace.id,
      label,
      command,
      executable,
      dockerImage,
      dockerRunArgs,
      args,
      logFile,
      entryPoints,
      cwd,
      status: "starting",
      managed: true,
      removeOnExit: false,
      ...monitorOptions
    });
    try {
      await this.startProcess(record);
      return (await this.store.getProcessMonitor(record.id)) ?? record;
    } catch (error) {
      await this.store.updateProcessMonitor({ id: record.id, status: "error", error: errorMessage(error) });
      throw error;
    }
  }

  async restart(workspace: WorkspaceRecord, id: string) {
    const record = await this.requireWorkspaceRecord(workspace.id, id);
    if (!hasLaunchSpec(record)) {
      throw new Error("This monitor tracks an existing PID and has no managed launch to restart.");
    }
    validateExecutableArgs(record.executable, record.args);
    await this.terminate(record);
    await this.startProcess(record);
    return (await this.store.getProcessMonitor(record.id)) ?? record;
  }

  async adopt(workspace: WorkspaceRecord, id: string, input: AdoptProcessMonitorInput) {
    const record = await this.requireWorkspaceRecord(workspace.id, id);
    const label = input.label === undefined ? record.label : normalizeLabel(input.label);
    const command = normalizeCommand(input.command);
    const executable = normalizeExecutable(input.exe);
    if (input.dockerImage !== undefined && input.image !== undefined && input.dockerImage !== input.image) {
      throw new Error("Provide only one Docker image reference.");
    }
    const dockerImage = normalizeDockerImage(input.dockerImage ?? input.image);
    const dockerRunArgs = normalizeArgs(input.dockerRunArgs);
    const args = normalizeArgs(input.args);
    const pid = normalizePid(input.pid);
    if (!label) throw new Error("label is required.");
    if (pid === null || !isProcessAlive(pid)) throw new Error(`Process ${pid ?? input.pid} is not running.`);
    const launchCount = Number(Boolean(command)) + Number(Boolean(executable)) + Number(Boolean(dockerImage));
    if (launchCount !== 1) {
      throw new Error("Provide exactly one restart launch spec: command, exe with args, or dockerImage.");
    }
    if (executable === null && dockerImage === null && input.args?.length) throw new Error("args requires exe or dockerImage.");
    if (dockerImage === null && dockerRunArgs.length > 0) throw new Error("dockerRunArgs requires dockerImage.");
    validateExecutableArgs(executable, args);
    const entryPoints = input.entryPoints === undefined && input.entryPoint === undefined
      ? record.entryPoints
      : normalizeEntryPoints(input.entryPoints, input.entryPoint);
    const logFile = input.logFile === undefined ? record.logFile : normalizeLogFile(workspace, input.logFile);
    const cwd = normalizeCwd(workspace, input.cwd ?? record.cwd);
    this.children.delete(record.id);
    return (await this.store.updateProcessMonitor({
      id: record.id,
      label,
      command,
      executable,
      dockerImage,
      dockerRunArgs,
      args,
      logFile,
      entryPoints,
      cwd,
      pid,
      status: "running",
      managed: true,
      removeOnExit: false,
      startedAt: new Date().toISOString(),
      lastExitCode: null,
      lastSignal: null,
      error: null
    })) ?? record;
  }

  async remove(workspaceId: string, id: string) {
    const record = await this.requireWorkspaceRecord(workspaceId, id);
    await this.terminate(record);
    await this.store.deleteProcessMonitor(id);
    if (this.options.logDir && !record.logFile) {
      rmSync(this.internalLogPath(id), { force: true });
    }
  }

  async stopProcess(workspaceId: string, id: string) {
    const record = await this.requireWorkspaceRecord(workspaceId, id);
    const stopped = await this.terminate(record);
    return (await this.store.getProcessMonitor(id)) ?? stopped;
  }

  async readLog(workspaceId: string, id: string, tailBytes = 256 * 1024): Promise<ProcessMonitorLog> {
    const record = await this.store.getProcessMonitor(id);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error("Process monitor not found.");
    }
    const requestedBytes = Number.isFinite(tailBytes) ? Math.floor(tailBytes) : 256 * 1024;
    const boundedBytes = Math.max(1, Math.min(requestedBytes, 1024 * 1024));
    if (!this.options.logDir && !record.logFile) {
      return { monitorId: id, content: "", size: 0, truncated: false, updatedAt: null };
    }
    const path = this.logPath(record);
    if (!existsSync(path)) {
      return { monitorId: id, content: "", size: 0, truncated: false, updatedAt: null };
    }
    const stats = statSync(path);
    const length = Math.min(stats.size, boundedBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, Math.max(0, stats.size - length));
    } finally {
      closeSync(fd);
    }
    return {
      monitorId: id,
      content: buffer.toString("utf8"),
      size: stats.size,
      truncated: stats.size > length,
      updatedAt: stats.mtime.toISOString()
    };
  }

  private async syncAll() {
    const records = await this.store.listProcessMonitors();
    for (const record of records) {
      await this.syncRecord(record);
    }
  }

  private async syncRecord(record: ProcessMonitorRecord): Promise<ProcessMonitorRecord | null> {
    if (record.status !== "running" && record.status !== "starting") {
      return record;
    }
    if (record.pid === null) {
      if (record.status !== "starting") return record;
      return (await this.store.updateProcessMonitor({
        id: record.id,
        status: "error",
        error: record.error ?? "Process launch did not produce a process id."
      })) ?? record;
    }
    if (record.timeoutAt && Number.isFinite(Date.parse(record.timeoutAt)) && Date.parse(record.timeoutAt) <= Date.now()) {
      return this.expire(record);
    }
    if (isProcessAlive(record.pid)) {
      if (record.status === "starting") {
        return (await this.store.updateProcessMonitor({
          id: record.id,
          status: "running",
          startedAt: record.startedAt ?? new Date().toISOString(),
          error: null
        })) ?? record;
      }
      return record;
    }
    return this.complete(record, null, null);
  }

  private async startProcess(record: ProcessMonitorRecord) {
    const logFd = this.openLog(record);
    const spawnOptions: SpawnOptions = {
      cwd: record.cwd,
      detached: true,
      env: process.env,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd]
    };
    let child: ChildProcess;
    try {
      child = record.dockerImage
        ? spawn("docker", ["run", "--rm", ...record.dockerRunArgs, record.dockerImage, ...record.args], spawnOptions)
        : record.executable
        ? spawn(record.executable, record.args, spawnOptions)
        : spawn(record.command ?? "", {
          ...spawnOptions,
          shell: true
        });
    } finally {
      if (logFd !== null) closeSync(logFd);
    }
    const spawnError = await initialSpawnError(child);
    if (spawnError) {
      throw spawnError;
    }
    const pid = child.pid;
    if (!pid) {
      throw new Error("The monitored command did not produce a process id.");
    }
    this.children.set(record.id, child);
    await this.store.updateProcessMonitor({
      id: record.id,
      pid,
      status: "running",
      managed: true,
      startedAt: new Date().toISOString(),
      lastExitCode: null,
      lastSignal: null,
      error: null
    });
    child.once("error", (error) => {
      void this.markChildFailed(record.id, pid, errorMessage(error));
    });
    child.once("exit", (code, signal) => {
      void this.markChildExited(record.id, pid, code, signal);
    });
    child.unref();
  }

  private async markChildFailed(id: string, pid: number, error: string) {
    const current = await this.store.getProcessMonitor(id);
    if (current?.pid !== pid) return;
    await this.store.updateProcessMonitor({ id, status: "error", pid: null, error });
    this.children.delete(id);
  }

  private async markChildExited(id: string, pid: number, code: number | null, signal: NodeJS.Signals | null) {
    const current = await this.store.getProcessMonitor(id);
    if (current?.pid !== pid) return;
    await this.complete(current, code, signal);
    this.children.delete(id);
  }

  private async complete(record: ProcessMonitorRecord, code: number | null, signal: NodeJS.Signals | null) {
    let updated = (await this.store.updateProcessMonitor({
      id: record.id,
      status: "exited",
      pid: null,
      lastExitCode: code,
      lastSignal: signal,
      error: null
    })) ?? record;
    if (this.options.onExit) {
      if (updated.wakePrompt && updated.wakeSessionId && updated.wakeStatus === "pending") {
        updated = (await this.store.updateProcessMonitor({
          id: updated.id,
          wakeStatus: "sent",
          wakeError: null
        })) ?? updated;
      }
      try {
        await this.options.onExit(updated);
        if (updated.wakePrompt && updated.wakeSessionId) {
          updated = (await this.store.updateProcessMonitor({
            id: updated.id,
            wakeStatus: "done",
            wokenAt: new Date().toISOString(),
            wakeError: null
          })) ?? updated;
        }
      } catch (error) {
        if (updated.wakePrompt && updated.wakeSessionId) {
          updated = (await this.store.updateProcessMonitor({
            id: updated.id,
            wakeStatus: "error",
            wakeError: errorMessage(error)
          })) ?? updated;
        } else {
          console.warn(`Failed to publish process exit ${updated.id}: ${errorMessage(error)}`);
        }
      }
      if (updated.removeOnExit) {
        await this.store.deleteProcessMonitor(updated.id);
        return null;
      }
      return updated;
    }
    if (updated.wakePrompt && updated.wakeSessionId && updated.wakeStatus === "pending") {
      const sent = (await this.store.updateProcessMonitor({
        id: updated.id,
        wakeStatus: "sent",
        wakeError: null
      })) ?? updated;
      void this.dispatchWake(sent);
      return sent;
    }
    if (updated.removeOnExit) {
      await this.store.deleteProcessMonitor(updated.id);
      return null;
    }
    return updated;
  }

  private async dispatchWake(record: ProcessMonitorRecord) {
    if (!record.wakePrompt || !record.wakeSessionId) return;
    try {
      if (!this.options.onWake) throw new Error("Process monitor wake-up is not configured.");
      await this.options.onWake({
        monitor: record,
        prompt: record.wakePrompt,
        sessionId: record.wakeSessionId,
        threadId: record.wakeThreadId
      });
      await this.store.updateProcessMonitor({
        id: record.id,
        wakeStatus: "done",
        wokenAt: new Date().toISOString(),
        wakeError: null
      });
    } catch (error) {
      await this.store.updateProcessMonitor({
        id: record.id,
        wakeStatus: "error",
        wakeError: errorMessage(error)
      });
    }
  }

  private async expire(record: ProcessMonitorRecord) {
    if (record.managed && record.pid !== null) {
      if (this.children.has(record.id)) {
        killProcessGroup(record.pid);
      } else {
        killProcess(record.pid);
      }
      this.children.delete(record.id);
    }
    const updated = (await this.store.updateProcessMonitor({
      id: record.id,
      status: "stopped",
      pid: null,
      error: "Process monitor timed out."
    })) ?? record;
    if (updated.removeOnExit) {
      await this.store.deleteProcessMonitor(updated.id);
      return null;
    }
    return updated;
  }

  private async terminate(record: ProcessMonitorRecord) {
    if (record.pid === null) return record;
    if (this.children.has(record.id)) {
      killProcessGroup(record.pid);
    } else {
      killProcess(record.pid);
    }
    this.children.delete(record.id);
    return (await this.store.updateProcessMonitor({ id: record.id, status: "stopped", pid: null })) ?? record;
  }

  private async requireWorkspaceRecord(workspaceId: string, id: string) {
    const record = await this.store.getProcessMonitor(id);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error("Process monitor not found.");
    }
    const current = await this.syncRecord(record);
    if (!current) throw new Error("Process monitor not found.");
    return current;
  }

  private openLog(record: ProcessMonitorRecord) {
    if (!this.options.logDir && !record.logFile) return null;
    const path = this.logPath(record);
    mkdirSync(resolve(path, ".."), { recursive: true });
    return openSync(path, "w");
  }

  private internalLogPath(id: string) {
    if (!this.options.logDir) throw new Error("Process monitor log directory is not configured.");
    return resolve(this.options.logDir!, `${encodeURIComponent(id)}.log`);
  }

  private logPath(record: ProcessMonitorRecord) {
    return record.logFile ?? this.internalLogPath(record.id);
  }
}

/**
 * Node reports a failed exec spawn asynchronously. Waiting through the next
 * turn lets us turn ENOENT into the monitor's normal error state, rather than
 * leaving an unhandled ChildProcess error event behind.
 */
function initialSpawnError(child: ChildProcess): Promise<Error | null> {
  return new Promise((resolve) => {
    let settled = false;
    const onError = (error: Error) => {
      settled = true;
      resolve(error);
    };
    child.once("error", onError);
    setImmediate(() => {
      if (settled) return;
      child.off("error", onError);
      resolve(null);
    });
  });
}

function normalizeLabel(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function normalizeCommand(value: unknown) {
  if (typeof value !== "string") return null;
  const command = value.trim();
  return command ? command.slice(0, 4_000) : null;
}

function normalizeExecutable(value: unknown) {
  if (typeof value !== "string") return null;
  const executable = value.trim();
  return executable ? executable.slice(0, 1000) : null;
}

function normalizeDockerImage(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("dockerImage must be a Docker image reference.");
  const image = value.trim();
  if (!image) return null;
  if (image.length > 500 || /[\s\u0000-\u001F\u007F]/.test(image) || image.startsWith("-")) {
    throw new Error("dockerImage must be a valid Docker image reference.");
  }
  return image;
}

function normalizeEntryPoints(value: unknown, legacyValue: unknown) {
  const source = value === undefined
    ? legacyValue === undefined || legacyValue === null || legacyValue === "" ? [] : [legacyValue]
    : value;
  if (source === null) return [];
  if (!Array.isArray(source) || source.length > 16) {
    throw new Error("entryPoints must be an array of at most 16 HTTP(S) URLs.");
  }
  const entryPoints = source.map((entryPoint) => {
    if (typeof entryPoint !== "string" || !entryPoint.trim()) {
      throw new Error("entryPoints must contain only HTTP(S) URLs.");
    }
    const trimmed = entryPoint.trim();
    if (trimmed.length > 2_000) {
      throw new Error("Each entryPoint must be at most 2000 characters.");
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      return parsed.toString();
    } catch {
      throw new Error("entryPoints must contain only HTTP(S) URLs.");
    }
  });
  return [...new Set(entryPoints)];
}

function normalizeArgs(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be an array of at most 64 strings.");
  }
  return value.map((arg) => arg.slice(0, 4000));
}

function validateExecutableArgs(executable: string | null, args: string[]) {
  if (!executable || args.length > 0) return;
  const interpreter = executable.match(/(?:^|[\\/])((?:node(?:js)?|(?:ba|da|z|fi)?sh|python(?:\d+(?:\.\d+)*)?|ruby|perl|deno|bun)(?:\.exe)?)$/i)?.[1];
  if (interpreter) {
    throw new Error(`args must include a script or interpreter options when exe is ${interpreter}; use pid only for a temporary, non-restartable attachment.`);
  }
}

function normalizeWakePrompt(value: unknown) {
  if (typeof value !== "string") return null;
  const prompt = value.trim();
  return prompt ? prompt.slice(0, 12_000) : null;
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

function normalizeTimeoutSeconds(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 24 * 60 * 60) {
    throw new Error("timeoutSeconds must be between 1 and 604800.");
  }
  return Math.floor(seconds);
}

function normalizePid(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const pid = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("pid must be a positive integer.");
  return pid;
}

function normalizeCwd(workspace: WorkspaceRecord, value: unknown) {
  const workspaceRoot = resolve(workspace.cwd);
  const cwd = resolve(workspaceRoot, typeof value === "string" && value.trim() ? value.trim() : workspaceRoot);
  if (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("cwd must stay inside the active workspace.");
  }
  return cwd;
}

function normalizeLogFile(workspace: WorkspaceRecord, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("logFile must be a file path inside the active workspace.");
  const workspaceRoot = resolve(workspace.cwd);
  const logFile = resolve(workspaceRoot, value.trim());
  if (logFile === workspaceRoot || !logFile.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("logFile must stay inside the active workspace.");
  }
  return logFile;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have already exited.
    }
  }
}

function killProcess(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may have already exited, or the current user may not signal it.
  }
}

function hasLaunchSpec(record: Pick<ProcessMonitorRecord, "command" | "executable" | "dockerImage">) {
  return Boolean(record.command || record.executable || record.dockerImage);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
