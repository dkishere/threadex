import assert from "node:assert/strict";
import test from "node:test";
import { domainActorIdentity, domainActorMatchesMention } from "./domainActorIdentity";

test("mentions match displayed character names and registered role names", () => {
  const iris = { id: "threadex-composer-ui", name: "輸入操作與介面體驗" };
  assert.equal(domainActorIdentity(iris).name, "Iris");
  for (const query of ["i", "IRIS", "ris", "輸入", "介面", ""]) {
    assert.equal(domainActorMatchesMention(iris, query), true, query);
  }
  assert.equal(domainActorMatchesMention(iris, "Finn"), false);
  const finn = { name: "Session 組織與任務規劃" };
  assert.equal(domainActorMatchesMention(finn, "fin"), true);
  assert.equal(domainActorMatchesMention(finn, "Session"), true);
  assert.equal(domainActorMatchesMention({ name: "UI" }, "iris"), true);
  assert.equal(domainActorMatchesMention({ name: "Deployment and infrastructure" }, "atlas"), true);
});

test("custom and sub-actor names keep case-insensitive substring matching", () => {
  const sub = { id: "actor_9ace3a31-32e8-4078-8e18-b3819c021423", name: "Manager 與 Session UI" };
  for (const query of ["manager", "SESSION", "UI", "與", ""]) {
    assert.equal(domainActorMatchesMention(sub, query), true, query);
  }
  assert.equal(domainActorMatchesMention(sub, "Iris"), false);
  assert.equal(domainActorMatchesMention({ name: "Custom Reviewer" }, "review"), true);
});

test("hiring platform legacy names do not override custom character names", () => {
  assert.equal(domainActorIdentity({ name: "Fairshot Hiring Platform" }).name, "Mira");
  assert.equal(domainActorIdentity({ name: "Hiring Platform" }).name, "Mira");
  const sakura = { name: "Kinomoto Sakura · Hiring Platform" };
  assert.deepEqual(domainActorIdentity(sakura), { name: sakura.name, role: null });
  assert.equal(domainActorMatchesMention(sakura, "Kinomoto"), true);
});
