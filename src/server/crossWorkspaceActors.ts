import type { ActorRoom, ActorRound, ActorWorkItem, DomainActor } from "../domainActors";
import { actorRoundtableUserPrompt } from "./actorRoundtables";
import { actorFollowupTurnId } from "./domainActorContext";
import { sessionMentionUserPrompt } from "./sessionActorMentions";
import type { SessionSteerMessageRecord, SessionTurnRecord } from "./sessionStore";
import { buildTurnGrillMidTurnInputs } from "./turnGrill";
import { MAX_DECISION_QUESTIONS } from "./decision/policy";
import type { Decision, DecisionQuestion, DecisionRequest, PurposePolicy } from "./decision/types";

export type CrossWorkspaceUserMessage = { text: string; question?: string };

/** Every batch judges the whole handoff, including later corrections. Only its per-message questions are split. */
export async function selectCrossWorkspaceUserMessages(input: {
  decide: Decision; thresholds: PurposePolicy["threshold"]; audit: DecisionRequest["audit"]; state: string;
  messages: CrossWorkspaceUserMessage[]; authorizationQuestion: DecisionQuestion;
}) {
  const messagesPerBatch = MAX_DECISION_QUESTIONS - 1;
  const selected: string[] = [];
  for (let offset = 0; offset < input.messages.length; offset += messagesPerBatch) {
    const batch = input.messages.slice(offset, offset + messagesPerBatch);
    const audit = input.messages.length <= messagesPerBatch ? input.audit : { ...input.audit, workItemId: `${input.audit.workItemId}:from-${offset}` };
    const decision = await input.decide({ purpose: "model_select", audit, state: input.state,
      questions: [input.authorizationQuestion, ...batch.map((_, index) => ({
        id: `evidence_${offset + index}`, kind: "choice" as const,
        instructions: `Should userMessages[${offset + index}].text be forwarded verbatim for this specific proposed task? Forward only direct evidence of the operation, permission for its destination, an applicable requirement, or a correction, limitation or confirmation needed to understand the instructions. Keep earlier evidence where later messages depend on it. Exclude different work, unrelated history, superseded instructions not needed to understand the task, and messages that would disclose unrelated content. A shared actor, project, feature name or session is insufficient. Omit if unsure.`,
        options: { omit: "This text is unnecessary or unsuitable to forward for this task.", forward: "This text directly and materially supports the scoped handoff." }
      }))] });
    if (!decision.ok) return { decision, rejectionReason: `Decision was unavailable (${decision.attempts.map(attempt => `${attempt.backend}: ${attempt.reason}`).join(", ") || "no backend"})` };
    const threshold = input.thresholds[decision.backend] ?? 0.5;
    const authorization = decision.answers.authorization;
    if (authorization?.kind !== "choice") return { decision, rejectionReason: "Decision returned no authorization answer" };
    if (authorization.choice !== "allow") return { decision, rejectionReason: `Decision chose deny (confidence ${authorization.confidence.toFixed(2)})` };
    if (authorization.confidence < threshold) return { decision, rejectionReason: `Decision was uncertain about authorization (confidence ${authorization.confidence.toFixed(2)})` };
    for (const [index, message] of batch.entries()) {
      const evidence = decision.answers[`evidence_${offset + index}`];
      if (evidence?.kind !== "choice" || evidence.confidence < threshold || !["forward", "omit"].includes(evidence.choice)) {
        return { decision, rejectionReason: "Decision was uncertain which user instructions support the handoff" };
      }
      if (evidence.choice === "forward") selected.push(message.text);
    }
    if (offset + batch.length === input.messages.length) return { decision, forwardedUserMessages: selected };
  }
  throw new Error("A cross-workspace handoff needs the user's own messages.");
}

export const CROSS_WORKSPACE_ACTOR_DENIED = "Cross-workspace actor access needs one of the user's own messages in this task to explicitly name the target workspace "
  + "(its name, ID or a threadex://<workspace>/ link) or the target actor. Actor-written briefs, memory and other actors' replies do not count. "
  + "Ask the user to name the workspace or actor, or propose the follow-up in your final response.";

const ASCII_WORD = /[a-z0-9_\-]/;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();

/** A whole-token mention: an ASCII term must not be part of a longer ASCII word; CJK terms have no word boundaries. */
function mentions(message: string, term: string) {
  const needle = normalize(term).trim();
  if (needle.length < 2) return false;
  for (let index = message.indexOf(needle); index >= 0; index = message.indexOf(needle, index + 1)) {
    const before = message[index - 1], after = message[index + needle.length];
    const asciiStart = ASCII_WORD.test(needle[0]), asciiEnd = ASCII_WORD.test(needle.at(-1)!);
    if ((!asciiStart || !before || !ASCII_WORD.test(before)) && (!asciiEnd || !after || !ASCII_WORD.test(after))) return true;
  }
  return false;
}

/** The user's message names this workspace: its ID, its name or one of its threadex:// links. */
export function userMessageNamesWorkspace(message: string | undefined, workspace: { id: string; name: string }) {
  if (!message) return false;
  const text = normalize(message);
  return text.includes(normalize(`threadex://${encodeURIComponent(workspace.id)}/`)) || mentions(text, workspace.id) || mentions(text, workspace.name);
}

/** The user's message names this actor: its ID, its full name or one part of a "名字 · 職責" style name. */
export function userMessageNamesActor(message: string | undefined, actor: Pick<DomainActor, "id" | "name">) {
  if (!message) return false;
  const text = normalize(message);
  return mentions(text, actor.id) || mentions(text, actor.name) || actor.name.split(/[·・|｜/]/).some(part => mentions(text, part));
}

function roundUserMessages(round: ActorRound | undefined): string[] {
  if (!round || round.sessionOrigin || round.sessionTarget?.takeover) return [];
  if (!round.crossWorkspaceOrigin) return [round.userPrompt];
  const userMessages = round.crossWorkspaceOrigin.userMessages;
  return userMessages?.join("\n\n") === round.userPrompt ? userMessages : [];
}

/** Routed continuations point at their source round. An explicit task-reference update stores the user's own text. */
export function taskUpdateUserMessages(room: Pick<ActorRoom, "rounds">,
  update: Pick<NonNullable<ActorRoom["taskUpdates"]>[number], "requestId" | "userPrompt" | "workItemId">): string[] {
  if (!update.requestId.startsWith("reuse:")) return [update.userPrompt];
  return roundUserMessages(room.rounds.find(round => `reuse:${round.id}` === update.requestId && round.continuation?.workItem?.id === update.workItemId));
}

/** Build cross-workspace evidence from source records. A task's canonical snapshot can contain generated prompts. */
export function taskUserMessages(room: ActorRoom, binding: ActorWorkItem, execution: Pick<ActorWorkItem, "taskTurnId">,
  sessionId: string, turns: SessionTurnRecord[], approvals: Record<string, unknown[]>, steers: Record<string, SessionSteerMessageRecord[]>) {
  const sourceRound = room.rounds.find(round => round.id === binding.roundId);
  const userRoom = { ...room, rounds: room.rounds.filter(round => !round.crossWorkspaceOrigin && roundUserMessages(round).length > 0) };
  const inheritedRoundIds = new Set(sourceRound?.contextRoundIds ?? []);
  const inheritedMessages = new Set(binding.canonicalUserMessages);
  const earlierRounds = room.rounds.filter(round => inheritedRoundIds.has(round.id) && inheritedMessages.has(round.userPrompt));
  const updatesByTurn = new Map((room.taskUpdates ?? [])
    .filter(update => update.status === "delivered" && update.workItemId === binding.id)
    .map(update => [actorFollowupTurnId(room.workspaceId, update.workItemId, update.requestId), update]));
  function userPrompts(turn: SessionTurnRecord): string[] {
    if (turn.id === execution.taskTurnId) return roundUserMessages(sourceRound);
    const update = updatesByTurn.get(turn.id);
    if (update) return taskUpdateUserMessages(room, update);
    const mention = sessionMentionUserPrompt(userRoom, sessionId, turn);
    if (mention !== undefined) return [mention];
    const metadata = turn.requestMetadata;
    if ((metadata?.promptOrigin as { kind?: string } | undefined)?.kind === "inter-actor") return [];
    if (metadata?.roundtable === true && metadata.fromUser === true) return [actorRoundtableUserPrompt(turn.userInput)];
    if (!["mobile", "tablet", "desktop"].includes(metadata?.clientLayout as string)) return [];
    return [typeof metadata?.message === "string" ? metadata.message : turn.userInput];
  }
  const messages: Array<CrossWorkspaceUserMessage & { created: string }> = [];
  for (const round of earlierRounds) for (const text of roundUserMessages(round)) messages.push({ text, created: round.created });
  if (sourceRound && !turns.some(turn => turn.id === execution.taskTurnId)) {
    for (const text of roundUserMessages(sourceRound)) messages.push({ text, created: sourceRound.created });
  }
  for (const turn of turns) {
    for (const text of userPrompts(turn)) if (text) messages.push({ text, created: turn.created });
    const userApprovals = (approvals[turn.id] ?? []).filter(item => (item as { answeredByUser?: unknown } | null)?.answeredByUser === true);
    const userSteers = (steers[turn.id] ?? []).filter(steer => steer.source === "user");
    for (const entry of buildTurnGrillMidTurnInputs(userApprovals, userSteers)) {
      if (entry.kind === "steer") messages.push({ text: entry.content, created: entry.created || turn.created });
      else for (const answer of entry.questions) {
        if (answer.answer !== "[secret answer redacted]") messages.push({ text: answer.answer, question: answer.question, created: entry.created || turn.created });
      }
    }
  }
  return messages.filter(message => message.text.trim()).sort((left, right) => Date.parse(left.created) - Date.parse(right.created))
    .map(({ created, ...message }) => message);
}
