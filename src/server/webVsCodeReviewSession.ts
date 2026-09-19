import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { buildTurnGitPatch, readCompactTurnBaseline } from "./turnGitPatch";
import { buildWebVsCodeReview } from "./webVsCodeReview";
import { resolveWorkspaceFilePath } from "./workspaceFiles";

const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

type ReviewCandidate = {
  path?: unknown;
  [key: string]: unknown;
};

type ReviewRequestFile = {
  path: string;
  patch: string;
  baselineText: string;
};

export function createWebVsCodeReviewSession(input: {
  dataDir: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  changes: unknown[];
  scope?: "turn" | "session";
  returnUrl?: string;
  allowExternalPaths?: boolean;
}) {
  const candidates = input.changes
    .filter((change): change is ReviewCandidate => Boolean(change && typeof change === "object"))
    .slice(0, 250);
  const workspacePath = resolveReviewWorkspacePath(input.cwd, candidates, input.allowExternalPaths === true);
  if (!workspacePath) return null;
  const candidatesByPath = new Map<string, ReviewCandidate[]>();
  const files: ReviewRequestFile[] = [];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const requestedPath = typeof candidate.path === "string" ? candidate.path.trim() : "";
    const absolutePath = requestedPath ? resolveWorkspaceFilePath(workspacePath, requestedPath) : null;
    if (!absolutePath) continue;
    const normalizedPath = relative(workspacePath, absolutePath).split(sep).join("/");
    if (!normalizedPath) continue;
    const groupedCandidates = candidatesByPath.get(normalizedPath) ?? [];
    groupedCandidates.push({ ...candidate, path: normalizedPath });
    candidatesByPath.set(normalizedPath, groupedCandidates);
  }

  for (const [normalizedPath, groupedCandidates] of candidatesByPath) {
    const absolutePath = resolveWorkspaceFilePath(workspacePath, normalizedPath);
    if (!absolutePath) continue;
    // Saved runner diffs are authoritative. Legacy snapshots are only a
    // fallback for historical records that did not store reviewable content.
    let patch = buildWebVsCodeReview(groupedCandidates, workspacePath);
    const hasSavedPatch = /^@@ /m.test(patch);
    const compactBefore = !hasSavedPatch && input.turnId && workspacePath === resolve(input.cwd)
      ? readCompactTurnBaseline(input.dataDir, input.turnId, workspacePath, normalizedPath)
      : undefined;
    if (compactBefore !== undefined) {
      const after = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
      if ((compactBefore ?? "") === after) continue;
      patch = buildWebVsCodeReview([{
        path: normalizedPath,
        kind: compactBefore === null ? "add" : existsSync(absolutePath) ? "update" : "delete",
        before: compactBefore ?? "", after
      }], workspacePath);
    }
    if (!hasSavedPatch && compactBefore === undefined && input.turnId && workspacePath === resolve(input.cwd)) {
      try {
        patch = buildTurnGitPatch(input.dataDir, input.turnId, workspacePath, [normalizedPath]) ?? "";
      } catch {}
    }
    if (!patch.trim()) patch = buildWebVsCodeReview(groupedCandidates, workspacePath);
    if (!/^@@ /m.test(patch)) continue;

    const currentText = existsSync(absolutePath) && statSync(absolutePath).isFile()
      ? readFileSync(absolutePath, "utf8")
      : "";
    const baselineText = compactBefore !== undefined ? compactBefore ?? "" : reconstructBaseline(currentText, parseUnifiedDiff(patch));
    totalBytes += Buffer.byteLength(patch, "utf8") + Buffer.byteLength(baselineText, "utf8");
    if (totalBytes > MAX_REVIEW_BYTES) {
      throw new Error("The combined review is larger than 16 MB.");
    }
    files.push({ path: normalizedPath, patch, baselineText });
  }

  if (files.length === 0) return null;

  const now = Date.now();
  const requestId = randomUUID();
  const requestDirectory = resolve(input.dataDir, "code-server", "review-requests");
  mkdirSync(requestDirectory, { recursive: true });
  pruneOldReviewRequests(requestDirectory, now);
  const requestName = `${now}-${safeRequestSegment(input.turnId || input.sessionId)}-${requestId}.json`;
  const requestPath = resolve(requestDirectory, requestName);
  const temporaryPath = `${requestPath}.tmp`;
  const request = {
    version: 2,
    requestId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + REQUEST_LIFETIME_MS).toISOString(),
    workspacePath,
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: input.scope === "session" ? "Threadex session review" : input.turnId ? `Threadex turn ${input.turnId}` : "Threadex turn review",
    mode: "edit",
    source: { kind: input.scope === "session" ? "session" : "turn" },
    capabilities: { explain: true, annotate: true, mutate: true, accept: true, reject: true },
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    files
  };
  writeFileSync(temporaryPath, JSON.stringify(request), "utf8");
  renameSync(temporaryPath, requestPath);

  const firstOpenPath = files.find((file) => {
    const absolutePath = resolveWorkspaceFilePath(workspacePath, file.path);
    return Boolean(absolutePath && existsSync(absolutePath) && statSync(absolutePath).isFile());
  })?.path;

  return { requestId, requestPath, fileCount: files.length, firstOpenPath, workspacePath };
}

function resolveReviewWorkspacePath(cwd: string, candidates: ReviewCandidate[], allowExternalPaths: boolean) {
  const sessionRoot = resolve(cwd);
  const requestedPaths = candidates.flatMap((candidate) => {
    const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
    return path ? [path] : [];
  });
  if (requestedPaths.length === 0) return sessionRoot;
  if (requestedPaths.every((path) => Boolean(resolveWorkspaceFilePath(sessionRoot, path)))) return sessionRoot;
  if (!allowExternalPaths || requestedPaths.some((path) => !isAbsolute(path))) return null;

  const roots = new Set<string>();
  for (const requestedPath of requestedPaths) {
    const gitRoot = externalGitRoot(requestedPath);
    if (!gitRoot || !resolveWorkspaceFilePath(gitRoot, requestedPath)) return null;
    roots.add(gitRoot);
  }
  return roots.size === 1 ? [...roots][0] : null;
}

function externalGitRoot(requestedPath: string) {
  let probe = resolve(requestedPath);
  try {
    if (!existsSync(probe) || !statSync(probe).isDirectory()) probe = dirname(probe);
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    while (!existsSync(resolve(probe, ".git"))) {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    return probe;
  } catch {
    return null;
  }
}

export function createWebVsCodeAnnotationSession(input: {
  dataDir: string;
  sessionId: string;
  cwd: string;
  returnUrl?: string;
}) {
  const now = Date.now();
  const requestId = randomUUID();
  const requestDirectory = resolve(input.dataDir, "code-server", "review-requests");
  mkdirSync(requestDirectory, { recursive: true });
  pruneOldReviewRequests(requestDirectory, now);
  const requestPath = resolve(requestDirectory, `${now}-${safeRequestSegment(input.sessionId)}-${requestId}.json`);
  const temporaryPath = `${requestPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({
    version: 3,
    requestId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + REQUEST_LIFETIME_MS).toISOString(),
    workspacePath: input.cwd,
    sessionId: input.sessionId,
    turnId: "",
    title: "Threadex project annotation",
    mode: "annotate",
    source: { kind: "session" },
    capabilities: { explain: false, annotate: true, mutate: false, accept: false, reject: false },
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    files: []
  }), "utf8");
  renameSync(temporaryPath, requestPath);
  return { requestId, requestPath };
}

type ReviewPatchBlock = {
  originalStart: number;
  modifiedStart: number;
  originalLines: string[];
  modifiedLines: string[];
};

function parseUnifiedDiff(patch: string) {
  const blocks: ReviewPatchBlock[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let oldLine = 0;
  let newLine = 0;
  let pending: ReviewPatchBlock | null = null;
  const flush = () => {
    if (pending && (pending.originalLines.length > 0 || pending.modifiedLines.length > 0)) blocks.push(pending);
    pending = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
    if (!hunk) continue;
    flush();
    oldLine = Math.max(0, Number(hunk[1]) - 1);
    newLine = Math.max(0, Number(hunk[3]) - 1);
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("@@ ") || line.startsWith("diff --git ")) {
        index -= 1;
        break;
      }
      if (line.startsWith("\\ No newline at end of file")) continue;
      const marker = line[0];
      if (marker === " ") {
        flush();
        oldLine += 1;
        newLine += 1;
        continue;
      }
      if (marker !== "+" && marker !== "-") continue;
      pending ??= { originalStart: oldLine, modifiedStart: newLine, originalLines: [], modifiedLines: [] };
      if (marker === "-") {
        pending.originalLines.push(line.slice(1));
        oldLine += 1;
      } else {
        pending.modifiedLines.push(line.slice(1));
        newLine += 1;
      }
    }
    flush();
  }
  return blocks;
}

function reconstructBaseline(text: string, blocks: ReviewPatchBlock[]) {
  return [...blocks]
    .sort((left, right) => right.modifiedStart - left.modifiedStart)
    .reduce((currentText, block) => {
      const normalized = currentText.replace(/\r\n/g, "\n");
      const trailingNewline = normalized.endsWith("\n");
      const lines = normalized ? normalized.split("\n") : [];
      if (trailingNewline) lines.pop();
      const start = Math.max(0, Math.min(block.modifiedStart, lines.length));
      lines.splice(start, block.modifiedLines.length, ...block.originalLines);
      const result = lines.join("\n");
      return trailingNewline && result ? `${result}\n` : result;
    }, text);
}

export function collectTurnReviewChanges(items: unknown[]) {
  const authoritativeItems = items.filter((candidate) => (
    Boolean(candidate && typeof candidate === "object") &&
    (candidate as Record<string, unknown>).itemType === "file_change" &&
    (candidate as Record<string, unknown>).authoritative === true &&
    Array.isArray((candidate as Record<string, unknown>).changes)
  ));
  const selectedItems = authoritativeItems.length > 0 ? [authoritativeItems.at(-1)] : items;
  const changes: unknown[] = [];
  for (const candidate of selectedItems) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    if (item.itemType !== "file_change" || !Array.isArray(item.changes)) continue;
    changes.push(...item.changes);
  }
  return changes;
}

export function collectSessionReviewChanges(liveItemsByTurn: Record<string, unknown[]>) {
  return Object.values(liveItemsByTurn).flatMap((items) => collectTurnReviewChanges(items));
}

export function webVsCodeReviewRequestDirectory(dataDir: string) {
  return resolve(dataDir, "code-server", "review-requests");
}

function safeRequestSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "review";
}

function pruneOldReviewRequests(requestDirectory: string, now: number) {
  try {
    for (const entry of readdirSync(requestDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp"))) continue;
      const requestPath = resolve(requestDirectory, entry.name);
      if ((now - statSync(requestPath).mtimeMs) > REQUEST_RETENTION_MS) {
        rmSync(requestPath, { force: true });
      }
    }
  } catch {}
}
