// Keep process ownership across the async gap between spawning and persisting
// the PID. Keys are attempt log paths, never reusable turn IDs.
export class RunnerProcessRegistry {
  private attempts = new Map<string, { pid: number | null; stopped: boolean }>();

  constructor(private terminate: (pid: number | null) => boolean) {}

  begin(key: string) {
    const attempt = { pid: null as number | null, stopped: false };
    this.attempts.set(key, attempt);
    return {
      attach: (pid: number | null) => {
        attempt.pid = pid;
        if (attempt.stopped) this.terminate(pid);
      },
      dispose: () => {
        if (this.attempts.get(key) === attempt) this.attempts.delete(key);
      }
    };
  }

  stop(key: string | null, persistedPid: number | null) {
    const attempt = key ? this.attempts.get(key) : undefined;
    if (attempt) attempt.stopped = true;
    return this.terminate(attempt?.pid ?? persistedPid);
  }
}
