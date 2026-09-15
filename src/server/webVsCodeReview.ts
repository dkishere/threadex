import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveWorkspaceFilePath } from "./workspaceFiles";

export function buildWebVsCodeReview(changes: unknown[], cwd: string) {
  const sections: string[] = [
    "# Threadex turn review",
    `# Project: ${cwd}`,
    `# Files: ${changes.length}`,
    ""
  ];
  for (const candidate of changes) {
    if (!candidate || typeof candidate !== "object") continue;
    const change = candidate as Record<string, unknown>;
    const requestedPath = typeof change.path === "string" ? change.path.trim() : "";
    if (!requestedPath || !resolveWorkspaceFilePath(cwd, requestedPath)) continue;
    const existingDiff = firstReviewText(change, ["unifiedDiff", "patch", "diff"]);
    if (existingDiff && /^---\s/m.test(existingDiff) && /^\+\+\+\s/m.test(existingDiff)) {
      sections.push(`diff --threadex a/${requestedPath} b/${requestedPath}`, existingDiff.trimEnd(), "");
      continue;
    }
    if (existingDiff && /^@@ -\d+/m.test(existingDiff)) {
      const kind = typeof change.kind === "string" ? change.kind : "update";
      sections.push(
        `diff --threadex a/${requestedPath} b/${requestedPath}`,
        kind === "add" ? "--- /dev/null" : `--- a/${requestedPath}`,
        kind === "delete" ? "+++ /dev/null" : `+++ b/${requestedPath}`,
        existingDiff.trimEnd(),
        ""
      );
      continue;
    }
    const before = firstReviewText(change, ["before", "beforeText", "beforeContent", "oldContent", "previousContent", "original"]);
    let after = firstReviewText(change, ["after", "afterText", "afterContent", "newContent", "currentContent", "updated"]);
    const declaredKind = typeof change.kind === "string" ? change.kind : "";
    // Legacy apply_patch Add File events store the new source text in `diff`
    // with no kind or hunk markers. That is the only empty-baseline fallback
    // we accept; an ordinary update must carry a hunk or explicit before text.
    const kind = declaredKind || (existingDiff ? "add" : "update");
    if (after === undefined && existingDiff && kind !== "delete") {
      after = existingDiff;
    }
    if (after === undefined && kind === "add") {
      const currentPath = resolveWorkspaceFilePath(cwd, requestedPath);
      if (currentPath && existsSync(currentPath) && statSync(currentPath).isFile() && statSync(currentPath).size <= 2 * 1024 * 1024) {
        after = readFileSync(currentPath, "utf8");
      }
    }
    if (kind === "delete" ? before === undefined : kind !== "add" && before === undefined) continue;
    if (kind !== "delete" && after === undefined) continue;
    const oldLines = reviewLines(before ?? "");
    const newLines = reviewLines(after ?? "");
    sections.push(
      `diff --threadex a/${requestedPath} b/${requestedPath}`,
      kind === "add" ? "--- /dev/null" : `--- a/${requestedPath}`,
      kind === "delete" ? "+++ /dev/null" : `+++ b/${requestedPath}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
      ""
    );
  }
  return sections.join("\n");
}

function firstReviewText(change: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof change[key] === "string") return change[key] as string;
  }
  return undefined;
}

function reviewLines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}
