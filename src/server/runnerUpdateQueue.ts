/** Serialize runner state changes and ignore successful duplicate deliveries.
 * The UI ring is deliberately small and coalesces items, so it cannot be used
 * as the application deduplication history for callbacks and stream replays.
 */
export class RunnerUpdateQueue {
  private tail = Promise.resolve();
  private applied = new Set<string>();

  constructor(private readonly capacity = 100_000) {}

  run(id: string, apply: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      if (this.applied.has(id)) return;
      await apply();
      this.applied.add(id);
      if (this.applied.size > this.capacity) {
        this.applied.delete(this.applied.values().next().value!);
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
