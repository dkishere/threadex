import assert from "node:assert/strict";
import test from "node:test";
import { actorTypeForRegistry } from "../actorTypes";
import { emptyActorRoom, type DomainActor } from "../domainActors";
import { parseRoundtablePresets } from "../roundtablePresets";
import { DEFAULT_MODEL } from "../modelCatalog";
import { normalizeWorkerTypes, DomainActorStore, type ActorPersistence } from "./domainActorStore";

test("legacy libraries map to consultants idempotently, preserving identity and configuration", () => {
  const legacy = { id: "critic", name: "Critic", model: DEFAULT_MODEL, effort: "high", rolePrompt: "Role", isDefault: true };
  const mapped = parseRoundtablePresets([legacy]);
  assert.deepEqual(mapped, [{ ...legacy, type: "consultant" }]);
  assert.deepEqual(parseRoundtablePresets(mapped), mapped);
  assert.equal(actorTypeForRegistry("roundtable"), "consultant");
  assert.throws(() => parseRoundtablePresets([{ ...legacy, type: "worker" }]), /conflicts/);
  assert.equal("type" in legacy, false);
});

test("legacy worker mapping preserves tree, memory, settings, work links and revision", async () => {
  const room = emptyActorRoom("workspace"); room.revision = 7;
  const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent", version: 3, sourceEventIds: ["event"] };
  room.actors = [{ id: "root", workspaceId: "workspace", rootActorId: "root", parentActorId: null,
    name: "Worker", model: DEFAULT_MODEL, effort: "high", allowedModels: [DEFAULT_MODEL], memory, created: "before", updated: "before" }];
  const original = structuredClone(room);
  let writes = 0;
  const persistence = { getWorkspace: async () => ({ id: "workspace" }), getDomainActorRoom: async () => structuredClone(room),
    changeDomainActorRoom: async (_id: string, mutate: (current: typeof room) => unknown) => { writes++; return mutate(room); }
  } as unknown as ActorPersistence;
  const store = new DomainActorStore(persistence);
  for (let count = 0; count < 2; count++) assert.deepEqual(await store.getRoom("workspace"), { ...original, actors: [{ ...original.actors[0], type: "worker" }] });
  assert.equal(writes, 0, "read normalization does not rewrite persisted legacy data");
  await store.change("workspace", () => {});
  assert.equal(room.actors[0].type, "worker"); assert.equal(room.revision, 7); assert.deepEqual(room.actors[0].memory, memory);
  const before = structuredClone(room);
  normalizeWorkerTypes(room); assert.deepEqual(room, before);
  await assert.rejects(store.update("workspace", "root", { type: "consultant" } as never), /conflicts/);
  assert.deepEqual(room, before);
});

test("conflicting worker records reject before any actor is changed", () => {
  const room = emptyActorRoom("workspace");
  room.actors = [{ id: "valid" }, { id: "contradiction", type: "consultant" }] as unknown as DomainActor[];
  const original = structuredClone(room);
  assert.throws(() => normalizeWorkerTypes(room), /conflicts/); assert.deepEqual(room, original);
});
