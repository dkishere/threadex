import assert from "node:assert/strict";
import test from "node:test";
import { promptOriginTriggerLabel, readPromptOrigin } from "./promptOrigin";

test("reads inter-actor origin from the turn or its request metadata", () => {
  const origin = { kind: "inter-actor", sourceActorId: "a1", sourceActorName: "Ada", sourceSessionId: "tx_1", trigger: "handoff" };
  assert.equal(readPromptOrigin({ promptOrigin: origin })?.sourceActorName, "Ada");
  assert.equal(readPromptOrigin({ requestMetadata: { promptOrigin: origin } })?.sourceSessionId, "tx_1");
});

test("accepts an origin with only an actor, only a session, or both", () => {
  const onlyActor = readPromptOrigin({ requestMetadata: { promptOrigin: { kind: "inter-actor", sourceActorId: "a1", sourceRoundId: "r1", trigger: "decision-dispatch" } } });
  assert.equal(onlyActor?.sourceActorId, "a1");
  assert.equal(onlyActor?.sourceSessionId, undefined);
  assert.equal(onlyActor?.sourceRoundId, "r1");
  assert.equal(onlyActor?.trigger, "decision-dispatch");
  const onlySession = readPromptOrigin({ promptOrigin: { kind: "inter-actor", sourceSessionId: "tx_2", trigger: "manager" } });
  assert.equal(onlySession?.sourceSessionId, "tx_2");
  assert.equal(onlySession?.sourceActorId, undefined);
  const both = readPromptOrigin({ promptOrigin: { kind: "inter-actor", sourceActorId: "a1", sourceSessionId: "tx_3" } });
  assert.equal(both?.sourceActorId, "a1");
  assert.equal(both?.sourceSessionId, "tx_3");
});

test("returns null without actor and session, for wrong kind, and for user prompts", () => {
  assert.equal(readPromptOrigin({ promptOrigin: { kind: "inter-actor", trigger: "handoff", sourceTurnId: "t" } }), null);
  assert.equal(readPromptOrigin({ promptOrigin: { kind: "inter-actor", sourceActorId: "  " } }), null);
  assert.equal(readPromptOrigin({ promptOrigin: { kind: "user", sourceActorId: "a1", sourceSessionId: "tx_1" } }), null);
  assert.equal(readPromptOrigin({ requestMetadata: {} }), null);
  assert.equal(readPromptOrigin(null), null);
});

test("labels every Threadex trigger in text and ignores user turns", () => {
  assert.equal(promptOriginTriggerLabel("session-tool"), "Session msg");
  assert.equal(promptOriginTriggerLabel("decision-dispatch"), "Dispatch");
  assert.equal(promptOriginTriggerLabel(undefined), "Threadex");
  assert.equal(readPromptOrigin({ requestMetadata: {} }), null);
});

test("keeps dispatcherActorId for decision dispatch and tolerates its absence in older records", () => {
  const dispatched = readPromptOrigin({ promptOrigin: { kind: "inter-actor", sourceActorId: "miku", dispatcherActorId: " sakura ", trigger: "decision-dispatch" } });
  assert.equal(dispatched?.sourceActorId, "miku");
  assert.equal(dispatched?.dispatcherActorId, "sakura");
  const legacy = readPromptOrigin({ promptOrigin: { kind: "inter-actor", sourceActorId: "sakura", trigger: "decision-dispatch" } });
  assert.equal(legacy?.sourceActorId, "sakura");
  assert.equal(legacy?.dispatcherActorId, undefined);
});
