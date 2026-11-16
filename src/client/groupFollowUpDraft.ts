import { useSyncExternalStore } from "react";

/** A session attached to the group chat composer as a "Group follow-up" badge. */
export type GroupFollowUpDraft = { sessionId: string; title: string; projectId: string; projectName: string };

let current: GroupFollowUpDraft | null = null;
const listeners = new Set<() => void>();

function emit() { for (const listener of [...listeners]) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function getGroupFollowUpDraft() { return current; }

/** A composer holds at most one session badge; a new one replaces the old one. */
export function setGroupFollowUpDraft(draft: GroupFollowUpDraft) {
  current = { sessionId: draft.sessionId, title: draft.title.trim() || draft.sessionId, projectId: draft.projectId, projectName: draft.projectName };
  emit();
}

/** Clears the badge; with `sessionId` only if that session is still the attached one. */
export function clearGroupFollowUpDraft(sessionId?: string) {
  if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return;
  current = null;
  emit();
}

export function useGroupFollowUpDraft() {
  return useSyncExternalStore(subscribe, getGroupFollowUpDraft, () => null);
}

export type GroupFollowUpGuardInput = {
  draft: GroupFollowUpDraft;
  /** The group chat this composer belongs to; null for the unassigned chat. */
  chatProjectId: string | null;
  hasPromptText: boolean;
  attachmentCount: number;
  roundtableMode: boolean;
  /** Individual actor chat, or the prompt @mentions an actor. */
  addressesActor: boolean;
};
export type GroupFollowUpGuard = { ok: true } | { ok: false; reason: string | null };

/** Why a group follow-up cannot be sent yet. `reason: null` means blocked without an explanation (empty prompt). */
export function groupFollowUpGuard(input: GroupFollowUpGuardInput): GroupFollowUpGuard {
  if (input.chatProjectId !== input.draft.projectId) return { ok: false, reason: `This session belongs to ${input.draft.projectName}; open its group chat.` };
  if (input.attachmentCount > 0) return { ok: false, reason: "Files cannot be sent with a group follow-up yet." };
  if (input.roundtableMode) return { ok: false, reason: "Round table cannot be combined with a group follow-up. Turn off Round table." };
  if (input.addressesActor) return { ok: false, reason: "A group follow-up goes to the whole group chat. Remove the @mention." };
  if (!input.hasPromptText) return { ok: false, reason: null };
  return { ok: true };
}
