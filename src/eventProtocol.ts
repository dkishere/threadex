// Keep the browser subscription and server projection in sync. Transcript
// items and raw Codex notifications are delivered by the runner SSE stream.
export const CLIENT_EVENT_TYPES = [
  "runner.session",
  "runner.runner.started",
  "runner.developer_instructions",
  "runner.result",
  "runner.pending",
  "runner.error",
  "runner.done",
  "runner.runner.callback_error",
  "runner.approval.requested",
  "runner.approval.resolved",
  "session.imported",
  "session.task.created",
  "session.title.updated",
  "todo.changed",
  "workspace.created",
  "workspace.switched"
] as const;

export const EVENT_STATE_FIELDS = ["statusMonitor", "processMonitors", "grillSummaries", "waitEvents", "waitSubscriptions"] as const;
export type EventStateVersions = Record<typeof EVENT_STATE_FIELDS[number], string>;

export function encodeEventStateVersions(versions: EventStateVersions): string {
  return EVENT_STATE_FIELDS.map((field) => versions[field]).join(".");
}
