export type GrillIssue = { id: string; md: string; responseMd: string; status: "open" | "resolved"; selected: boolean; dropped?: boolean };
export type GrillRound = { id: string; created: string; action: "start" | "respond" | "followup" | "save"; prompt: string; issues: GrillIssue[] };
export type TurnGrill = {
  revision: number; status: "running" | "ready" | "error"; updated: string;
  issues: GrillIssue[]; rounds: GrillRound[]; error: string | null;
  contentVersion?: number;
  acknowledgedVersion?: number;
  workTurns?: Record<string, "pending" | "completed">;
  request?: { action: "start" | "respond" | "followup"; prompt: string; issueId?: string };
};

export type GrillSummary = { sessionId: string; turnId: string; revision: number; pending: boolean };
export function grillContentVersion(review: TurnGrill | null): number {
  return review?.contentVersion ?? review?.rounds.filter((round) => round.action !== "save").length ?? 0;
}
export function grillAwaitingAck(review: TurnGrill | null): boolean {
  return Boolean(review?.issues.length) && grillContentVersion(review) > (review?.acknowledgedVersion ?? 0);
}
export function acknowledgeGrill(review: TurnGrill, observed: number): TurnGrill {
  if (!Number.isSafeInteger(observed) || observed < 0 || observed > grillContentVersion(review)) throw new Error("Invalid Grill acknowledgment version.");
  return { ...review, acknowledgedVersion: Math.max(review.acknowledgedVersion ?? 0, observed) };
}

export function canFollowUpGrill(review: TurnGrill | null): boolean {
  return Boolean(review?.rounds.some((round) => round.action === "respond"
    && round.issues.some((issue) => issue.selected && !issue.dropped && issue.responseMd.trim().length > 0)));
}

// Merge editable fields onto the latest server snapshot; responses belong to the server.
export function mergeGrillEdits(base: GrillIssue[], local: GrillIssue[], server: GrillIssue[]) {
  const conflicts: string[] = [];
  const issues = server.map((remote) => {
    const before = base.find((issue) => issue.id === remote.id);
    const draft = local.find((issue) => issue.id === remote.id);
    if (!before || !draft) return remote;
    const merged = { ...remote };
    for (const field of ["md", "selected", "dropped", "status"] as const) {
      const value = (issue: GrillIssue) => field === "dropped" ? Boolean(issue[field]) : issue[field];
      if (value(draft) === value(before)) continue;
      if (value(remote) !== value(before) && value(remote) !== value(draft)) conflicts.push(`${remote.id}.${field}`);
      Object.assign(merged, { [field]: draft[field] });
    }
    if (merged.md !== remote.md) merged.status = "open";
    if (merged.dropped) merged.selected = false;
    return merged;
  });
  return { issues, conflicts };
}

export function parseGrillIssues(value: unknown): GrillIssue[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Expected a JSON array of at most 20 Grill issues.");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item.id !== "string" || !/^[\w-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.md !== "string" || !item.md.trim() || item.md.length > 16000
      || typeof item.responseMd !== "string" || item.responseMd.length > 32000
      || !["open", "resolved"].includes(item.status)
      || (item.dropped !== undefined && typeof item.dropped !== "boolean")) throw new Error("Invalid Grill issue format or duplicate ID.");
    ids.add(item.id);
    return { id: item.id, md: item.md.trim(), responseMd: item.responseMd, status: item.status, selected: item.dropped === true ? false : item.selected !== false, ...(item.dropped !== undefined ? { dropped: item.dropped } : {}) };
  });
}

export function grillHandoff(issues: GrillIssue[], additionalPrompt: string, rounds: GrillRound[] = []) {
  const selected = issues.filter((issue) => issue.selected && !issue.dropped);
  if (!selected.length) throw new Error("Select at least one issue to send to the main thread.");
  return `Implement the action plan from this Grill review. Check the responses against the project before making changes.\n\n${selected.map((issue) => {
    const discussion = rounds.flatMap((round, index) => {
      if (round.action !== "respond" && round.action !== "followup") return [];
      const answer = round.issues.find((candidate) => candidate.id === issue.id && candidate.selected && !candidate.dropped && candidate.responseMd.trim());
      if (!answer) return [];
      return [`#### Round ${index + 1}\n${round.prompt.trim() ? `**User:**\n${round.prompt.trim()}\n\n` : ""}**${round.action === "respond" ? "Agent" : "Griller"}:**\n${answer.responseMd}`];
    });
    return `### ${issue.id}\n${issue.md}\n\n${discussion.length ? discussion.join("\n\n") : issue.responseMd ? `Response (speaker unavailable in saved history):\n${issue.responseMd}` : "No response yet."}`;
  }).join("\n\n")}\n\n${additionalPrompt.trim() ? `**User (Start work instructions):**\n${additionalPrompt.trim()}` : ""}`.trim();
}
