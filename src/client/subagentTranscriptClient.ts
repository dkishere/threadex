import {
  parseSubagentTranscriptPayload,
  type SubagentTranscriptPayload,
} from "./subagentTranscript";

type CacheEntry =
  | { status: "loading"; promise: Promise<SubagentTranscriptPayload> }
  | { status: "loaded"; payload: SubagentTranscriptPayload }
  | { status: "error"; error: Error };

const transcriptCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 128;

function cacheKey(sessionId: string, threadId: string) {
  return `${sessionId}:${threadId}`;
}

export async function fetchSubagentTranscript(
  sessionId: string,
  threadId: string,
  force = false,
): Promise<SubagentTranscriptPayload> {
  const key = cacheKey(sessionId, threadId);
  const cached = transcriptCache.get(key);

  if (!force && cached) {
    if (cached.status === "loaded") return cached.payload;
    if (cached.status === "loading") return cached.promise;
    throw cached.error;
  }

  const promise = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(threadId)}/transcript`,
    { cache: "no-store" },
  ).then(async (response) => {
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : "";
      throw new Error(message || `Subagent transcript API returned ${response.status}`);
    }

    const payload = parseSubagentTranscriptPayload(body);
    if (payload.sessionId !== sessionId || payload.threadId !== threadId) {
      throw new Error("The subagent transcript response did not match this child thread.");
    }
    return payload;
  });

  transcriptCache.set(key, { status: "loading", promise });
  try {
    const payload = await promise;
    transcriptCache.set(key, { status: "loaded", payload });
    if (transcriptCache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = transcriptCache.keys().next().value;
      if (oldestKey !== undefined) transcriptCache.delete(oldestKey);
    }
    return payload;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Could not load the subagent transcript.");
    transcriptCache.set(key, { status: "error", error: normalized });
    throw normalized;
  }
}
