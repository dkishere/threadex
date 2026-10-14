import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RoundtableAttempt } from "../roundtable";

// Keep diagnostics outside ephemeral provider homes. Never record outbound
// configuration/auth. Bound individual payloads, not the lifetime of a run.
function diagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 8000 ? `${value.slice(0, 8000)}… [truncated ${value.length - 8000} chars]` : value;
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return "[nested data omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map(item => diagnosticValue(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (/reasoning|thinking/i.test(String(record.type ?? record.itemType ?? ""))) {
    return { type: record.type ?? record.itemType, id: record.id, activity: "reasoning", chars: JSON.stringify(record).length };
  }
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key,
    /^(?:auth.*|.*api.?key|.*secret.*|.*credential.*|env|headers|access_token|refresh_token|id_token)$/i.test(key)
      ? "[redacted]" : diagnosticValue(item, depth + 1)]));
}

export class RoundtableRunLog {
  readonly attempt: RoundtableAttempt;
  constructor(directory: string, metadata: { sessionId: string; turnId: string; actorId?: string; model: string; effort: string }) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const now = new Date().toISOString();
    this.attempt = { id, logPath: resolve(directory, `${id}.jsonl`), startedAt: now, lastActivityAt: now,
      status: "running", eventCount: 0, lastEvent: "run.started" };
    writeFileSync(this.attempt.logPath, "", { flag: "wx", mode: 0o600 });
    this.append("run.started", metadata);
  }

  append(event: string, data: unknown = {}) {
    const at = new Date().toISOString();
    const payload = JSON.stringify(diagnosticValue(data)) ?? "null";
    appendFileSync(this.attempt.logPath, JSON.stringify({ at, sequence: this.attempt.eventCount + 1, event,
      data: payload.length > 24000 ? { preview: payload.slice(0, 24000), truncated: true } : JSON.parse(payload) }) + "\n");
    this.attempt.lastActivityAt = at;
    this.attempt.lastEvent = event;
    this.attempt.eventCount++;
  }

  providerEvent(provider: "codex" | "claude", value: unknown) {
    const message = value && typeof value === "object" ? value as Record<string, any> : {};
    const event = String(message.method ?? message.type ?? "event");
    // Thinking deltas still establish activity without storing private reasoning.
    const reasoning = /reasoning|thinking/i.test(event) || /thinking/.test(message.event?.delta?.type ?? "");
    this.append(`${provider}.${event}`, reasoning ? { activity: "reasoning", chars: JSON.stringify(message).length } : message);
  }

  finish(status: Exclude<RoundtableAttempt["status"], "running">, error?: string) {
    this.append(`run.${status}`, error ? { error } : {});
    this.attempt.status = status;
    this.attempt.finishedAt = this.attempt.lastActivityAt;
    if (error) this.attempt.error = error;
  }
}

export function interruptRoundtableAttempt(attempt: RoundtableAttempt) {
  if (attempt.status !== "running") return;
  const at = new Date().toISOString();
  const error = "Round table interrupted by a server restart.";
  try { appendFileSync(attempt.logPath, JSON.stringify({ at, event: "run.interrupted", data: { error } }) + "\n"); }
  catch { /* Retain the interrupted state in the database even if the log was removed externally. */ }
  attempt.status = "interrupted";
  attempt.finishedAt = at;
  attempt.error = error;
}
