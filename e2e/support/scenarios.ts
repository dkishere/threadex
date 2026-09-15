export const scenarioSessions = {
  bootstrap: { id: "e2e-bootstrap", title: "Bootstrap Snapshot" },
  switchAlpha: { id: "e2e-switch-alpha", title: "Concurrent Alpha" },
  switchBeta: { id: "e2e-switch-beta", title: "Concurrent Beta" },
  result: { id: "e2e-terminal-result", title: "Durable Result" },
  pending: { id: "e2e-terminal-pending", title: "Durable Pending" },
  error: { id: "e2e-terminal-error", title: "Durable Error" },
  codex: { id: "e2e-terminal-codex", title: "Durable Codex Completion" },
  queue: { id: "e2e-local-queue", title: "Local Queue" },
  approval: { id: "e2e-approval", title: "Approval Background" },
  events: { id: "e2e-event-cursor", title: "Event Cursor" },
  replay: { id: "e2e-runner-replay", title: "Runner Replay" },
  composerScroll: { id: "e2e-composer-scroll", title: "Composer Scroll" },
  modelGears: { id: "local_e2e-model-gears", title: "Local Model Gears" }
} as const;

export const seededSessions = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `e2e-filler-${String(index + 1).padStart(2, "0")}`,
    title: `Paginated Session ${String(index + 1).padStart(2, "0")}`
  })),
  ...Object.values(scenarioSessions).filter((session) => session.id !== scenarioSessions.composerScroll.id)
];
