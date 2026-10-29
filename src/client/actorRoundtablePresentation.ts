import type { ActorRoundtable, ActorRoundtableState, ActorRoundtableView, StartActorRoundtable } from "../actorRoundtables";
import type { ActorRound } from "../domainActors";
import type { RoundtableActor } from "../roundtable";

/** A group chat round table link with its session-derived state when it has been read. */
export type ActorRoundtableLink = ActorRoundtable & { view?: ActorRoundtableView };
/** A start request kept until the server confirms it, so a retry reuses the same request ID. */
export type ActorRoundtableReceipt = StartActorRoundtable & { created: string; error?: string };
export type GroupChatEntry = { kind: "round"; created: string; round: ActorRound } | { kind: "roundtable"; created: string; link: ActorRoundtableLink };

const STATE_LABELS: Record<ActorRoundtableState, string> = {
  queued: "Queued", running: "In progress", done: "Done", error: "Failed", stopped: "Stopped", missing: "Session unavailable"
};
export const actorRoundtableStateLabel = (state: ActorRoundtableState | undefined) => state ? STATE_LABELS[state] : "Loading status…";
export const actorRoundtableActive = (state: ActorRoundtableState | undefined) => state === "queued" || state === "running";

/** Room links are authoritative for which round tables exist; views add state when the list has been read. */
export function mergeActorRoundtables(links: ActorRoundtable[] | undefined, views: ActorRoundtableView[]): ActorRoundtableLink[] {
  const byRequest = new Map(views.map(view => [view.requestId, view]));
  const merged: ActorRoundtableLink[] = (links ?? []).map(link => ({ ...link, view: byRequest.get(link.requestId) }));
  for (const view of views) if (!merged.some(link => link.requestId === view.requestId)) merged.push({ ...view, view });
  return merged;
}

/** Group chat rounds and round table links in creation order; equal times keep rounds first. */
export function groupChatEntries(rounds: ActorRound[], links: ActorRoundtableLink[]): GroupChatEntry[] {
  const entries: GroupChatEntry[] = [
    ...rounds.map(round => ({ kind: "round" as const, created: round.created, round })),
    ...links.map(link => ({ kind: "roundtable" as const, created: link.created, link }))
  ];
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => {
    const time = (Date.parse(a.entry.created) || 0) - (Date.parse(b.entry.created) || 0);
    return time || (a.entry.kind === b.entry.kind ? a.index - b.index : a.entry.kind === "round" ? -1 : 1);
  }).map(({ entry }) => entry);
}

const isActor = (value: unknown): value is RoundtableActor => !!value && typeof value === "object"
  && ["id", "name", "model", "effort", "systemPrompt"].every(key => typeof (value as Record<string, unknown>)[key] === "string");

export function parseActorRoundtableReceipts(raw: string | null): ActorRoundtableReceipt[] {
  try {
    const value = JSON.parse(raw ?? "null");
    return (Array.isArray(value) ? value : []).filter((item): item is ActorRoundtableReceipt => !!item
      && typeof item.requestId === "string" && typeof item.message === "string" && typeof item.created === "string"
      && Array.isArray(item.actors) && item.actors.every(isActor)
      && (item.sourceRoundId === undefined || typeof item.sourceRoundId === "string"));
  } catch { return []; }
}
/** The request body only: client bookkeeping fields are never sent. */
export const actorRoundtableRequest = ({ requestId, message, actors, sourceRoundId, title }: ActorRoundtableReceipt): StartActorRoundtable =>
  ({ requestId, message, actors, ...(sourceRoundId ? { sourceRoundId } : {}), ...(title ? { title } : {}) });
