import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const outputMirrorMarker = "__threadexSupervisorOutputMirrored";

/**
 * Mirrors a process's existing stdout and stderr to a logfile without changing
 * their original destinations. Supervisors that already tee child output set
 * SESSION_SUPERVISOR_LOG_CAPTURE to avoid capturing every line twice.
 */
export function mirrorProcessOutputToFile(logFile: string) {
  const runtime = globalThis as typeof globalThis & Record<string, unknown>;
  if (runtime[outputMirrorMarker] || process.env.SESSION_SUPERVISOR_LOG_CAPTURE === "1") return;
  runtime[outputMirrorMarker] = true;
  mkdirSync(dirname(logFile), { recursive: true });

  for (const stream of [process.stdout, process.stderr]) {
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      try {
        appendFileSync(logFile, chunk);
      } catch {
        // Logging must never prevent the development server from writing output.
      }
      return originalWrite(chunk, ...(args as any[]));
    }) as typeof stream.write;
  }
}
