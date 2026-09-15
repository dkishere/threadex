import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const DEFAULT_EXCLUDES = [
  ".git/", "node_modules/", "data/", "dist/", "build/", ".next/", "coverage/", "target/", ".venv/", "venv/"
];
const gitCommandTimeoutMs = 2_000;

export function captureTurnGitBaseline(dataDir: string, turnId: string, cwd: string) {
  const root = turnReviewRoot(dataDir, turnId);
  const gitDir = resolve(root, "git");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(gitDir, "info"), { recursive: true });
  execGit(gitDir, cwd, ["init", "--quiet"]);
  const configured = (process.env.WEB_VSCODE_REVIEW_EXCLUDES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const excludes = configured.length > 0
    ? configured
    : [...DEFAULT_EXCLUDES, ...nestedGitDirectoryExcludes(cwd)];
  writeFileSync(resolve(gitDir, "info", "exclude"), `${excludes.map((value) => `/${value.replace(/^\/+/, "")}`).join("\n")}\n`, "utf8");
  execGit(gitDir, cwd, ["add", "-A", "--", "."]);
  writeFileSync(resolve(root, "metadata.json"), JSON.stringify({ cwd }), "utf8");
}

export function buildTurnGitPatch(dataDir: string, turnId: string, cwd: string, requestedPaths: string[]) {
  const root = turnReviewRoot(dataDir, turnId);
  const gitDir = resolve(root, "git");
  const metadataPath = resolve(root, "metadata.json");
  if (!existsSync(gitDir) || !existsSync(metadataPath)) return null;
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { cwd?: unknown };
  if (metadata.cwd !== cwd) return null;
  const paths = [...new Set(requestedPaths.flatMap((path) => {
    const absolute = resolve(cwd, path);
    const normalized = relative(cwd, absolute);
    return normalized && normalized !== ".." && !normalized.startsWith(`..${sep}`) ? [normalized] : [];
  }))];
  if (paths.length === 0) return null;

  for (const path of paths) {
    const absolute = resolve(cwd, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    try {
      execGit(gitDir, cwd, ["ls-files", "--error-unmatch", "--", path]);
    } catch {
      execGit(gitDir, cwd, ["add", "--intent-to-add", "--", path]);
    }
  }
  return execGit(gitDir, cwd, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--", ...paths]);
}

function execGit(gitDir: string, cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd },
    encoding: "utf8",
    timeout: gitCommandTimeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function turnReviewRoot(dataDir: string, turnId: string) {
  const safeTurnId = turnId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "turn";
  return resolve(dataDir, "code-server", "turn-baselines", safeTurnId);
}

function nestedGitDirectoryExcludes(cwd: string) {
  try {
    return readdirSync(cwd, { withFileTypes: true }).flatMap((entry) => (
      entry.isDirectory() && existsSync(resolve(cwd, entry.name, ".git"))
        ? [`${entry.name}/`]
        : []
    ));
  } catch {
    return [];
  }
}
