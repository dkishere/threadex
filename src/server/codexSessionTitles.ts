import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CodexSessionTitle = {
  threadId: string;
  title: string;
};

export const PENDING_CODEX_SESSION_TITLE_PREFIX = "**";

export function markCodexSessionTitlePending(title: string): string {
  return title.startsWith(PENDING_CODEX_SESSION_TITLE_PREFIX)
    ? title
    : `${PENDING_CODEX_SESSION_TITLE_PREFIX}${title}`;
}

export function isCodexSessionTitlePending(title: string): boolean {
  return title.startsWith(PENDING_CODEX_SESSION_TITLE_PREFIX);
}

export function readCodexSessionTitles(codexHome: string): CodexSessionTitle[] {
  const indexPath = resolve(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return [];
  }

  try {
    return parseCodexSessionIndex(readFileSync(indexPath, "utf8"));
  } catch {
    return [];
  }
}

export function writeCodexSessionTitle(codexHome: string, input: CodexSessionTitle): CodexSessionTitle | null {
  const threadId = input.threadId.trim();
  const title = normalizeCodexSessionTitle(input.title);
  if (!threadId || !title) {
    return null;
  }

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  appendFileSync(
    resolve(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: threadId, thread_name: title, updated_at: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return { threadId, title };
}

export function parseCodexSessionIndex(contents: string): CodexSessionTitle[] {
  const titles = new Map<string, string>();

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const threadId = typeof record.id === "string" ? record.id.trim() : "";
      const title = normalizeCodexSessionTitle(record.thread_name);
      if (threadId) {
        if (title) {
          titles.set(threadId, title);
        } else {
          titles.delete(threadId);
        }
      }
    } catch {
      // A malformed index line must not prevent the remaining titles from syncing.
    }
  }

  return [...titles].map(([threadId, title]) => ({ threadId, title }));
}

export function normalizeCodexSessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}
