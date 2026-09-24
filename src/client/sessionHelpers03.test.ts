import assert from "node:assert/strict";
import test from "node:test";
import { developerInstructionRecordFromPayload, mergeDeveloperInstructionRecords, promptDisplayMetadata, sessionTurnsToMessages, turnDurationMs } from "./sessionHelpers03";

test("developer-instruction groups merge without an extra array layer", () => {
  const instructions = mergeDeveloperInstructionRecords({
    developerInstructionRecordFromPayload: (payload: unknown) => developerInstructionRecordFromPayload({}, payload)
  }, undefined, [{
    target: "turn",
    phase: 0,
    developerInstructions: "[SERVER-PROVIDED CONTEXT FORK REQUEST]"
  }]);

  assert.equal(instructions.length, 1);
  assert.equal(instructions[0]?.developerInstructions, "[SERVER-PROVIDED CONTEXT FORK REQUEST]");
});

test("session snapshots restore persisted steer messages and their prompt count source", () => {
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: (_snapshot: unknown[], _existing: unknown[], steers: Array<{ id: string; content: string }>) =>
      steers.map((steer) => ({ id: `steer:${steer.id}`, type: "steer", text: steer.content })),
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => undefined
  }, [{
    id: "turn-1",
    userInput: "Original prompt",
    agentResponse: "",
    status: "running",
    created: "2026-08-25T10:00:00.000Z",
    steerMessages: [{
      id: "steer-1",
      content: "Keep the old API working.",
      forcePlan: true,
      created: "2026-08-25T10:01:00.000Z"
    }]
  }], "Restored session", [], undefined);

  const steers = messages.filter((message: { kind?: string }) => message.kind === "steer");
  assert.equal(steers.length, 1);
  assert.deepEqual(steers.map((message: { id: string }) => message.id), ["steer-1"]);
  assert.equal(messages.find((message: { role: string }) => message.role === "assistant")?.segments?.length, 1);
});

test("session snapshots carry per-turn run metadata onto the prompt", () => {
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: () => [],
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => 3_750
  }, [{
    id: "turn-usage",
    userInput: "Show the run details",
    agentResponse: "Done",
    model: "gpt-5.6-terra",
    reasoningEffort: "xhigh",
    tokenIn: 1_250,
    usageSample: { cachedInputTokens: 900 },
    tokenOut: 375,
    autoModelProvider: "typesafe",
    autoModelConfidence: 0.2,
    status: "done",
    created: "2026-08-25T10:00:00.000Z"
  }], "Run metadata", [], undefined);

  const prompt = messages.find((message: { role: string }) => message.role === "user");
  assert.deepEqual({
    model: prompt?.model,
    reasoningEffort: prompt?.reasoningEffort,
    tokenIn: prompt?.tokenIn,
    cachedInputTokens: prompt?.cachedInputTokens,
    tokenOut: prompt?.tokenOut,
    executionDurationMs: prompt?.executionDurationMs,
    turnStatus: prompt?.turnStatus,
    autoModel: prompt?.autoModel,
    autoModelProvider: prompt?.autoModelProvider,
    autoModelConfidence: prompt?.autoModelConfidence
  }, {
    model: "gpt-5.6-terra",
    reasoningEffort: "xhigh",
    tokenIn: 1_250,
    cachedInputTokens: 900,
    tokenOut: 375,
    executionDurationMs: 3_750,
    turnStatus: "done",
    autoModel: true,
    autoModelProvider: "typesafe",
    autoModelConfidence: 0.2
  });
});

test("runner-reported duration takes priority over unreliable lifecycle timestamps", () => {
  assert.equal(turnDurationMs({}, {
    executionDurationMs: 311_296,
    runnerStarted: "2026-09-03T08:35:12.173Z",
    runnerHeartbeat: "2026-09-03T08:35:19.567Z"
  }), 311_296);
});

test("persisted steer messages replace a matching optimistic copy", () => {
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: (_snapshot: unknown[], _existing: unknown[], steers: Array<{ id: string; content: string }>) =>
      steers.map((steer) => ({ id: `steer:${steer.id}`, type: "steer", text: steer.content })),
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => undefined
  }, [{
    id: "turn-1",
    userInput: "Original prompt",
    agentResponse: "",
    status: "running",
    created: "2026-08-25T10:00:00.000Z",
    steerMessages: [{ id: "steer-1", content: "Persisted version", created: "2026-08-25T10:01:00.000Z" }]
  }], "Restored session", [{
    id: "steer-1",
    role: "user",
    kind: "steer",
    turnId: "turn-1",
    content: "Optimistic version"
  }] as never[], undefined);

  const steers = messages.filter((message: { kind?: string }) => message.kind === "steer");
  assert.deepEqual(steers.map((message: { id: string; content: string }) => [message.id, message.content]), [
    ["steer-1", "Persisted version"]
  ]);
});

test("restored goal turns keep their goal mode when it was recorded in developer instructions", () => {
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: () => [],
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => undefined
  }, [{
    id: "turn-1",
    userInput: "Finish the objective",
    agentResponse: "",
    status: "running",
    created: "2026-08-25T10:00:00.000Z",
    developerInstructions: [{
      target: "turn",
      phase: 0,
      developerInstructions: "Goal mode is active. Treat the thread goal as the persistent objective."
    }]
  }], "Restored goal", [], undefined);

  assert.equal(messages.find((message: { role: string }) => message.role === "user")?.executionMode, "goal");
});

test("restored context-fork turns keep their fork marker from developer instructions", () => {
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: () => [],
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => undefined
  }, [{
    id: "turn-1",
    userInput: "Delegate this work",
    agentResponse: "",
    status: "running",
    created: "2026-08-25T10:00:00.000Z",
    developerInstructions: [{
      target: "turn",
      phase: 0,
      developerInstructions: "[SERVER-PROVIDED CONTEXT FORK REQUEST]"
    }]
  }], "Restored context fork", [], undefined);

  assert.equal(messages.find((message: { role: string }) => message.role === "user")?.contextFork, true);
});

test("legacy context-fork suffix is hidden from the main prompt but retained as raw text", () => {
  const suffix = [
    "Required for this turn: create exactly one new Threadex child task for the user's request.",
    "Prepare a same-language, self-contained handoff.",
    "This appended suffix is operational metadata; it must not influence the language of the handoff or response."
  ].join(" ");
  const metadata = promptDisplayMetadata({}, `Seed one dummy event.\n\n${suffix}`);

  assert.equal(metadata.visible, "Seed one dummy event.");
  assert.equal(metadata.contextFork, true);
  assert.equal(metadata.raw.endsWith(suffix), true);
});

test("legacy context-fork duplicates inherit developer instructions from their manager turn", () => {
  const suffix = [
    "Required for this turn: create exactly one new Threadex child task for the user's request.",
    "This appended suffix is operational metadata; it must not influence the language of the handoff or response."
  ].join(" ");
  const messages = sessionTurnsToMessages({
    createSystemMessage: (content: string) => ({ id: "system", role: "system", content }),
    developerInstructionsIndicateForcePlan: () => false,
    finalizePendingReasoningItems: (items: unknown[]) => items,
    finalizePendingReasoningSegments: (segments: unknown[]) => segments,
    isLiveItem: () => false,
    isStreamItem: () => false,
    mergeDeveloperInstructionRecords: (...groups: unknown[][]) => groups.flat(),
    mergeSnapshotLiveItems: (snapshot: unknown[]) => snapshot,
    mergeSnapshotSegmentsWithLocalSteers: () => [],
    normalizeLiveItems: (items: unknown[]) => items,
    normalizeStoredUserInput: (content: string) => ({ content, attachments: [] }),
    streamItemsToSegments: () => [],
    turnDurationMs: () => undefined
  }, [{
    id: "manager-fork",
    userInput: "Delegate this work",
    agentResponse: "",
    status: "done",
    created: "2026-08-25T10:00:00.000Z",
    developerInstructions: [{
      target: "turn",
      phase: 0,
      developerInstructions: "[SERVER-PROVIDED CONTEXT FORK REQUEST]"
    }]
  }, {
    id: "imported-fork",
    userInput: `Delegate this work\n\n${suffix}`,
    agentResponse: "",
    status: "done",
    created: "2026-08-25T10:01:00.000Z"
  }], "Restored context fork", [], undefined);

  const prompts = messages.filter((message: { role: string }) => message.role === "user");
  const importedPrompt = prompts.find((message: { turnId?: string }) => message.turnId === "imported-fork");
  assert.equal(importedPrompt?.content, "Delegate this work");
  assert.equal(importedPrompt?.contextFork, true);
  assert.equal(
    importedPrompt?.developerInstructions?.find((instruction: { developerInstructions?: string } | undefined) =>
      instruction?.developerInstructions === "[SERVER-PROVIDED CONTEXT FORK REQUEST]"
    )?.developerInstructions,
    "[SERVER-PROVIDED CONTEXT FORK REQUEST]"
  );
});
