import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const runnerLogReadChunkBytes = 1024 * 1024;
const runnerLogMaxLineChars = 2 * 1024 * 1024;
const runnerLogSkipOversizedLine = "\0skip-oversized-runner-log-line";

export type RunnerLogEntry = {
  id: string;
  ts: string;
  jsonlIndex?: number;
  sessionId: string;
  turnId: string;
  event: string;
  data: unknown;
};

export type IndexedRunnerLogEntry = RunnerLogEntry & {
  jsonlIndex: number;
};

export type RunnerLogReadState = {
  offset: number;
  buffer: string;
  jsonlIndex: number;
};

export type RunnerLogReadResult = RunnerLogReadState & {
  items: IndexedRunnerLogEntry[];
};

export type RunnerLogReadOptions = {
  chunkBytes?: number;
};

export type RunnerLogApplicationMode = "live" | "replay";

export function shouldRefreshRunnerHeartbeat(mode: RunnerLogApplicationMode): boolean {
  return mode === "live";
}

export type RunnerLogEntriesCallback = (
  entries: IndexedRunnerLogEntry[]
) => void | Promise<void>;

export function initialRunnerLogReadState(): RunnerLogReadState {
  return { offset: 0, buffer: "", jsonlIndex: 0 };
}

/** Keep watchdog recovery incremental, including when status requests overlap. */
export class RunnerLogReplay {
  private states = new Map<string, RunnerLogReadState>();
  private pending = new Map<string, Promise<void>>();

  replay(logPath: string, onEntries: RunnerLogEntriesCallback): Promise<void> {
    const pending = this.pending.get(logPath);
    if (pending) return pending;
    const operation = this.drain(logPath, onEntries).finally(() => {
      this.pending.delete(logPath);
    });
    this.pending.set(logPath, operation);
    return operation;
  }

  private async drain(logPath: string, onEntries: RunnerLogEntriesCallback) {
    let state = this.states.get(logPath) ?? initialRunnerLogReadState();
    if (existsSync(logPath) && statSync(logPath).size < state.offset) {
      state = initialRunnerLogReadState();
    }
    // Bound each pass to the bytes present at its start so a busy runner cannot
    // keep a watchdog pass alive indefinitely.
    const end = existsSync(logPath) ? statSync(logPath).size : 0;
    while (state.offset < end) {
      const result = readNewRunnerEntries(logPath, state.offset, state.buffer, state.jsonlIndex);
      if (result.offset === state.offset) break;
      if (result.items.length) await onEntries(result.items);
      state = { offset: result.offset, buffer: result.buffer, jsonlIndex: result.jsonlIndex };
      this.states.delete(logPath);
      this.states.set(logPath, state);
    }
    // Retain recent completed logs too: late status requests must not restart
    // their replay. Never evict a log while another pass is processing it.
    for (const path of this.states.keys()) {
      if (this.states.size <= 256) break;
      if (!this.pending.has(path) && path !== logPath) this.states.delete(path);
    }
  }
}

export function readNewRunnerEntries(
  logPath: string,
  offset: number,
  buffer: string,
  jsonlIndex = 0,
  options: RunnerLogReadOptions = {}
): RunnerLogReadResult {
  if (!existsSync(logPath)) {
    return { offset, buffer, jsonlIndex, items: [] };
  }

  const size = statSync(logPath).size;
  if (size <= offset) {
    return { offset, buffer, jsonlIndex, items: [] };
  }

  const chunkBytes = readChunkBytes(options);
  const fd = openSync(logPath, "r");
  try {
    const chunk = Buffer.alloc(Math.min(size - offset, chunkBytes));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
    const nextOffset = offset + bytesRead;
    let chunkText = chunk.subarray(0, bytesRead).toString("utf8");
    let raw: string;
    const skippedLine = buffer === runnerLogSkipOversizedLine;
    if (skippedLine) {
      const lineEnd = chunkText.indexOf("\n");
      if (lineEnd === -1) {
        return { offset: nextOffset, buffer: runnerLogSkipOversizedLine, jsonlIndex, items: [] };
      }
      chunkText = chunkText.slice(lineEnd + 1);
      raw = chunkText;
    } else {
      raw = buffer + chunkText;
    }

    if (!raw.includes("\n") && raw.length > runnerLogMaxLineChars) {
      return { offset: nextOffset, buffer: runnerLogSkipOversizedLine, jsonlIndex, items: [] };
    }

    const lines = raw.split("\n");
    let nextBuffer = lines.pop() ?? "";
    if (nextBuffer.length > runnerLogMaxLineChars) {
      nextBuffer = runnerLogSkipOversizedLine;
    }
    const items = lines.flatMap((line, lineOffset) => {
      if (line.length > runnerLogMaxLineChars) {
        return [];
      }
      try {
        const entry = JSON.parse(line) as RunnerLogEntry;
        const entryJsonlIndex = typeof entry.jsonlIndex === "number" ? entry.jsonlIndex : jsonlIndex + lineOffset;
        return [{ ...entry, jsonlIndex: entryJsonlIndex }];
      } catch {
        return [];
      }
    });
    return { offset: nextOffset, buffer: nextBuffer, jsonlIndex: jsonlIndex + lines.length, items };
  } finally {
    closeSync(fd);
  }
}

export async function drainRunnerLogEntries(
  logPath: string,
  state: RunnerLogReadState,
  onEntries: RunnerLogEntriesCallback,
  options: RunnerLogReadOptions = {}
): Promise<RunnerLogReadState> {
  let currentState = { ...state };

  while (true) {
    const result = readNewRunnerEntries(
      logPath,
      currentState.offset,
      currentState.buffer,
      currentState.jsonlIndex,
      options
    );
    const reachedEnd = result.offset === currentState.offset;
    currentState = {
      offset: result.offset,
      buffer: result.buffer,
      jsonlIndex: result.jsonlIndex
    };

    if (result.items.length > 0) {
      await onEntries(result.items);
    }
    if (reachedEnd) {
      return currentState;
    }
  }
}

function readChunkBytes(options: RunnerLogReadOptions) {
  const chunkBytes = options.chunkBytes ?? runnerLogReadChunkBytes;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new RangeError("Runner log chunkBytes must be a positive safe integer.");
  }
  return chunkBytes;
}
