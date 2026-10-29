import type { RoundtableActor } from "./roundtable";

/** A round table opened from the Actors group chat runs in its own session; the group chat keeps only this link. */
export type ActorRoundtable = {
  requestId: string; workspaceId: string; sessionId: string; turnId: string;
  /** Short session title without an actor prefix. */
  title: string;
  /** The user's prompt as typed; the round's frozen prompt also carries `contextSummary`. */
  prompt: string;
  /** Bounded excerpt of recent group chat rounds, never the whole history. */
  contextSummary: string;
  actorNames: string[];
  /** Group chat round the user started from; null when started without one. */
  sourceRoundId: string | null;
  created: string;
};
/** `missing` means the session or its first round no longer exists; the link is still kept. */
export type ActorRoundtableState = "queued" | "running" | "done" | "error" | "stopped" | "missing";
export type ActorRoundtableView = ActorRoundtable & {
  state: ActorRoundtableState;
  /** Rounds held by the session, including next rounds started there. */
  rounds: number;
  /** Short conclusion of the latest finished round. */
  conclusion: string | null;
  error: string | null;
};
export type StartActorRoundtable = {
  /** 1–100 ASCII letters, digits, underscores or hyphens; a retry with the same ID and input returns the same round table. */
  requestId: string; message: string; actors: RoundtableActor[];
  sourceRoundId?: string; title?: string;
};
export const actorRoundtablesPath = (workspaceId: string) => `/api/domain-actors/${encodeURIComponent(workspaceId)}/roundtables`;
