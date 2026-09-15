import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const commandTimeoutMs = 2_000;
const maxOutputChars = 8_000;

type CommandResult = {
  ok: boolean;
  output: string;
};

type GitRepositoryResult =
  | { kind: "repository"; root: string; status: CommandResult }
  | { kind: "not-repository" }
  | { kind: "unavailable"; message: string };

/**
 * Capture the small set of repository facts an agent normally checks before
 * starting work. This deliberately uses execFileSync with an argument array so
 * the workspace path is never interpreted by a shell.
 */
export function buildStartupSnapshot(cwd: string, capturedAt = new Date()) {
  const workingDirectory = resolve(cwd);
  const pwd = runCommand("pwd", [], workingDirectory);
  const gitRepository = detectGitRepository(workingDirectory);

  return [
    "[STARTUP]",
    `at: ${capturedAt.toISOString()}`,
    "Initial cwd and Git repository snapshot.",
    `pwd: ${displayResult(pwd)}`,
    displayGitRepository(gitRepository),
    "[END STARTUP]"
  ].join("\n");
}

function detectGitRepository(cwd: string): GitRepositoryResult {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: commandTimeoutMs,
      maxBuffer: maxOutputChars * 2,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return {
      kind: "repository",
      root: limitOutput(root) || cwd,
      status: runCommand("git", ["status", "--short"], cwd)
    };
  } catch (error) {
    if (isGitNotRepositoryError(error)) {
      return { kind: "not-repository" };
    }
    const message = error instanceof Error ? error.message.split("\n", 1)[0] : "command failed";
    return { kind: "unavailable", message: limitOutput(message) };
  }
}

function isGitNotRepositoryError(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 128;
}

function displayGitRepository(result: GitRepositoryResult) {
  switch (result.kind) {
    case "repository":
      return [
        `git: repository (${result.root})`,
        result.status.ok
          ? result.status.output
            ? `git status:\n${result.status.output}`
            : "git status: clean"
          : `git status: ${result.status.output}`
      ].join("\n");
    case "not-repository":
      return "git: not a Git repository";
    case "unavailable":
      return `git: unavailable (${result.message})`;
  }
}

function runCommand(command: string, args: string[], cwd: string): CommandResult {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: commandTimeoutMs,
      maxBuffer: maxOutputChars * 2,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return { ok: true, output: limitOutput(output) };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n", 1)[0] : "command failed";
    return { ok: false, output: `[unavailable: ${message}]` };
  }
}

function displayResult(result: CommandResult, emptyValue = "(no output)") {
  if (!result.ok) {
    return result.output;
  }
  return result.output || emptyValue;
}

function limitOutput(output: string) {
  if (output.length <= maxOutputChars) {
    return output;
  }
  return `${output.slice(0, maxOutputChars)}\n[output truncated by server]`;
}
