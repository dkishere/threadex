import { buildCodexReference } from "../codexReference";
import type { TurnIssueCopyPayload } from "./appTypes";

export type TurnIssueCopyInput = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  issueKey: number;
  issue: string;
  solution: string | null;
  blocker?: string;
};

export function buildTurnIssueCopyPayload(input: TurnIssueCopyInput): TurnIssueCopyPayload {
  return {
    kind: "threadex-issue-context",
    cli: "codex",
    id: input.id,
    sessionUrl: buildCodexReference(input.workspaceId, input.sessionId),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    issueKey: input.issueKey,
    issue: input.issue,
    resolved: input.solution !== null,
    solution: input.solution,
    ...(!input.solution && input.blocker ? { blocker: input.blocker } : {})
  };
}

export function serializeTurnIssueCopy(input: TurnIssueCopyInput): string {
  return JSON.stringify(buildTurnIssueCopyPayload(input), null, 2);
}

export function parseTurnIssueContext(value: string): TurnIssueCopyPayload | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value.trim());
  } catch {
    return null;
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "threadex-issue-context") return null;
  if (record.cli !== "codex" || !isNonEmptyString(record.id)) return null;
  if (!isNonEmptyString(record.workspaceId) || !isNonEmptyString(record.sessionId)) return null;
  if (!isNonEmptyString(record.turnId) || !isNonEmptyString(record.issue)) return null;
  if (!Number.isInteger(record.issueKey) || (record.issueKey as number) < 1) return null;
  if (typeof record.resolved !== "boolean") return null;
  if (record.solution !== null && !isNonEmptyString(record.solution)) return null;
  if (record.resolved !== (record.solution !== null)) return null;
  if (record.blocker !== undefined && (!isNonEmptyString(record.blocker) || record.resolved)) return null;
  if (record.sessionUrl !== buildCodexReference(record.workspaceId, record.sessionId)) return null;
  return candidate as TurnIssueCopyPayload;
}

export function turnIssueContextAttachmentName(context: TurnIssueCopyPayload): string {
  const turnSlug = context.turnId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "turn";
  return `threadex-issue-${turnSlug}-${context.issueKey}.json`;
}

export function turnIssueContextTitle(context: TurnIssueCopyPayload): string {
  return context.issue;
}

export function turnIssueContextDetail(context: TurnIssueCopyPayload): string {
  return `#${context.issueKey} · ${context.resolved ? "Resolved" : context.blocker ? "Blocker" : "Open"} · ${context.turnId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
