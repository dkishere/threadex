import assert from "node:assert/strict";
import test from "node:test";
import type { CollaborationGroup } from "../collaboration";
import { CollaborationService } from "./collaborationService";
import type { SessionStore, SessionTurnRecord } from "./sessionStore";

for (const resolution of ["completed", "cancelled"] as const) {
  test(`collect revisits a waiting checkpoint after its dependency is ${resolution}`, async () => {
    const group = {
      id: "group", mainSessionId: "main", results: [],
      members: ["main", "c1", "c2"].map(localId => ({ localId, sessionId: localId, observed: {}, stopped: false })),
      messages: [
        { id: "dependency", from: "c1", to: "main", sourceTurnId: "c1-turn", wait: true, completed: false, state: "delivered" },
        { id: "baseline", from: "c2", to: "c1", targetTurnId: "c1-turn", wait: true, completed: false, state: "delivered", depth: 0 }
      ]
    } as unknown as CollaborationGroup;
    const store = {
      listSessionTurns: async (id: string) => id === "c1" ? [
        { id: "c1-turn", status: "done", agentResponse: "Baseline finished", runnerExitCode: 0 }
      ] as SessionTurnRecord[] : [],
      changeCollaboration: async (_id: string, _revision: unknown, change: (value: CollaborationGroup) => unknown) => change(group),
      inspectSession: async () => ({ fileChanges: [] }),
    } as unknown as SessionStore;
    const service = new CollaborationService(store, "http://unused", () => []);
    const collect = () => (service as unknown as { collect(group: CollaborationGroup): Promise<void> }).collect(structuredClone(group));
    await collect();
    assert.equal(group.results.length, 0);
    assert.ok(group.members[1].observed["c1-turn"], "checkpoint was already fingerprinted");
    assert.equal(group.messages[1].completed, false);
    if (resolution === "completed") group.messages[0].completed = true;
    else group.messages[0].state = "cancelled";
    await collect();
    assert.equal(group.results.length, 1);
    assert.equal(group.results[0].summary, "Baseline finished");
    assert.equal(group.messages[1].completed, true, "C2 no longer waits on C1");
    assert.ok(group.messages.some(m => m.kind === "result" && m.to === "c2"));
    const count = group.messages.length;
    await collect();
    assert.equal(group.results.length, 1);
    assert.equal(group.messages.length, count, "repeated collection does not resend results");
  });
}
