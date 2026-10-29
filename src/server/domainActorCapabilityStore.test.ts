import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { SessionStore } from "./sessionStore";
import { DomainActorAuth } from "./domainActorAuth";

test("actor capability verifiers rotate, persist across reopen, and bind exact workspace/session/turn", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const storeId = `/private/tmp/actor-capability-${randomUUID()}`;
  const binding = { workspaceId: "default", sessionId: "actor-session", turnId: "actor-turn" };
  // Fixed public fixtures, not real capabilities. The persistence API never receives the bearer.
  const firstHash = createHash("sha256").update("public-test-bearer-one").digest("hex");
  const rotatedHash = createHash("sha256").update("public-test-bearer-two").digest("hex");
  const store = new SessionStore(storeId);
  let bearer = "";
  let issuedHash = "";
  try {
    await store.ready();
    for (const [sessionId, turnId] of [[binding.sessionId, binding.turnId], ["other-session", "other-turn"]]) {
      await store.upsertSession({ id: sessionId, workspaceId: "default", cwd: "/private/tmp", title: "Capability fixture" });
      await store.recordSessionTurn({ id: turnId, sessionId, userInput: "Fixture", agentResponse: "", tokenIn: 0, tokenOut: 0, status: "running" });
    }
    assert.equal(await store.getDomainActorCapability(binding), null);
    await assert.rejects(store.setDomainActorCapability({ ...binding, tokenHash: "raw-bearer-is-not-a-verifier" }), /SHA256 verifier/);
    await assert.rejects(store.setDomainActorCapability({ ...binding, turnId: "other-turn", tokenHash: firstHash }), /binding was not found/);
    await assert.rejects(store.setDomainActorCapability({ ...binding, workspaceId: "wrong-workspace", tokenHash: firstHash }), /binding was not found/);
    await store.setDomainActorCapability({ ...binding, tokenHash: firstHash });
    assert.equal(await store.getDomainActorCapability(binding), firstHash);
    await store.setDomainActorCapability({ ...binding, tokenHash: rotatedHash });
    assert.equal(await store.getDomainActorCapability(binding), rotatedHash);
    const rows = await store.runSqlQuery({ sql: "SELECT * FROM actor_tool_capability" });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].token_hash, rotatedHash);
    assert.deepEqual(Object.keys(rows.rows[0]).sort(), ["session_id", "token_hash", "turn_id", "updated", "workspace_id"]);
    assert.doesNotMatch(JSON.stringify(rows.rows), /public-test-bearer/);
    const room = await store.getDomainActorRoom("default");
    assert.doesNotMatch(JSON.stringify(room), new RegExp(`${firstHash}|${rotatedHash}|public-test-bearer`));
    bearer = await new DomainActorAuth(store).issue(binding.workspaceId, binding.sessionId, binding.turnId);
    issuedHash = (await store.getDomainActorCapability(binding))!;
    assert.notEqual(issuedHash, bearer);
    const issuedRows = await store.runSqlQuery({ sql: "SELECT * FROM actor_tool_capability" });
    assert.ok(!JSON.stringify(issuedRows.rows).includes(bearer));
  } finally { await store.close(); }
  const reopened = new SessionStore(storeId);
  try {
    await reopened.ready();
    assert.equal(await reopened.getDomainActorCapability(binding), issuedHash);
    const freshAuth = new DomainActorAuth(reopened);
    assert.equal(await freshAuth.verify(bearer, binding.workspaceId, binding.sessionId, binding.turnId), true);
    assert.equal(await freshAuth.verify(bearer, binding.workspaceId, "other-session", binding.turnId), false);
    assert.equal(await freshAuth.verify(bearer, binding.workspaceId, binding.sessionId, "other-turn"), false);
    assert.equal(await freshAuth.verify(bearer, "wrong-workspace", binding.sessionId, binding.turnId), false);
    for (const wrong of [{ ...binding, sessionId: "other-session" }, { ...binding, turnId: "other-turn" }, { ...binding, workspaceId: "wrong-workspace" }]) {
      assert.equal(await reopened.getDomainActorCapability(wrong), null);
    }
    assert.equal((await reopened.getSessionTurn(binding.turnId))?.status, "running");
    await reopened.revokeDomainActorCapability({ ...binding, turnId: "other-turn" });
    assert.equal(await reopened.getDomainActorCapability(binding), issuedHash);
    await reopened.revokeDomainActorCapability(binding);
    assert.equal(await reopened.getDomainActorCapability(binding), null);
    assert.equal(await freshAuth.verify(bearer, binding.workspaceId, binding.sessionId, binding.turnId), false);
  } finally { await reopened.close(); }
});
