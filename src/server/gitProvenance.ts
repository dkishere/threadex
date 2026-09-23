import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { changedFilePaths } from "./changedFilePaths";
import { buildThreadexTurnReference, canonicalSessionId, parseCodexReference } from "../codexReference";

// Git adapter: resolve event paths into a worktree, persist pending associations,
// intersect them with the index, and publish/consume commit trailers. Event path
// extraction is shared with SessionStore; DB history does not depend on Git I/O.

export type GitProvenance = {
  version: 1;
  host: string;
  sessionId: string;
  turnId?: string;
  turnNumber?: number;
  files: string[];
  eventId?: string;
  url?: string;
  workspaceId?: string;
};
const trailer = "Threadex-author: ";
const trailerPrefixes = [trailer];
const isProvenanceTrailer = (line: string) => trailerPrefixes.some(prefix => line.startsWith(prefix));

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000,
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } });
}

function repository(cwd: string) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  // --git-path respects linked worktrees and keeps their pending edits separate.
  const pending = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "threadex/provenance"]).trim());
  return { root, pending };
}

export function recordGitProvenance(cwd: string, sessionId: string, turnId: string, paths: string[], eventId?: string, workspaceId = "default", turnNumber?: number) {
  if (!paths.length) return;
  let repo: ReturnType<typeof repository>;
  try { repo = repository(cwd); } catch { return; }
  const canonicalCwd = realpathSync(cwd);
  const files = [...new Set(paths.map(path => relative(repo.root, resolve(canonicalCwd, path)).split(sep).join("/")))]
    .filter(path => path && path !== ".." && !path.startsWith("../"));
  if (!files.length) return;
  const record: GitProvenance = { version: 1, host: hostname(), sessionId, turnId, workspaceId, files,
    ...(Number.isSafeInteger(turnNumber) && turnNumber! > 0 ? { turnNumber } : {}), ...(eventId ? { eventId } : {}) };
  mkdirSync(repo.pending, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify(eventId
    ? [record.host, sessionId, turnId, eventId] : [record.host, sessionId, turnId])).digest("hex");
  const destination = resolve(repo.pending, `${key}.json`);
  // Terminal runner events can be replayed; never resurrect consumed associations.
  if (existsSync(destination)) return;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, destination);
}

export function recordLiveGitProvenance(cwd: string, update: { id: string; sessionId: string; turnId: string; event: string; data?: unknown }, workspaceId = "default", turnNumber?: number) {
  if (update.event !== "item") return;
  recordGitProvenance(cwd, update.sessionId, update.turnId, changedFilePaths(update.data), update.id, workspaceId, turnNumber);
}

function validRecord(value: unknown): value is GitProvenance & { turnId: string } {
  if (!value || typeof value !== "object") return false;
  const r = value as GitProvenance;
  return r.version === 1 && [r.host, r.sessionId, r.turnId].every(v => typeof v === "string" && v.length > 0)
    && Array.isArray(r.files) && r.files.every(v => typeof v === "string")
    && (r.turnNumber === undefined || (Number.isSafeInteger(r.turnNumber) && r.turnNumber > 0));
}

export function parseGitProvenance(message: string): GitProvenance[] {
  return message.split("\n").flatMap<GitProvenance>(line => {
    const prefix = trailerPrefixes.find(prefix => line.startsWith(prefix));
    if (!prefix) return [];
    const linkedUrl = line.slice(prefix.length).trim();
    const reference = parseCodexReference(linkedUrl);
    if (!reference?.turnNumbers) return [];
    return reference.turnNumbers.map(turnNumber => ({ version: 1 as const, host: "threadex",
      sessionId: reference.target, turnNumber, workspaceId: reference.workspaceId, files: [], url: reference.uri }));
  });
}

export function prepareGitProvenance(cwd: string, messagePath: string) {
  const { root, pending } = repository(cwd);
  if (!existsSync(pending)) return;
  const staged = new Set(git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]).split("\0").filter(Boolean));
  if (!staged.size) return;
  const message = readFileSync(messagePath, "utf8");
  const entries = new Map(message.split("\n").filter(isProvenanceTrailer).map(line => [line, line]));
  const groups = new Map<string, { workspaceId: string; sessionId: string; turns: Set<number> }>();
  const addNumber = (record: GitProvenance) => {
    const workspaceId = record.workspaceId ?? "default";
    const sessionId = canonicalSessionId(record.sessionId);
    const key = JSON.stringify([workspaceId, sessionId]);
    const group = groups.get(key) ?? { workspaceId, sessionId, turns: new Set<number>() };
    group.turns.add(record.turnNumber!);
    groups.set(key, group);
  };
  for (const line of entries.keys()) {
    const records = parseGitProvenance(line);
    if (records.length && records.every(record => record.turnNumber !== undefined)) {
      records.forEach(addNumber);
      entries.delete(line);
    }
  }
  for (const name of readdirSync(pending).filter(name => name.endsWith(".json"))) {
    const record: unknown = JSON.parse(readFileSync(resolve(pending, name), "utf8"));
    if (!validRecord(record)) continue;
    const files = record.files.filter(path => staged.has(path));
    if (!files.length) continue;
    if (record.turnNumber !== undefined) {
      addNumber(record);
      continue;
    }

  }
  for (const group of [...groups.values()].sort((a, b) => JSON.stringify([a.workspaceId, a.sessionId]).localeCompare(JSON.stringify([b.workspaceId, b.sessionId])))) {
    const line = `${trailer}${buildThreadexTurnReference(group.workspaceId, group.sessionId, [...group.turns])}`;
    entries.set(line, line);
  }
  const original = message.split("\n").filter(line => !isProvenanceTrailer(line)).join("\n").trimEnd();
  if (entries.size) {
    // Git discards the scissors section (e.g. verbose commit templates).
    const scissors = original.search(/^# -+ >8 -+.*$/m);
    const before = scissors < 0 ? original : original.slice(0, scissors).trimEnd();
    const after = scissors < 0 ? "" : `\n${original.slice(scissors)}\n`;
    writeFileSync(messagePath, `${before}\n\n${[...entries.keys()].join("\n")}\n${after}`);
  }
}

export function finishGitProvenance(cwd: string) {
  const { root, pending } = repository(cwd);
  if (!existsSync(pending)) return;
  const committed = parseGitProvenance(git(root, ["log", "-1", "--format=%B"]));
  const committedPaths = new Set(git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", "HEAD"])
    .split("\0").filter(Boolean));
  // Keep partial commits pending until the working file matches the committed file.
  const remaining = new Set(git(root, ["diff", "HEAD", "--name-only", "--no-renames", "-z"]).split("\0"));
  for (const file of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) remaining.add(file);
  for (const name of readdirSync(pending).filter(name => name.endsWith(".json"))) {
    const path = resolve(pending, name);
    const record: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validRecord(record)) continue;
    const taskWasCommitted = committed.some(r => canonicalSessionId(r.sessionId) === canonicalSessionId(record.sessionId)
      && (r.workspaceId ?? "default") === (record.workspaceId ?? "default")
      && r.turnNumber !== undefined && r.turnNumber === record.turnNumber);
    const files = record.files.filter(file => !taskWasCommitted || !committedPaths.has(file) || remaining.has(file));
    // Empty records are retained as tombstones, preventing replay from deleting unrelated records.
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...record, files }));
    renameSync(temporary, path);
  }
}

export function inspectGitProvenance(cwd: string, commit: string, file?: string) {
  const { root } = repository(cwd);
  const oid = git(root, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).trim();
  const records = parseGitProvenance(git(root, ["show", "-s", "--format=%B", oid]));
  const path = file ? relative(root, resolve(realpathSync(cwd), file)).split(sep).join("/") : undefined;
  const committedPaths = path
    ? new Set(git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", oid]).split("\0"))
    : null;
  return { commit: oid, precision: "commit-files-to-task-links", records: committedPaths && path
    ? committedPaths.has(path) ? records : [] : records };
}

export function installGitProvenanceHooks(cwd: string, cli: string, tsx: string) {
  repository(cwd);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const hooks = ["prepare-commit-msg", "post-commit"] as const;
  const targets = hooks.map(hook => ({ hook, path: resolve(cwd, git(cwd, ["rev-parse", "--git-path", `hooks/${hook}`]).trim()) }));
  for (const { path } of targets) {
    if (existsSync(path)) throw new Error(`Existing hook preserved: ${path}. Chain the Threadex CLI manually.`);
  }
  for (const { hook, path } of targets) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(tsx)} ${quote(cli)} ${hook} "$@"\n`, { mode: 0o755 });
  }
}
