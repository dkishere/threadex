/** The two registries retain their own identities and persistence scopes. */
export type ActorType = "worker" | "consultant";
export const ACTOR_TYPE_LABELS: Record<ActorType, string> = { worker: "Workers", consultant: "Consultants" };
export function actorTypeForRegistry(registry: "domain" | "roundtable", value?: unknown): ActorType {
  const expected = registry === "domain" ? "worker" : "consultant";
  if (value !== undefined && value !== expected) throw new Error(`Actor type conflicts with the ${registry} registry; expected ${expected}.`);
  return expected;
}
