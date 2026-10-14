/** Stream durable runner-log progress without waiting for database replay.
 * Terminal events still wait for all preceding updates to be applied.
 */
export class RunnerStreamForwarder<T> {
  private persistence = Promise.resolve();
  private failure: { error: unknown } | undefined;

  constructor(private readonly options: {
    apply: (entry: T) => Promise<void>;
    emit: (entry: T) => void;
    itemKey: (entry: T) => string | null;
    isTerminal: (entry: T) => boolean;
  }) {}

  async forward(entries: T[]): Promise<void> {
    if (this.failure) throw this.failure.error;
    // Preserve replay ordering, showing each item's latest version at its
    // first position rather than flashing all its intermediate snapshots.
    const latestItems = new Map<string, T>();
    for (const entry of entries) {
      const key = this.options.itemKey(entry);
      if (key) latestItems.set(key, entry);
    }
    const sentItems = new Set<string>();
    for (const entry of entries) {
      this.persistence = this.persistence.then(async () => {
        if (!this.failure) await this.options.apply(entry);
      }).catch((error: unknown) => { this.failure = { error }; });

      // The log already contains the progress. Only terminal delivery needs
      // database confirmation (including any error/account annotation).
      if (this.options.isTerminal(entry)) await this.flush();
      const key = this.options.itemKey(entry);
      if (!key) {
        this.options.emit(entry);
      } else if (!sentItems.has(key)) {
        sentItems.add(key);
        this.options.emit(latestItems.get(key) ?? entry);
      }
    }
  }

  async flush(): Promise<void> {
    await this.persistence;
    if (this.failure) throw this.failure.error;
  }
}
