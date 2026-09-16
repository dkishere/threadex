import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

type CompactBaseline = { version: 1; cwd: string; files: Record<string, string | null> };

// Keep original content only for reviewable paths. Publish and verify the archive
// before removing Git objects; any failure leaves the original snapshot intact.
export function compactTurnGitBaseline(dataDir: string, turnId: string, cwd: string, requestedPaths: string[]) {
  const root = turnReviewRoot(dataDir, turnId);
  const gitDir = resolve(root, "git");
  if (!existsSync(resolve(root, "metadata.json")) || !existsSync(gitDir)) return;
  const metadata = JSON.parse(readFileSync(resolve(root, "metadata.json"), "utf8"));
  if (metadata.cwd !== cwd) return;
  const changed = execGit(gitDir, cwd, ["diff", "--name-only", "-z", "--no-renames"]).split("\0").filter(Boolean);
  const files: Record<string, string | null> = Object.create(null);
  let bytes = 0;
  for (const path of new Set([...requestedPaths, ...changed])) {
    const normalized = relative(cwd, resolve(cwd, path)).split(sep).join("/");
    if (!normalized || normalized === ".." || normalized.startsWith("../")) throw new Error("Baseline path outside workspace");
    const tracked = execGit(gitDir, cwd, ["ls-files", "--stage", "-z", "--", normalized]);
    if (tracked && !/^100(644|755) /.test(tracked)) throw new Error("Non-regular baseline retained");
    const before = tracked ? execGit(gitDir, cwd, ["show", `:${normalized}`]) : null;
    if (before?.includes("\0") || before?.includes("\uFFFD")) throw new Error("Non-text baseline retained");
    bytes += Buffer.byteLength(before ?? "", "utf8");
    if (bytes > 16 * 1024 * 1024) throw new Error("Large baseline retained");
    files[normalized] = before;
  }
  const archive: CompactBaseline = { version: 1, cwd, files };
  const serialized = JSON.stringify(archive);
  const destination = resolve(root, "baseline.json.gz");
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, gzipSync(serialized));
  if (gunzipSync(readFileSync(temporary)).toString("utf8") !== serialized) throw new Error("Baseline verification failed");
  renameSync(temporary, destination);
  rmSync(gitDir, { recursive: true, force: true });
}

export function readCompactTurnBaseline(dataDir: string, turnId: string, cwd: string, path: string) {
  const archivePath = resolve(turnReviewRoot(dataDir, turnId), "baseline.json.gz");
  if (!existsSync(archivePath)) return undefined;
  const archive = JSON.parse(gunzipSync(readFileSync(archivePath)).toString("utf8")) as CompactBaseline;
  const normalized = relative(cwd, resolve(cwd, path)).split(sep).join("/");
  if (archive.version !== 1 || archive.cwd !== cwd || !Object.hasOwn(archive.files, normalized)) return undefined;
  return archive.files[normalized];
}

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
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd, GIT_LITERAL_PATHSPECS: "1" },
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
