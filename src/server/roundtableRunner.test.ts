import assert from "node:assert/strict";
import test from "node:test";
import { roundtableInstructions } from "./roundtableRunner";
import type { SessionRecord } from "./sessionStore";

test("actors receive the host path for project inspection while keeping scratch writes isolated", () => {
  const instructions = roundtableInstructions({
    systemPrompt: "Review architecture",
    actorTools: { serverUrl: "http://localhost", session: { cwd: "/Volumes/dev/my projects" } as SessionRecord }
  });
  assert.match(instructions, /Host project working directory: "\/Volumes\/dev\/my projects"/);
  assert.match(instructions, /including @path references/);
  assert.match(instructions, /inspect host project files and Git changes read-only/);
  assert.match(instructions, /never modify the host project/);
  assert.match(instructions, /private scratch directory/);
  assert.match(instructions, /section headed "Verification scope"/, "the host can tell method notes from positions by their heading");
  assert.match(instructions, /Review architecture/);
});

test("context-only inference does not gain project inspection instructions", () => {
  const instructions = roundtableInstructions({ systemPrompt: "Summarize context" });
  assert.match(instructions, /do not invoke tools/);
  assert.doesNotMatch(instructions, /Host project working directory|You may inspect host project|Verification scope/);
});
