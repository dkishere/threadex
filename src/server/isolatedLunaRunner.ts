import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { readAccountAuthIdentity, type AccountAuthIdentity } from "./accountAuth";
import {
  agentCliExecutable,
  createEphemeralAgentHome,
  type AgentCliReasoningEffort
} from "./agentCli";

type JsonRpcRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ActiveTurn = {
  threadId: string;
  responseText: string;
  usage: Record<string, unknown> | null;
  resolve: (result: IsolatedLunaRunnerResult) => void;
  reject: (error: Error) => void;
};

export type IsolatedLunaRunnerResult = {
  responseText: string;
  usage: Record<string, unknown> | null;
  authIdentity: Required<AccountAuthIdentity>;
};

export type IsolatedLunaRunnerOptions = {
  name: string;
  model: string;
  reasoningEffort: AgentCliReasoningEffort | "minimal";
  /** Omit for jobs that must be allowed to finish without a wall-clock limit. */
  timeoutMs?: number;
  sourceHomeCandidates: Array<string | null | undefined>;
  baseInstructions: string;
  developerInstructions?: string | null;
  appServerConfigArgs?: string[];
  threadConfig?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  allowMissingAuth?: boolean;
  /** Explicitly expose this project directory to an otherwise isolated read-only job. */
  workspaceCwd?: string | null;
  allowWorkspaceRead?: boolean;
  freshThreadPerRun?: boolean;
  maxRunsPerProcess?: number;
  maxProcessAgeMs?: number;
};

export type IsolatedLunaRunOptions = {
  model?: string;
  reasoningEffort?: AgentCliReasoningEffort | "minimal";
};

/**
 * A small reusable app-server for isolated non-interactive tasks. It gets a fresh
 * temp workspace and an auth-only Codex home, so no user config, skills, MCPs,
 * apps, dynamic tools, or workspace files are exposed to the model unless the
 * caller explicitly supplies a thread config. Stateless callers can request a
 * fresh ephemeral thread for every run and periodically recycle the whole process,
 * which also deletes its temporary Codex home and workspace.
 *
 * The historical class name is retained because summarizer callers already use
 * it, but the model can be overridden per turn.
 */
export class IsolatedLunaRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private agentHome: ReturnType<typeof createEphemeralAgentHome> | null = null;
  private workspace: string | null = null;
  private ephemeralWorkspace: string | null = null;
  private startPromise: Promise<void> | null = null;
  private threadId: string | null = null;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, JsonRpcRequest>();
  private activeTurn: ActiveTurn | null = null;
  private runsInProcess = 0;
  private processStartedAt = 0;
  private recycleTimer: NodeJS.Timeout | null = null;
  private recycleAfterTurn = false;
  private runInProgress = false;
  private stopped = false;

  constructor(private readonly options: IsolatedLunaRunnerOptions) {}

  async run(input: string, options: IsolatedLunaRunOptions = {}) {
    if (this.runInProgress) {
      throw new Error(`${this.options.name} app-server received overlapping turns.`);
    }
    this.runInProgress = true;
    try {
      return await this.runExclusive(input, options);
    } finally {
      this.runInProgress = false;
    }
  }

  private async runExclusive(input: string, options: IsolatedLunaRunOptions) {
    if (this.shouldRecycleProcess()) {
      this.disposeProcess();
    }
    await this.start();
    if (this.activeTurn) {
      throw new Error(`${this.options.name} app-server received overlapping turns.`);
    }

    const model = options.model ?? this.options.model;
    const threadId = this.options.freshThreadPerRun || !this.threadId
      ? await this.startThread(model)
      : this.threadId;
    this.threadId = threadId;

    const completion = new Promise<IsolatedLunaRunnerResult>((resolveTurn, rejectTurn) => {
      this.activeTurn = { threadId, responseText: "", usage: null, resolve: resolveTurn, reject: rejectTurn };
    });
    let turnStarted = false;

    try {
      await this.rpc("turn/start", {
        threadId,
        input: [{ type: "text", text: input }],
        model,
        effort: options.reasoningEffort ?? this.options.reasoningEffort,
        summary: "none",
        environments: [],
        ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        approvalPolicy: "never"
      });
      turnStarted = true;
      return await withTimeout(completion, this.options.timeoutMs, `${this.options.name} turn timed out.`);
    } finally {
      this.activeTurn = null;
      if (this.options.freshThreadPerRun && this.threadId === threadId) {
        this.threadId = null;
      }
      if (turnStarted) {
        this.runsInProcess += 1;
      }
      if (this.recycleAfterTurn || this.shouldRecycleProcess()) {
        this.disposeProcess();
      }
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error(`${this.options.name} app-server stopped.`);
    this.rejectAll(error);
    this.activeTurn?.reject(error);
    this.activeTurn = null;
    this.disposeProcess();
  }

  private start() {
    if (this.stopped) {
      return Promise.reject(new Error(`${this.options.name} app-server is stopped.`));
    }
    if (!this.startPromise) {
      this.startPromise = this.startAppServer();
    }
    return this.startPromise;
  }

  private async startAppServer() {
    this.agentHome = createEphemeralAgentHome({
      prefix: `${safeTempPrefix(this.options.name)}-home-`,
      sourceHomeCandidates: this.options.sourceHomeCandidates,
      allowMissingAuth: this.options.allowMissingAuth ?? Boolean(process.env.OPENAI_API_KEY?.trim()),
      copyConfig: false
    });
    this.ephemeralWorkspace = mkdtempSync(resolve(tmpdir(), `${safeTempPrefix(this.options.name)}-workspace-`));
    this.workspace = this.options.allowWorkspaceRead === true
      ? resolveReadableWorkspace(this.options.workspaceCwd) ?? this.ephemeralWorkspace
      : this.ephemeralWorkspace;
    const child = spawn(
      agentCliExecutable(),
      buildIsolatedLunaAppServerArgs(this.options.appServerConfigArgs, this.options.allowWorkspaceRead === true),
      {
        cwd: this.workspace,
        env: {
          ...process.env,
          HOME: this.agentHome.home,
          AGENT_CLI_HOME: this.agentHome.home,
          CODEX_HOME: this.agentHome.home,
          CODEX_WORKDIR: this.workspace,
          THREADEX_MANAGED_RUNNER: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.buffer += String(chunk);
      this.drainBuffer();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4_000);
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on("exit", (code, signal) => {
      if (!this.stopped && this.child === child) {
        this.fail(new Error(
          `${this.options.name} app-server exited (${signal ?? code ?? "unknown"}).${this.stderr ? ` ${this.stderr.trim()}` : ""}`
        ));
      }
    });

    await this.rpc("initialize", {
      clientInfo: { name: "threadex-isolated", title: "Threadex Isolated Agent", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
    this.processStartedAt = Date.now();
    this.scheduleProcessRecycle();
  }

  private async startThread(model: string) {
    const response = readObject(await this.rpc("thread/start", {
      cwd: this.workspace,
      model,
      baseInstructions: this.options.baseInstructions,
      developerInstructions: this.options.developerInstructions ?? null,
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      runtimeWorkspaceRoots: this.options.allowWorkspaceRead && this.workspace ? [this.workspace] : [],
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      personality: "none",
      config: {
        features: { memories: false },
        apps: { _default: { enabled: false, open_world_enabled: false, destructive_enabled: false } },
        tools: { web_search: false },
        ...(this.options.threadConfig ?? {})
      }
    }));
    const threadId = readString(readObject(response?.thread)?.id);
    if (!threadId) {
      throw new Error(`${this.options.name} app-server returned no thread id.`);
    }
    return threadId;
  }

  private rpc(method: string, params: unknown = {}) {
    if (!this.child) {
      return Promise.reject(new Error(`${this.options.name} app-server is not started.`));
    }
    const id = this.nextId++;
    const request = new Promise<unknown>((resolveRpc, rejectRpc) => {
      this.pending.set(id, { resolve: resolveRpc, reject: rejectRpc });
      this.send({ id, method, params });
    });
    return withTimeout(request, this.options.timeoutMs, `${this.options.name} app-server ${method} timed out.`);
  }

  private notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  private send(payload: unknown) {
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private drainBuffer() {
    let lineEnd = this.buffer.indexOf("\n");
    while (lineEnd !== -1) {
      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line) this.handleLine(line);
      lineEnd = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && this.pending.has(id)) {
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (!request) return;
      const error = readObject(message.error);
      if (error) request.reject(new Error(readString(error.message) ?? JSON.stringify(error)));
      else request.resolve(message.result);
      return;
    }
    if (id !== null && typeof message.method === "string") {
      this.send({ id, error: { code: -32601, message: "Tools are disabled for isolated Luna runners." } });
      return;
    }
    if (typeof message.method !== "string" || !this.activeTurn) return;
    const params = readObject(message.params);
    const notificationThreadId = readString(params?.threadId) ?? readString(readObject(params?.thread)?.id);
    if (notificationThreadId && notificationThreadId !== this.activeTurn.threadId) return;

    if (message.method === "item/completed") {
      const item = readObject(params?.item);
      const itemType = readString(item?.type) ?? readString(item?.itemType);
      if (itemType === "agentMessage" || itemType === "agent_message") {
        this.activeTurn.responseText = readString(item?.text) ?? readString(item?.content) ?? this.activeTurn.responseText;
      }
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      this.activeTurn.usage = readObject(params?.tokenUsage) ?? this.activeTurn.usage;
      return;
    }
    if (message.method === "turn/completed") {
      const turn = readObject(params?.turn);
      const turnError = readObject(turn?.error);
      if (readString(turn?.status) === "failed" || turnError) {
        this.activeTurn.reject(new Error(readString(turnError?.message) ?? `${this.options.name} turn failed.`));
        return;
      }
      const responseText = this.activeTurn.responseText || finalAgentMessageFromTurn(turn);
      if (!responseText) {
        this.activeTurn.reject(new Error(`${this.options.name} turn produced no output.`));
        return;
      }
      this.activeTurn.resolve({
        responseText,
        usage: readObject(params?.usage) ?? readObject(turn?.usage) ?? this.activeTurn.usage,
        authIdentity: this.currentAuthIdentity()
      });
    }
  }

  private fail(error: Error) {
    this.rejectAll(error);
    this.activeTurn?.reject(error);
  }

  private rejectAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private currentAuthIdentity(): Required<AccountAuthIdentity> {
    const authPath = this.agentHome ? resolve(this.agentHome.home, "auth.json") : null;
    if (!authPath || !existsSync(authPath)) {
      return { externalAccountId: null, externalUserId: null };
    }
    try {
      return readAccountAuthIdentity(readFileSync(authPath, "utf8"));
    } catch {
      return { externalAccountId: null, externalUserId: null };
    }
  }

  private shouldRecycleProcess() {
    if (!this.child) {
      return false;
    }
    const maxRuns = positiveInteger(this.options.maxRunsPerProcess);
    if (maxRuns !== null && this.runsInProcess >= maxRuns) {
      return true;
    }
    const maxAgeMs = positiveInteger(this.options.maxProcessAgeMs);
    return maxAgeMs !== null && this.processStartedAt > 0 && Date.now() - this.processStartedAt >= maxAgeMs;
  }

  private scheduleProcessRecycle() {
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    const maxAgeMs = positiveInteger(this.options.maxProcessAgeMs);
    if (maxAgeMs === null) {
      return;
    }
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null;
      if (this.runInProgress || this.activeTurn || this.pending.size > 0) {
        this.recycleAfterTurn = true;
        return;
      }
      this.disposeProcess();
    }, maxAgeMs);
    this.recycleTimer.unref();
  }

  private disposeProcess() {
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = null;
    }
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    child?.kill("SIGTERM");
    try {
      this.agentHome?.cleanup();
    } catch {
      // Cleanup is best effort.
    }
    if (this.ephemeralWorkspace) {
      try {
        rmSync(this.ephemeralWorkspace, { recursive: true, force: true });
      } catch {
        // Cleanup is best effort.
      }
    }
    this.agentHome = null;
    this.workspace = null;
    this.ephemeralWorkspace = null;
    this.startPromise = null;
    this.threadId = null;
    this.buffer = "";
    this.stderr = "";
    this.runsInProcess = 0;
    this.processStartedAt = 0;
    this.recycleAfterTurn = false;
  }
}

export function buildIsolatedLunaAppServerArgs(configArgs: string[] = [], allowWorkspaceRead = false) {
  return [
    "app-server",
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="read-only"',
    "-c", "features.memories=false",
    ...(allowWorkspaceRead ? [] : ["-c", "features.shell_tool=false", "-c", "features.unified_exec=false"]),
    "-c", "features.apps=false",
    "-c", "features.multi_agent=false",
    "-c", "tools.web_search=false",
    "-c", "tools.view_image=false",
    ...configArgs
  ];
}

function safeTempPrefix(name: string) {
  return `session-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "luna"}`;
}

function resolveReadableWorkspace(value: string | null | undefined) {
  const cwd = value?.trim();
  if (!cwd || !isAbsolute(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? resolve(cwd) : null;
  } catch {
    return null;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function positiveInteger(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function finalAgentMessageFromTurn(turn: Record<string, unknown> | null) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = readObject(items[index]);
    const itemType = readString(item?.type) ?? readString(item?.itemType);
    if (itemType !== "agentMessage" && itemType !== "agent_message") continue;
    const text = readString(item?.text) ?? readString(item?.content);
    if (text) return text;
  }
  return "";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string) {
  if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | null = null;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}
