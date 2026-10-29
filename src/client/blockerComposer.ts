import type { ActorBlockerView } from "./actorBlockerPresentation";
import { BLOCKER_KIND_LABELS, BLOCKER_STATUS_LABELS } from "./actorBlockerPresentation";

export const BLOCKER_TO_COMPOSER_EVENT = "threadex:blocker-to-composer";

export type BlockerComposerTarget = "current" | "new";
export type BlockerComposerRequest = { text: string; target: BlockerComposerTarget };

/** Blocker context as composer text: description, status, task and the latest proposal in full. */
export function blockerComposerText(blocker: ActorBlockerView, ownerName: string): string {
  const proposal = blocker.proposals.at(-1);
  const lines = [
    "[Threadex blocker]",
    `Blocker: ${blocker.description}`,
    `Status: ${BLOCKER_STATUS_LABELS[blocker.status]} (${BLOCKER_KIND_LABELS[blocker.kind]})`,
    `Owner: ${ownerName}`,
    ...(blocker.taskSessionId ? [`Task session: ${blocker.taskSessionTitle ? `${blocker.taskSessionTitle} (${blocker.taskSessionId})` : blocker.taskSessionId}`] : []),
    ...(proposal ? ["", "Latest proposed solution:", proposal.text] : []),
  ];
  return lines.join("\n");
}

/** Ask the shell to prefill a composer (never sends); `current` appends to the open session's draft, `new` starts a new session. */
export function requestBlockerComposer(request: BlockerComposerRequest) {
  window.dispatchEvent(new CustomEvent<BlockerComposerRequest>(BLOCKER_TO_COMPOSER_EVENT, { detail: request }));
}
