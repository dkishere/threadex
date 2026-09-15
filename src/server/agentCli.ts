import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { modelTokenUsageFromCodexExecJson } from "./modelTokenUsage";

export type AgentCliProvider = "codex";
export type AgentCliReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type AgentCliExecInput = {
  prompt: string;
  model: string;
  reasoningEffort?: AgentCliReasoningEffort;
  cwd: string;
  outputPath: string;
  timeoutMs: number;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  configOverrides?: string[];
  env?: NodeJS.ProcessEnv;
};

export function agentCliProvider(): AgentCliProvider {
  const provider = process.env.AGENT_CLI_PROVIDER?.trim() || "codex";
  if (provider === "codex") {
    return provider;
  }
  throw new Error(`Unsupported AGENT_CLI_PROVIDER: ${provider}`);
}

export function agentCliExecutable() {
  const bundledMacCodexPath = "/Applications/Codex.app/Contents/Resources/codex";
  return process.env.AGENT_CLI_PATH || process.env.CODEX_PATH || (existsSync(bundledMacCodexPath) ? bundledMacCodexPath : "codex");
}

export function createEphemeralAgentHome(input: {
  prefix: string;
  sourceHomeCandidates: Array<string | null | undefined>;
  allowMissingAuth?: boolean;
  copyConfig?: boolean;
}) {
  const home = mkdtempSync(resolve(tmpdir(), input.prefix));
  const sourceHome = resolveAgentHome(input.sourceHomeCandidates);
  if (!sourceHome && !input.allowMissingAuth) {
    rmSync(home, { recursive: true, force: true });
    throw new Error("Unable to find local agent CLI auth in the configured source homes; configure an agent home or log in locally.");
  }

  if (sourceHome) {
    for (const fileName of ["auth.json", ...(input.copyConfig === false ? [] : ["config.toml"])]) {
      const sourcePath = resolve(sourceHome, fileName);
      const targetPath = resolve(home, fileName);
      if (existsSync(sourcePath)) {
        copyFileSync(sourcePath, targetPath);
      }
    }
  }

  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

export function defaultAgentHomeCandidates() {
  return [
    process.env.AGENT_CLI_HOME,
    process.env.HOME ? resolve(process.env.HOME, ".codex") : null,
    resolve(homedir(), ".codex"),
    process.env.CODEX_HOME
  ];
}

export async function runAgentCliExec(input: AgentCliExecInput) {
  agentCliProvider();

  const result = await runProcess({
    args: buildCodexExecArgs(input),
    prompt: input.prompt,
    timeoutMs: input.timeoutMs,
    env: input.env
  });
  return { ...result, usage: modelTokenUsageFromCodexExecJson(result.stdout) };
}

export function trimAgentCliOutput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function resolveAgentHome(candidates: Array<string | null | undefined>) {
  const resolvedCandidates = candidates
    .flatMap((value) => {
      const trimmed = value?.trim();
      return trimmed ? [resolve(trimmed.replace(/^~(?=$|\/)/, homedir()))] : [];
    })
    .filter((value, index, all) => all.indexOf(value) === index);

  return resolvedCandidates.find((candidate) => existsSync(resolve(candidate, "auth.json"))) ?? null;
}

export function buildCodexExecArgs(input: AgentCliExecInput) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-m",
    input.model,
    ...(input.reasoningEffort
      ? ["-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]
      : []),
    "-s",
    input.sandbox ?? "read-only",
    "-C",
    input.cwd,
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "-c",
    "features.memories=false",
    ...(input.configOverrides ?? []).flatMap((override) => ["-c", override]),
    "--json",
    "--output-last-message",
    input.outputPath,
    "-"
  ];
}

async function runProcess(input: { args: string[]; prompt: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; stderr: string }>((resolveProcess, rejectProcess) => {
    const child = spawn(agentCliExecutable(), input.args, {
      env: input.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        rejectProcess(error);
      } else {
        resolveProcess({ stdout: stdout.join(""), stderr: stderr.join("") });
      }
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Agent CLI exec timed out."));
    }, input.timeoutMs);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr.push(String(chunk));
    });
    child.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const details = trimAgentCliOutput(stderr.join("") || stdout.join(""));
      finish(new Error(`Agent CLI exec failed (${signal ?? code ?? "unknown"}).${details ? ` ${details}` : ""}`));
    });
    child.stdin.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.stdin.end(input.prompt, "utf8");
  });
}
