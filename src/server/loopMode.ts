import type { TurnGrill } from "../turnGrill";
import { createHash } from "node:crypto";
import type { SessionStore } from "./sessionStore";

export function turnHasLoopActivity(items: unknown[]): boolean {
  return items.some((value) => {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : null;
    return item?.itemType === "command_execution"
      || (item?.itemType === "file_change" && Array.isArray(item.changes) && item.changes.length > 0);
  });
}

export function shouldAutoGrillTurn(items: unknown[], isLoopWorkTurn: boolean): boolean {
  return isLoopWorkTurn || turnHasLoopActivity(items);
}

export function loopWorkIssues(review: TurnGrill) {
  return review.status === "ready"
    ? review.issues.filter((issue) => issue.status === "open" && issue.selected && !issue.dropped && issue.impact !== "non_blocking")
    : [];
}

export function loopTodoIssues(review: TurnGrill) {
  return review.status === "ready"
    ? review.issues.filter((issue) => issue.status === "open" && issue.selected && !issue.dropped && issue.impact === "non_blocking")
    : [];
}

export function loopTodoId(sessionId: string, turnId: string, issueId: string) {
  return `loop_${createHash("sha256").update(JSON.stringify([sessionId, turnId, issueId])).digest("hex").slice(0, 32)}`;
}

export function loopStopReason(agentResponse: string, completedWorkCycles: number): string | null {
  if (completedWorkCycles < 2) return null;
  const finalLine = agentResponse.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return /^Loop stopped:[ \t]*(\S[^\r\n]{0,999})$/i.exec(finalLine)?.[1]?.trim() ?? null;
}

export function loopWorkInstructions(workCycle: number) {
  return [
    `This is Auto Grill Start work cycle ${workCycle}. Address the blocking issues with concrete project evidence. Non-blocking issues have been accepted as Todo and do not need to be completed in this cycle.`,
    workCycle >= 2
      ? "If the same blocker remains unresolved after a genuine attempt and you cannot safely make progress, you may terminate this Loop by ending your final response with a line exactly like: Loop stopped: <specific blocker and reason>. Explain the evidence and remaining work. Otherwise omit that line so Loop continues."
      : "This is the first cycle. Do not terminate Loop in this turn; it must complete at least two full turn, Grill, and Start work cycles before an agent can stop it."
  ].join("\n\n");
}

export async function acceptLoopTodos(store: SessionStore, sessionId: string, turnId: string, review: TurnGrill) {
  const issues = loopTodoIssues(review);
  if (!issues.length) return { review, todoChanged: false };
  const existing = new Set((await store.getSessionTodo(sessionId)).items.map((item) => item.id));
  let todoChanged = false;
  for (const issue of issues) {
    const id = loopTodoId(sessionId, turnId, issue.id);
    if (existing.has(id)) continue;
    const title = issue.md.split("\n").find((line) => line.trim())?.replace(/^[#*\s-]+/, "").trim().slice(0, 160) || `Grill issue ${issue.id}`;
    await store.upsertTodoItem({ id, sessionId, title, details: issue.md,
      context: `Accepted as non-blocking Todo from Auto Grill of turn ${turnId}.`, section: "solution", status: "todo", actor: "system", turnId });
    todoChanged = true;
  }
  const issueIds = new Set(issues.map((issue) => issue.id));
  while (true) {
    const current = await store.getTurnGrill(sessionId, turnId);
    if (!current) throw new Error("Auto Grill review disappeared before Todo acceptance.");
    if (issues.every((issue) => current.issues.find((candidate) => candidate.id === issue.id)?.todoId === loopTodoId(sessionId, turnId, issue.id))) {
      return { review: current, todoChanged };
    }
    const next: TurnGrill = { ...current, revision: current.revision + 1,
      issues: current.issues.map((issue) => issueIds.has(issue.id)
        ? { ...issue, todoId: loopTodoId(sessionId, turnId, issue.id) } : issue) };
    if (await store.saveTurnGrill(sessionId, turnId, current.revision, next)) return { review: next, todoChanged };
  }
}
