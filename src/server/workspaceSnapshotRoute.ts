import type { RequestHandler } from "express";

export function createWorkspaceSnapshotHandler({ readSnapshot, reconcileRunningTurns }: {
  readSnapshot: () => Promise<unknown>;
  reconcileRunningTurns: () => Promise<void>;
}): RequestHandler {
  let reconciliationScheduled = false;
  return async (_req, res) => {
    try {
      const started = performance.now();
      const snapshot = await readSnapshot();
      res.setHeader("Server-Timing", `snapshot;dur=${(performance.now() - started).toFixed(1)}`);
      res.once("finish", () => {
        if (reconciliationScheduled) return;
        reconciliationScheduled = true;
        // Runner recovery can replay entire logs. Send the saved snapshot first;
        // recovery publishes durable events for the client to reconcile afterward.
        setImmediate(() => {
          void Promise.resolve().then(reconcileRunningTurns).catch((error) => {
            console.warn("Background snapshot runner recovery failed:", error);
          }).finally(() => { reconciliationScheduled = false; });
        });
      });
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}
