import { rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  drainRunnerLogEntries,
  initialRunnerLogReadState,
  RunnerLogReplay,
  type IndexedRunnerLogEntry
} from "./runnerLogReader.js";
import type { SessionTurnRecord } from "./sessionStore.js";

type RecoveryTurn = Pick<SessionTurnRecord, "id" | "status" | "runnerPid" | "runnerLogPath">;
type RecoveryDependencies = {
  getTurn: (turnId: string) => Promise<RecoveryTurn | null>;
  applyEntry: (entry: IndexedRunnerLogEntry, logPath: string) => Promise<void>;
};

/** Return whether this running-attempt snapshot no longer needs diagnosis. */
export async function replayRunnerLogForTurn(
  turn: RecoveryTurn,
  dependencies: RecoveryDependencies & { replay: RunnerLogReplay }
): Promise<boolean> {
  const logPath = turn.runnerLogPath;
  if (logPath) {
    await dependencies.replay.replay(logPath, async (entries) => {
      for (const entry of entries) await dependencies.applyEntry(entry, logPath);
    });
  }

  // Overlapping callers share a replay promise, not its callback. Also, a
  // terminal log entry may have failed the attempt/status guard. Only saved
  // state tells every caller whether completion or a retry actually happened.
  const current = await dependencies.getTurn(turn.id);
  return !current || current.status !== "running"
    || current.runnerLogPath !== turn.runnerLogPath
    || current.runnerPid !== turn.runnerPid;
}

/** Apply the entire pending file before removing it; failures remain retryable. */
export async function replayPendingRunnerLog(
  pendingLogPath: string,
  runnerLogDir: string,
  dependencies: RecoveryDependencies
): Promise<number> {
  const logPaths = new Map<string, string>();
  let applied = 0;
  const state = await drainRunnerLogEntries(
    pendingLogPath,
    initialRunnerLogReadState(),
    async (entries) => {
      for (const entry of entries) {
        let logPath = logPaths.get(entry.turnId);
        if (!logPath) {
          const turn = await dependencies.getTurn(entry.turnId);
          // Both files use the same attempt filename, including its UUID.
          // Reuse the saved path only for that attempt: an old pending file
          // must never borrow the path of a newer retry of the same turn.
          logPath = turn?.runnerLogPath && basename(turn.runnerLogPath) === basename(pendingLogPath)
            ? turn.runnerLogPath
            : resolve(runnerLogDir, basename(pendingLogPath));
          logPaths.set(entry.turnId, logPath);
        }
        await dependencies.applyEntry(entry, logPath);
        applied += 1;
      }
    }
  );
  if (state.buffer) throw new Error("Pending runner log has an incomplete trailing entry; keeping it for retry.");
  rmSync(pendingLogPath, { force: true });
  return applied;
}
