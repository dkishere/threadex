import assert from "node:assert/strict";
import test from "node:test";
import { composerModelSelectionToSave } from "./sessionModelInheritance";

const userComposerPrompt = { clientLayout: "desktop", requestedModel: "gpt-6.1-sol", model: "gpt-6.1-sol",
  modelReasoningEffort: "xhigh", autoModelEnabled: false, workspaceManager: false };

test("a user's composer model becomes the session selection inherited by later automated prompts", () => {
  assert.deepEqual(composerModelSelectionToSave(userComposerPrompt), { selectedModel: "gpt-6.1-sol", selectedEffort: "xhigh" });
});

test("automated prompts never replace the user's session selection", () => {
  // e.g. an actor_prompt_session call or a decision-dispatched @mention turn running the owner actor's model.
  assert.equal(composerModelSelectionToSave({ ...userComposerPrompt, clientLayout: undefined, model: "gpt-6-luna", requestedModel: "gpt-6-luna" }), null);
  assert.equal(composerModelSelectionToSave({ ...userComposerPrompt,
    promptOrigin: { kind: "inter-actor", trigger: "decision-dispatch" }, model: "gpt-6-luna", requestedModel: "gpt-6-luna" }), null);
});

test("Auto mode, workspace manager turns and prompts without an explicit model keep their own handling", () => {
  assert.equal(composerModelSelectionToSave({ ...userComposerPrompt, autoModelEnabled: true }), null);
  assert.equal(composerModelSelectionToSave({ ...userComposerPrompt, workspaceManager: true }), null);
  assert.equal(composerModelSelectionToSave({ ...userComposerPrompt, requestedModel: undefined }), null);
});
