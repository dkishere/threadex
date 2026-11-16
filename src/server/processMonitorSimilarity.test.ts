import assert from "node:assert/strict";
import test from "node:test";
import type { Decision, DecisionRequest } from "./decision/types";
import { findSimilarProcessMonitors, similarMonitorApprovalCovers } from "./processMonitorSimilarity";
import type { ProcessMonitorRecord } from "./sessionStore";

const policy = { order: ["fake" as const], threshold: { fake: 0.6 } };

function monitorRecord(overrides: Partial<ProcessMonitorRecord> & Pick<ProcessMonitorRecord, "id" | "label">): ProcessMonitorRecord {
  return {
    workspaceId: "workspace", command: null, executable: "/usr/bin/node", dockerImage: null, dockerRunArgs: [], args: ["server.js"],
    logFile: null, entryPoints: [], metricMonitors: [], metricReadings: [], cwd: "/repo", pid: 10, status: "running",
    sourceCommandId: null, parameters: [], parameterValues: {}, managed: true, removeOnExit: false, wakePrompt: null,
    wakeSessionId: null, wakeThreadId: null, timeoutAt: null, wakeStatus: "none", wakeError: null, wokenAt: null,
    startedAt: null, lastExitCode: null, lastSignal: null, error: null, created: "", updated: "", ...overrides
  } as ProcessMonitorRecord;
}

function decisionAnswering(probabilities: Record<string, number>, requests: DecisionRequest[] = []): Decision {
  return async (request) => {
    requests.push(request);
    return {
      ok: true, backend: "fake", model: "fake", calibrated: false, latencyMs: 1,
      answers: Object.fromEntries(request.questions.map((question) => [question.id, { kind: "predicate" as const, probability: probabilities[question.id] ?? 0 }]))
    };
  };
}

test("same endpoints and identical launches are similar without consulting Decision", async () => {
  const requests: DecisionRequest[] = [];
  const similar = await findSimilarProcessMonitors({
    workspaceId: "workspace", sessionId: "session",
    requested: { label: "Workbench again", exe: "/usr/bin/node", args: ["other.js"], entryPoints: ["http://localhost:8084/__bdd/"] },
    existing: [
      monitorRecord({ id: "workbench", label: "Workbench", entryPoints: ["http://127.0.0.1:8084/"] }),
      monitorRecord({ id: "same-launch", label: "Same launch", args: ["other.js"] })
    ],
    decide: decisionAnswering({}, requests), policy
  });
  assert.deepEqual(similar.map((monitor) => [monitor.id, monitor.reason]), [["workbench", "same_endpoint"], ["same-launch", "same_launch"]]);
  assert.equal(requests.length, 0);
});

test("Decision flags semantically similar monitors above the backend threshold and ignores finished one-off runs", async () => {
  const requests: DecisionRequest[] = [];
  const similar = await findSimilarProcessMonitors({
    workspaceId: "workspace", sessionId: "session",
    requested: { label: "Recruitment preview", exe: "/usr/bin/node", args: ["preview.js", "--case", "cd"] },
    existing: [
      monitorRecord({ id: "preview", label: "Recruitment CD preview", args: ["preview.js"] }),
      monitorRecord({ id: "unrelated", label: "Dashboard", args: ["dashboard.js"] }),
      monitorRecord({ id: "finished-test", label: "Old verification", status: "exited", removeOnExit: true, pid: null })
    ],
    decide: decisionAnswering({ m0: 0.9, m1: 0.2 }, requests), policy
  });
  assert.deepEqual(similar.map((monitor) => [monitor.id, monitor.reason, monitor.probability]), [["preview", "decision", 0.9]]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].purpose, "process_monitor_duplicate");
  assert.equal(requests[0].questions.length, 2);
  assert.doesNotMatch(requests[0].state, /Old verification/);
});

test("a failed Decision never blocks a launch beyond deterministic matches", async () => {
  const similar = await findSimilarProcessMonitors({
    workspaceId: "workspace",
    requested: { label: "New service", exe: "/usr/bin/node", args: ["new.js"] },
    existing: [monitorRecord({ id: "service", label: "Service" })],
    decide: async () => ({ ok: false, attempts: [{ backend: "fake", reason: "timeout" }] }), policy
  });
  assert.deepEqual(similar, []);
});

test("an approval must cover every similar monitor and carry the user's answer", () => {
  const similar = [{ id: "a", label: "A", status: "running" as const, entryPoints: [], reason: "same_endpoint" as const },
    { id: "b", label: "B", status: "exited" as const, entryPoints: [], reason: "decision" as const }];
  assert.equal(similarMonitorApprovalCovers({ monitorIds: ["a", "b"], userAnswer: "Yes, add a second one" }, similar), true);
  assert.equal(similarMonitorApprovalCovers({ monitorIds: ["a"], userAnswer: "Yes" }, similar), false);
  assert.equal(similarMonitorApprovalCovers({ monitorIds: ["a", "b"], userAnswer: "  " }, similar), false);
  assert.equal(similarMonitorApprovalCovers(undefined, similar), false);
});
