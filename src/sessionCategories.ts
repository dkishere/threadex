export type SessionCategory = {
  id: string;
  parentId: string | null;
  name: string;
  terms: string[];
  context: string;
  description?: string;
  origin?: "seed" | "manual" | "luna";
  aiContext?: string;
  aiSources?: string[];
  aiUpdatedAt?: string;
  aiSourceHash?: string;
};

export type CategoryExperiment = {
  enabled: boolean;
  threshold: number;
  categories: SessionCategory[];
  assignments: Record<string, string>;
  memberships?: Record<string, string[]>;
  backupPath?: string;
  contextPaused?: boolean;
  language?: "auto" | "en" | "zh-Hant";
  classifierVersion?: number;
  decisions?: Record<string, { source: "manual" | "luna"; hash: string; confidence: number; reason: string; at: string }>;
  splitChecks?: Record<string, string>;
  previousTree?: { categories: SessionCategory[]; assignments: Record<string, string> };
};

export function sessionCategoryIds(state: CategoryExperiment, id: string): string[] {
  return state.memberships?.[id] ?? (state.assignments[id] ? [state.assignments[id]] : []);
}

export function initialCategories(): CategoryExperiment {
  return {
    enabled: false, threshold: 12, assignments: {},
    categories: [
      { id: "threadex", parentId: null, name: "Threadex", terms: [], context: "" },
      { id: "runner", parentId: "threadex", name: "Runner", terms: ["runner", "codex", "execution", "執行"], context: "" },
      { id: "ui", parentId: "threadex", name: "UI", terms: ["ui", "sidebar", "css", "composer", "畫面", "介面"], context: "" },
      { id: "server", parentId: "threadex", name: "Server", terms: ["server", "api", "database", "postgres", "資料庫"], context: "" }
    ]
  };
}

export const categoryScopes: Record<string, string> = {
  threadex: "Threadex product direction, architecture spanning multiple components, and sessions whose primary purpose is unclear.",
  runner: "Agent execution lifecycle: starting/resuming/stopping turns, steering, recovery, tools, approvals, account/model routing and runtime coordination. Classify by primary purpose, not incidental words such as Codex or agent.",
  ui: "User-facing interaction and presentation: sidebar, session lists, composer, transcript rendering, navigation, layout, responsive behavior and accessibility.",
  server: "Backend services and persistence: API behavior, session storage, database migrations, import/sync, filesystem integration and server operations. Runner lifecycle belongs under Runner."
};

export function categoryAncestors(state: CategoryExperiment, id: string): SessionCategory[] {
  const result: SessionCategory[] = [];
  const seen = new Set<string>();
  let category = state.categories.find(item => item.id === id);
  while (category && !seen.has(category.id)) {
    seen.add(category.id);
    result.unshift(category);
    category = state.categories.find(item => item.id === category!.parentId);
  }
  return result;
}
