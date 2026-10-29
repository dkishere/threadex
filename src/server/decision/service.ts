import type { AutoModelSettings } from "../autoModelSettings";
import type { SessionStore } from "../sessionStore";
import { createDecisionPolicy, DEFAULT_POLICY, type DecisionAudit } from "./policy";
import { jevBackend } from "./jev";
import { openaiBackend } from "./openai";
import { llmBackend, type LlmDecisionRunner } from "./llm";
import type { Decision, DecisionRequest, DecisionResult } from "./types";

export type DecisionPersistence = {
  load(key: string): Promise<DecisionAudit | null>;
  save(key: string, audit: DecisionAudit): Promise<DecisionAudit>;
  usage(key: string, req: DecisionRequest, audit: DecisionAudit): Promise<void>;
};
export function decisionKey(req: DecisionRequest): string | undefined {
  const a = req.audit;
  if (!a.roundId && !a.workItemId && !a.turnId) return;
  return JSON.stringify([a.workspaceId, a.turnId ?? null, a.roundId ?? null, a.workItemId ?? null, req.purpose]);
}

/** The caller gives each dependent decision a distinct purpose/workItemId. Persist failures too. */
export function durableDecision(decide: (audit: (req: DecisionRequest["audit"], entry: DecisionAudit) => Promise<void>) => Decision, storage: DecisionPersistence): Decision {
  const running = new Map<string, Promise<DecisionResult>>();
  return req => {
    const key = decisionKey(req);
    if (!key) throw new Error("A durable Decision requires a turn, round or work item ID.");
    const existing = running.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const saved = await storage.load(key);
      if (saved) { await storage.usage(key, req, saved); return saved.result; }
      let persisted: DecisionAudit | undefined;
      await decide(async (_audit, entry) => {
        persisted = await storage.save(key, entry);
        await storage.usage(key, req, persisted);
      })(req);
      if (!persisted) throw new Error("Decision was not persisted.");
      return persisted.result;
    })().finally(() => running.delete(key));
    running.set(key, promise);
    return promise;
  };
}

export function createDecisionService(settings: AutoModelSettings, store: Pick<SessionStore, "getDecisionRecord" | "saveDecisionRecord" | "recordTokenUsage">, runLlm?: LlmDecisionRunner): Decision {
  return durableDecision(audit => createDecisionPolicy({
    backends: [jevBackend({ apiKey: settings.backendKey("jev") }), openaiBackend({ apiKey: settings.backendKey("openai") }), llmBackend(runLlm)],
    policy: purpose => settings.policies()[purpose] ?? DEFAULT_POLICY,
    audit
  }), {
    load: key => store.getDecisionRecord(key),
    save: (key, entry) => store.saveDecisionRecord(key, entry),
    async usage(key, req, entry) {
      const result = entry.result;
      if (entry.usage?.length) {
        await store.recordTokenUsage(entry.usage.map(usage => ({
          id: `decision:${key}:attempt:${usage.attempt}`, usageType: "decision", source: usage.backend,
          workspaceId: req.audit.workspaceId, turnId: req.audit.turnId, model: usage.model,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          metadata: { purpose: entry.purpose, attempt: usage.attempt, result: entry.result, attempts: entry.attempts }
        })));
        return;
      }
      // Legacy audits have only final-result usage; keep their existing row identity.
      await store.recordTokenUsage([{
        id: `decision:${key}`, usageType: "decision", source: result.ok ? result.backend : "failed",
        workspaceId: req.audit.workspaceId, turnId: req.audit.turnId,
        model: result.ok ? result.model : null,
        ...(result.ok && result.usage ? result.usage : {}),
        totalTokens: result.ok && result.usage ? result.usage.inputTokens + result.usage.outputTokens : 0,
        metadata: entry
      }]);
    }
  });
}
