import type { RoundtableActor } from "./roundtable";

/** What a side-chat message keeps of its speaker. Role prompts stay with the live actor. */
export type SideChatActor = { id: string; name: string; model: string; effort: string; avatar?: string; presetId?: string };

/** One saved side-chat reply: the prompt that produced it and the speaker's answer. */
export type SideChatTranscriptEntry = {
  id: string;
  roundId: string | null;
  replyToId: string | null;
  question: string;
  answer: string;
  model: string;
  actor: SideChatActor | null;
};

export const SIDE_CHAT_MAX_ACTORS = 8;

export function sideChatActorSnapshot(actor: RoundtableActor): SideChatActor {
  // Uploaded avatars are data URLs of up to 64 KB. Keep message rows small and
  // let the client resolve those from the live roster or actor library.
  return {
    id: actor.id, name: actor.name, model: actor.model, effort: actor.effort,
    ...(actor.avatar && !actor.avatar.startsWith("data:") ? { avatar: actor.avatar } : {}),
    ...(actor.presetId ? { presetId: actor.presetId } : {})
  };
}

export function parseSideChatActorJson(value: unknown): SideChatActor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const raw = JSON.parse(value) as Partial<SideChatActor> | null;
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.model !== "string" || typeof raw.effort !== "string") return null;
    return {
      id: raw.id, name: raw.name, model: raw.model, effort: raw.effort,
      ...(typeof raw.avatar === "string" ? { avatar: raw.avatar } : {}),
      ...(typeof raw.presetId === "string" ? { presetId: raw.presetId } : {})
    };
  } catch {
    return null;
  }
}

/** The `@query` being typed at the caret, if any. */
export function findMentionTrigger(value: string, caret: number | null = value.length) {
  const end = caret ?? value.length;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(value.slice(0, end));
  return match ? { start: end - match[1].length - 1, end, query: match[1] } : null;
}

const wordCharacter = /[\p{L}\p{N}_]/u;

/** Actors addressed with @Name, in roster order. Longer names win, so "@Robin 2" does not also address "Robin". */
export function mentionedActors<T extends { name: string }>(text: string, actors: T[]): T[] {
  let rest = text.toLowerCase();
  const found = new Set<T>();
  for (const actor of [...actors].sort((a, b) => b.name.length - a.name.length)) {
    const token = `@${actor.name.toLowerCase()}`;
    for (let index = rest.indexOf(token); index >= 0; index = rest.indexOf(token, index + 1)) {
      const next = rest.charAt(index + token.length);
      if (next && wordCharacter.test(next)) continue;
      found.add(actor);
      rest = `${rest.slice(0, index)}${" ".repeat(token.length)}${rest.slice(index + token.length)}`;
    }
  }
  return actors.filter((actor) => found.has(actor));
}

export function sideChatSpeaker(entry: Pick<SideChatTranscriptEntry, "actor" | "model">) {
  return entry.actor?.name ?? `Assistant (${entry.model})`;
}

/**
 * Plain-text room transcript, oldest first. A round's user message appears once
 * however many actors answered it. Older entries are dropped to fit `maxChars`.
 */
export function formatSideChatTranscript(entries: SideChatTranscriptEntry[], all: SideChatTranscriptEntry[] = entries, maxChars = 24_000) {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  // Trim whole rounds so a kept reply never loses the user message it answered.
  const blocks: string[] = [];
  let previousRound: string | null = null;
  for (const entry of entries) {
    const replyTo = entry.replyToId ? byId.get(entry.replyToId) : undefined;
    const sameRound = entry.roundId !== null && entry.roundId === previousRound && blocks.length > 0;
    const lines = [
      ...(entry.replyToId
        ? [`[The user asked ${sideChatSpeaker(entry)} to reply to ${replyTo ? sideChatSpeaker(replyTo) : "an earlier message"}.]`]
        : sameRound ? [] : [`User: ${clip(entry.question, 4_000)}`]),
      `${sideChatSpeaker(entry)}: ${clip(entry.answer, 6_000)}`
    ];
    if (sameRound) blocks[blocks.length - 1] += `\n\n${lines.join("\n\n")}`;
    else blocks.push(lines.join("\n\n"));
    previousRound = entry.roundId;
  }
  const kept: string[] = [];
  let size = 0;
  for (const block of blocks.reverse()) {
    if (kept.length && size + block.length > maxChars) break;
    kept.unshift(block);
    size += block.length + 2;
  }
  return `${kept.length < blocks.length ? "[Earlier messages omitted.]\n\n" : ""}${kept.join("\n\n")}`;
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
