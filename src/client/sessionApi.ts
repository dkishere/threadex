import type { GrillIssue, TurnGrill } from "../turnGrill";
import { apiJson } from "./apiClient";

export type SessionSideChat = {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  model: string;
  created: string;
};

export function turnGrillUrl(sessionId: string, turnId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/grill`;
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

export async function askSession(body: { sessionId: string; question: string; model: string; modelReasoningEffort: string }) {
  return (await apiJson<{ sideChat: SessionSideChat }>("/api/session-inspector/ask", { method: "POST", body })).sideChat;
}
