import { randomUUID } from "node:crypto";
import type { Decision, PurposePolicy } from "./decision/types";
import { entryPointOrigins, type MonitorProcessInput } from "./processMonitor";
import type { ProcessMonitorRecord } from "./sessionStore";

export const PROCESS_MONITOR_DUPLICATE_PURPOSE = "process_monitor_duplicate";

export type SimilarProcessMonitor = {
  id: string;
  label: string;
  status: ProcessMonitorRecord["status"];
  entryPoints: string[];
  reason: "same_endpoint" | "same_launch" | "decision";
  probability?: number;
};

/** The user's answer that allows a new monitor despite the listed similar monitors. */
export type SimilarMonitorApproval = { monitorIds: string[]; userAnswer: string };

const maxDecisionCandidates = 24;
const maxStateTextChars = 600;

/**
 * Finds existing monitors that a new launch would duplicate. Only monitors that
 * still matter are compared: live or starting ones, registered commands, and
 * retained services. Finished one-off runs expire on their own and may be re-run.
 */
export async function findSimilarProcessMonitors(input: {
  workspaceId: string;
  sessionId?: string | null;
  requested: MonitorProcessInput;
  existing: ProcessMonitorRecord[];
  decide: Decision;
  policy: PurposePolicy;
}): Promise<SimilarProcessMonitor[]> {
  const candidates = input.existing.filter((monitor) =>
    monitor.status === "running" || monitor.status === "starting" || monitor.status === "available" || !monitor.removeOnExit);
  const requestedOrigins = entryPointOrigins(requestedEntryPoints(input.requested));
  const requestedLaunch = launchIdentity(input.requested);
  const similar: SimilarProcessMonitor[] = [];
  const undecided: ProcessMonitorRecord[] = [];
  for (const monitor of candidates) {
    if ([...entryPointOrigins(monitor.entryPoints)].some((origin) => requestedOrigins.has(origin))) {
      similar.push(similarEntry(monitor, "same_endpoint"));
    } else if (requestedLaunch && requestedLaunch === launchIdentity(monitor)) {
      similar.push(similarEntry(monitor, "same_launch"));
    } else {
      undecided.push(monitor);
    }
  }
  const compared = undecided.slice(0, maxDecisionCandidates);
  if (compared.length === 0) return similar;
  const result = await input.decide({
    purpose: PROCESS_MONITOR_DUPLICATE_PURPOSE,
    audit: { workspaceId: input.workspaceId, workItemId: `process-monitor-duplicate:${randomUUID()}` },
    state: JSON.stringify({
      newProcess: describeProcess(input.requested),
      existingMonitors: compared.map((monitor, index) => ({ key: `m${index}`, ...describeProcess(monitor), status: monitor.status }))
    }),
    questions: compared.map((monitor, index) => ({
      id: `m${index}`,
      kind: "predicate" as const,
      instructions: `Probability that newProcess is the same service or the same job as existing monitor m${index} ("${monitor.label}"), so the agent should restart or reuse that monitor instead of creating another. A different port, target, script or independent task is not the same.`
    }))
  });
  // A failed check never blocks a launch; the deterministic matches still apply.
  if (!result.ok) return similar;
  const threshold = input.policy.threshold[result.backend];
  if (threshold === undefined) return similar;
  compared.forEach((monitor, index) => {
    const answer = result.answers[`m${index}`];
    if (answer?.kind === "predicate" && answer.probability >= threshold) {
      similar.push({ ...similarEntry(monitor, "decision"), probability: answer.probability });
    }
  });
  return similar;
}

/** The approval must name every similar monitor and carry the user's own answer. */
export function similarMonitorApprovalCovers(value: unknown, similar: SimilarProcessMonitor[]): value is SimilarMonitorApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { monitorIds, userAnswer } = value as Record<string, unknown>;
  if (typeof userAnswer !== "string" || !userAnswer.trim() || userAnswer.length > 2_000) return false;
  if (!Array.isArray(monitorIds) || monitorIds.some((id) => typeof id !== "string")) return false;
  const approvedIds = new Set(monitorIds as string[]);
  return similar.every((monitor) => approvedIds.has(monitor.id));
}

export function similarMonitorRejection(similar: SimilarProcessMonitor[]) {
  const listed = similar.map((monitor) => `${monitor.id} "${monitor.label}" (${monitor.status})`).join("; ");
  return `Similar process monitors already exist: ${listed}. Reuse one with restart_process_monitor, run_process_command or adopt_process_monitor instead of adding another. Only if a separate monitor is still required, ask the user with your native ask-user tool, naming these monitors, and retry with similarMonitorApproval: {monitorIds: [every id above], userAnswer: "<the user's exact reply>"}.`;
}

function similarEntry(monitor: ProcessMonitorRecord, reason: SimilarProcessMonitor["reason"]): SimilarProcessMonitor {
  return { id: monitor.id, label: monitor.label, status: monitor.status, entryPoints: monitor.entryPoints, reason };
}

function requestedEntryPoints(requested: MonitorProcessInput) {
  if (Array.isArray(requested.entryPoints)) return requested.entryPoints.filter((value): value is string => typeof value === "string");
  return typeof requested.entryPoint === "string" ? [requested.entryPoint] : [];
}

type LaunchFields = { command?: string | null; exe?: string | null; executable?: string | null; dockerImage?: string | null; image?: string | null; args?: string[] | null; dockerRunArgs?: string[] | null };

function launchIdentity(spec: LaunchFields) {
  const executable = "executable" in spec ? spec.executable : spec.exe;
  const dockerImage = spec.dockerImage ?? spec.image;
  const command = spec.command?.trim();
  if (command) return JSON.stringify(["command", command]);
  if (executable?.trim()) return JSON.stringify(["exe", executable.trim(), spec.args ?? []]);
  if (dockerImage?.trim()) return JSON.stringify(["docker", dockerImage.trim(), spec.dockerRunArgs ?? [], spec.args ?? []]);
  return null;
}

function describeProcess(spec: LaunchFields & { label?: string | null; cwd?: string | null; entryPoints?: string[] | null; entryPoint?: string | null }) {
  const clip = (value: string) => value.length > maxStateTextChars ? `${value.slice(0, maxStateTextChars)}…` : value;
  return {
    label: spec.label ?? "",
    executable: ("executable" in spec ? spec.executable : spec.exe) ?? null,
    command: spec.command ? clip(spec.command) : null,
    dockerImage: spec.dockerImage ?? spec.image ?? null,
    args: (spec.args ?? []).map(clip),
    cwd: spec.cwd ?? null,
    entryPoints: Array.isArray(spec.entryPoints) ? spec.entryPoints : spec.entryPoint ? [spec.entryPoint] : []
  };
}
