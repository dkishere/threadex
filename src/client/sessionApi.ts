import type { GrillIssue, TurnGrill } from "../turnGrill";
import type { RoundtableActor } from "../roundtable";
import type { SideChatActor } from "../sideChatRoom";
import { apiJson } from "./apiClient";

export type SessionSideChat = {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  model: string;
  created: string;
  roundId?: string | null;
  actor?: SideChatActor | null;
  replyToId?: string | null;
};

export function turnGrillUrl(sessionId: string, turnId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/grill`;
}

export function shouldReloadTurnGrill(loaded: boolean, review: TurnGrill | null, revision: number) {
  // Running reviews need a GET even without a new revision: after a server
  // restart, that read recovers the persisted job whose worker was lost.
  return !loaded || review?.status === "running" || revision > (review?.revision ?? 0);
}

export async function loadTurnGrill(url: string, options: { signal?: AbortSignal; fresh?: boolean } = {}) {
  return (await apiJson<{ grill: TurnGrill | null }>(url, options)).grill;
}

export async function updateTurnGrill(url: string, body: {
  action: "start" | "save" | "respond" | "followup" | "ack";
  revision?: number;
  issues?: GrillIssue[];
  prompt?: string;
  observedVersion?: number;
}) {
  return (await apiJson<{ grill: TurnGrill }>(url, { method: "POST", body })).grill;
}

export async function loadSideChats(sessionId: string, signal: AbortSignal) {
  return (await apiJson<{ sideChats: SessionSideChat[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/side-chats`, { signal }
  )).sideChats;
}

export type SideChatJob = {
  id: string; roundId: string; actor: RoundtableActor | null; question: string;
  model: string; effort: string; replyToId?: string;
  status: "running" | "error" | "stopped"; error?: string;
};
export function loadSideChatState(sessionId: string, signal: AbortSignal) {
  return apiJson<{ sideChats: SessionSideChat[]; jobs?: SideChatJob[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/side-chats`, { signal, fresh: true });
}

export function controlSideChat(sessionId: string, jobId: string, action: "stop" | "dismiss") {
  return apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/side-chats/${encodeURIComponent(jobId)}/control`, { method: "POST", body: { action } });
}

export async function askSession(body: {
  requestId?: string;
  sessionId: string; question: string; model: string; modelReasoningEffort: string;
  actor?: RoundtableActor | null; roundId?: string; replyToId?: string; participants?: string[];
}) {
  return apiJson<{ sideChat?: SessionSideChat; jobId?: string }>("/api/session-inspector/ask", { method: "POST", body: { ...body, async: true } });
}
