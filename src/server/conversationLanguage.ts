/**
 * The language a session's user writes in, by majority vote over their messages.
 * Background helpers (summary titles, Grill) answer in this language rather than
 * in the language of a single short message such as "go" or "ok".
 */
export function detectConversationLanguage(userMessages: string[]) {
  const votes = new Map<string, number>();
  for (const message of userMessages) {
    const text = message.trim();
    if (!text || text.startsWith("Threadex commentary issue follow-up")) continue;
    // Technical English names and brief acknowledgements are common in CJK
    // conversations. They must not switch the language of the whole session.
    const language = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? "Japanese"
      : /\p{Script=Hangul}/u.test(text) ? "Korean"
      : /\p{Script=Han}/u.test(text) ? "Traditional Chinese/Cantonese"
      : text.split(/\s+/u).length >= 5 ? "English" : null;
    if (language) votes.set(language, (votes.get(language) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "English";
}
