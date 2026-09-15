export type OutcomeStatus = "pending" | "active" | "unverified" | "done" | "blocked";
export type OutcomeItem = {
  id: string;
  title: string;
  acceptance: string;
  children: OutcomeItem[];
};
export type OutcomeProgress = {
  status: OutcomeStatus;
  note: string;
  sources: string[];
};
export type LightweightTodo = {
  revision: number;
  objective: string;
  items: OutcomeItem[];
  progress: Record<string, OutcomeProgress>;
  sourceHash: string | null;
  updated: string;
};

export function flattenOutcomes(items: OutcomeItem[]): OutcomeItem[] {
  return items.flatMap((item) => [item, ...flattenOutcomes(item.children)]);
}

// Parents cannot report completion while any required descendant remains open.
export function outcomeProgress(plan: LightweightTodo, item: OutcomeItem): OutcomeProgress {
  const own = plan.progress[item.id] ?? { status: "pending", note: "", sources: [] };
  if (!item.children.length) return own;
  const children = item.children.map((child) => outcomeProgress(plan, child));
  if (children.some((child) => child.status === "blocked")) return { ...own, status: "blocked" };
  if (own.status === "done" && children.some((child) => child.status !== "done")) {
    return { ...own, status: "active" };
  }
  if (own.status === "pending" && children.some((child) => child.status !== "pending")) {
    return { ...own, status: "active" };
  }
  return own;
}
