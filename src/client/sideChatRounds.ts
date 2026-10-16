import type { RoundtableActor } from "../roundtable";
import type { SessionSideChat } from "./sessionApi";

/** One reply request still in flight, or one that failed and can be retried. */
export type OutgoingSideChatReply = {
  jobId?: string;
  requestId?: string;
  key: string;
  roundId: string;
  actor: RoundtableActor | null;
  question: string;
  model: string;
  effort: string;
  replyToId?: string;
  status: "pending" | "failed";
  error?: string;
};

export type SideChatRoomItem =
  | { kind: "saved"; entry: SessionSideChat }
  | { kind: "outgoing"; reply: OutgoingSideChatReply };

export type SideChatRoomRound = {
  id: string;
  /** The user's message; absent when the user asked an actor to reply to another. */
  question: string | null;
  replyToId: string | null;
  items: SideChatRoomItem[];
};

/** Group saved replies and in-flight requests into chat rounds: one user message, then each speaker's reply. */
export function buildSideChatRounds(messages: SessionSideChat[], outgoing: OutgoingSideChatReply[]): SideChatRoomRound[] {
  const rounds: SideChatRoomRound[] = [];
  const byId = new Map<string, SideChatRoomRound>();
  const roundFor = (id: string, question: string, replyToId: string | null, consecutiveOnly: boolean) => {
    const existing = consecutiveOnly ? rounds.at(-1)?.id === id ? rounds.at(-1) : undefined : byId.get(id);
    if (existing) return existing;
    const round: SideChatRoomRound = { id, question: replyToId ? null : question, replyToId, items: [] };
    rounds.push(round);
    byId.set(id, round);
    return round;
  };
  for (const entry of messages) {
    roundFor(entry.roundId ?? entry.id, entry.question, entry.replyToId ?? null, true).items.push({ kind: "saved", entry });
  }
  for (const reply of outgoing) {
    roundFor(reply.roundId, reply.question, reply.replyToId ?? null, false).items.push({ kind: "outgoing", reply });
  }
  return rounds;
}
