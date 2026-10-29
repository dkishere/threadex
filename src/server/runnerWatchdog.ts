export type RunnerStartupState = {
  runnerPid: number | null;
  runnerStarted: string | null;
  runnerHeartbeat: string | null;
  created: string;
};

/**
 * A turn is persisted as running before its child process is spawned and the
 * PID is attached. Snapshot/status requests must not mistake that short-lived
 * claimed state for an orphaned runner.
 */
export function runnerStartupIsWithinGrace(
  turn: RunnerStartupState,
  now: number,
  startupGraceMs: number
) {
  if (turn.runnerPid !== null || startupGraceMs <= 0) {
    return false;
  }

  const claimedAt = Math.max(
    parseTimestamp(turn.runnerStarted) ?? 0,
    parseTimestamp(turn.runnerHeartbeat) ?? 0,
    parseTimestamp(turn.created) ?? 0
  );
  return claimedAt > 0 && now - claimedAt <= startupGraceMs;
}

/**
 * A claimed turn whose runner was never spawned (no PID, no start, no log) ran
 * nothing, e.g. its server restarted during preparation. Requeue it instead of
 * saving it as user-stopped, which never runs automatically.
 */
export function runnerNeverSpawned(
  turn: Pick<RunnerStartupState, "runnerPid" | "runnerStarted">,
  runnerLogExists: boolean
) {
  return turn.runnerPid === null && turn.runnerStarted === null && !runnerLogExists;
}

function parseTimestamp(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
