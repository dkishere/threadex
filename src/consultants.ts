import type { RoundtablePreset } from "./roundtablePresets";

export type ConsultationMode = "question" | "round_table";
export type ConsultationRequest = {
  requestId: string; mode: ConsultationMode; consultantIds: string[]; question: string;
  /** Optional focused evidence; never permission or an instruction to execute work. */
  context?: string;
  trigger?: "on_demand" | "user_requested";
  sourceTurnId?: string;
};
export type ConsultationAnswer = {
  consultant: RoundtablePreset; status: "waiting" | "running" | "done" | "error" | "stopped";
  text: string; error: string | null;
};
export type Consultation = {
  requestId: string; sessionId: string; workspaceId: string; sourceTurnId?: string;
  mode: ConsultationMode; question: string; context: string; trigger: "on_demand" | "user_requested";
  status: "queued" | "running" | "done" | "error" | "stopped";
  answers: ConsultationAnswer[]; synthesis: string | null; error: string | null;
  created: string; updated: string;
};
export const consultantsEndpoint = "/api/consultants";
