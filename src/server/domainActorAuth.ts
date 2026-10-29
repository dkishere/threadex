import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionStore } from "./sessionStore";

/** Opaque turn capabilities supplement, never replace, the stored actor binding.
 * A workItemId issues the capability of one native child running in that session turn. */
export class DomainActorAuth {
  constructor(private readonly store: Pick<SessionStore, "setDomainActorCapability" | "getDomainActorCapability">) {}
  private digest(value: string, workspaceId: string, sessionId: string, turnId: string, workItemId?: string) {
    return createHash("sha256").update(JSON.stringify([workspaceId, sessionId, turnId, ...(workItemId ? [workItemId] : []), value])).digest("hex");
  }
  async issue(workspaceId: string, sessionId: string, turnId: string, workItemId?: string) {
    const value = randomBytes(32).toString("hex");
    await this.store.setDomainActorCapability({ workspaceId, sessionId, turnId, tokenHash: this.digest(value, workspaceId, sessionId, turnId, workItemId),
      ...(workItemId ? { workItemId } : {}) });
    return value;
  }
  async verify(value: unknown, workspaceId: string, sessionId: string, turnId: string, workItemId?: string) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return false;
    const digest = await this.store.getDomainActorCapability({ workspaceId, sessionId, turnId, ...(workItemId ? { workItemId } : {}) });
    return Boolean(digest && /^[a-f0-9]{64}$/.test(digest) &&
      timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(this.digest(value, workspaceId, sessionId, turnId, workItemId), "hex")));
  }
}

export function actorJobSnapshot<T extends { domainActorCapability?: string; actorChildCapabilities?: Record<string, string> }>(job: T): Omit<T, "domainActorCapability" | "actorChildCapabilities"> {
  const { domainActorCapability: _secret, actorChildCapabilities: _childSecrets, ...snapshot } = job;
  return snapshot;
}
