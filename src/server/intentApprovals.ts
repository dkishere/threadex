import { randomUUID } from "node:crypto";
import { INTENT_APPROVAL_METHOD, intentApprovalMessage, intentDecision, intentRequest, type IntentRequest, type IntentDecision } from "../intentApproval";

export type IntentApproval = {
  approvalId: string; requestId: string; sessionId: string; turnId: string;
  method: string; params: IntentRequest; createdAt: string;
};
type Result = { pending: true } | { decision: IntentDecision | "cancel"; grantId?: string; error?: string };
type Entry = { approval: IntentApproval; result: Result; busy: boolean; timer: ReturnType<typeof setTimeout> };
type Dependencies = {
  active: (sessionId: string, turnId: string) => Promise<boolean>;
  publish: (approval: IntentApproval, event: string, decision?: unknown, error?: string) => Promise<void>;
  deliver: (approval: IntentApproval, message: string) => Promise<void>;
  pending: (approval: IntentApproval, pending: boolean) => void;
};

/** Host-owned decisions. The caller can propose scope but cannot supply a grant. */
export class IntentApprovals {
  private entries = new Map<string, Entry>();
  constructor(private deps: Dependencies, private waitMs = 10 * 60_000) {}

  async request(sessionId: string, turnId: string, value: unknown) {
    const params = intentRequest(value);
    if (!params) throw new Error("Invalid intention: specify title, scope, actions, exclusions and consequences.");
    if (!await this.deps.active(sessionId, turnId)) throw new Error("The requested Codex turn is no longer active.");
    const matching = [...this.entries.values()].find(e => e.approval.sessionId === sessionId && e.approval.turnId === turnId
      && ("pending" in e.result || e.result.decision !== "cancel")
      && JSON.stringify(e.approval.params) === JSON.stringify(params));
    if (matching) return { approvalId: matching.approval.approvalId };
    if ([...this.entries.values()].some(e => e.approval.turnId === turnId && "pending" in e.result)) throw new Error("A different intention is already waiting in this turn. Resolve or cancel that card before changing its scope.");
    const approvalId = randomUUID();
    const approval: IntentApproval = { approvalId, requestId: approvalId, sessionId, turnId,
      method: INTENT_APPROVAL_METHOD, params, createdAt: new Date().toISOString() };
    const entry: Entry = { approval, result: { pending: true }, busy: false,
      timer: setTimeout(() => { if (!entry.busy) void this.finish(entry, "cancel", "Approval expired.").catch(() => undefined); }, this.waitMs) };
    entry.timer.unref();
    this.entries.set(approvalId, entry);
    try {
      this.deps.pending(approval, true);
      await this.deps.publish(approval, "approval.requested");
    } catch (error) {
      clearTimeout(entry.timer); this.entries.delete(approvalId); this.deps.pending(approval, false); throw error;
    }
    return { approvalId };
  }

  async result(id: string): Promise<Result> {
    const entry = this.entries.get(id);
    if (!entry) return { decision: "cancel", error: "Approval is unavailable or expired; no authorization granted." };
    if (!await this.deps.active(entry.approval.sessionId, entry.approval.turnId)) {
      if ("pending" in entry.result && !entry.busy) await this.finish(entry, "cancel", "Turn ended.");
      return { decision: "cancel", error: "Turn ended; this intention grant is expired." };
    }
    return entry.result;
  }

  async decide(id: string, value: unknown) {
    const entry = this.entries.get(id);
    if (!entry || entry.busy || !("pending" in entry.result)) throw new Error("Approval is no longer pending.");
    const decision = intentDecision(value, entry.approval.params);
    if (!decision) throw new Error("Invalid decision: selected actions must be a subset of the request.");
    entry.busy = true;
    clearTimeout(entry.timer);
    try {
      if (Date.now() - Date.parse(entry.approval.createdAt) >= this.waitMs) throw new Error("Approval expired.");
      if (!await this.deps.active(entry.approval.sessionId, entry.approval.turnId)) throw new Error("Turn ended; approval was not delivered.");
      // Persist the exact click before injecting it as user input. A tool result alone is not authorization.
      await this.deps.publish(entry.approval, "approval.decision", decision);
      if (decision !== "cancel") await this.deps.deliver(entry.approval,
        intentApprovalMessage(id, entry.approval.turnId, entry.approval.params, decision));
      await this.finish(entry, decision);
    } catch (error) {
      await this.finish(entry, "cancel", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async finish(entry: Entry, decision: IntentDecision | "cancel", error?: string) {
    if (!("pending" in entry.result)) return;
    entry.busy = true;
    clearTimeout(entry.timer);
    this.deps.pending(entry.approval, false);
    const cleanup = setTimeout(() => this.entries.delete(entry.approval.approvalId), this.waitMs);
    cleanup.unref();
    try {
      await this.deps.publish(entry.approval, "approval.resolved", decision, error);
      entry.result = { decision, ...(decision !== "cancel" && decision.outcome === "approved" ? { grantId: entry.approval.approvalId } : {}), ...(error ? { error } : {}) };
    } catch (failure) {
      entry.result = { decision: "cancel", error: "Could not persist the final decision. No grant returned." };
      throw failure;
    }
  }
}
