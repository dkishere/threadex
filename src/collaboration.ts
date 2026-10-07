export type CollaborationFork = { threadId: string; lastTurnId: string };

export type CollaborationMember = {
  localId: string;
  sessionId: string;
  task: string;
  requestFingerprint?: string;
  sourceSessionId: string;
  sourceTurnId: string | null;
  fork: CollaborationFork | null;
  model: string;
  effort: string;
  fastMode?: boolean;
  approvalPolicy?: string;
  stopped: boolean;
  observed: Record<string, string>;
};

export type CollaborationMessage = {
  id: string;
  from: string;
  to: string;
  text: string;
  reason: string;
  kind: "task" | "followup" | "result";
  wait: boolean;
  parentId: string | null;
  sourceTurnId?: string;
  depth: number;
  state: "pending" | "steering" | "delivered" | "uncertain" | "cancelled";
  targetTurnId: string | null;
  completed: boolean;
  error: string | null;
  created: string;
  attachments?: Array<{ id?: string; name?: string; type?: string; size?: number; path?: string }>;
  skills?: Array<{ name: string; path: string }>;
  nextAttemptAt?: number;
  attempts?: number;
  forceQueue?: boolean;
};

export type CollaborationResult = {
  id: string;
  localId: string;
  sessionId: string;
  turnId: string;
  status: string;
  summary: string;
  changes: Array<{ path: string; kind: string; additions: number; deletions: number; movePath?: string }>;
  created: string;
};

export type CollaborationGroup = {
  id: string;
  workspaceId: string;
  mainSessionId: string;
  revision: number;
  created: string;
  updated: string;
  lease: { owner: string; until: number } | null;
  error?: string | null;
  members: CollaborationMember[];
  messages: CollaborationMessage[];
  results: CollaborationResult[];
};

export type CollaborationView = CollaborationGroup & {
  activity: Record<string, { status: string; turnId: string | null; progress: string }>;
  conflicts: Array<{ path: string; members: string[] }>;
};

export function isCollaborationMemberEnded(group: CollaborationView, localId: string): boolean {
  const member = group.members.find(member => member.localId === localId);
  if (!member || localId === "main") return false;
  if (member.stopped) return true;
  if (group.activity[localId]?.status !== "idle") return false;
  return !group.messages.some(message => !message.completed && message.state !== "cancelled" &&
    ((message.to === localId && ["pending", "steering", "uncertain"].includes(message.state)) ||
      (message.from === localId && message.wait)));
}
