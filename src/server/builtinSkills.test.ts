import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { injectBuiltinSkillsForWorkspaces, injectSessionInspectorSkills } from "./builtinSkills.js";

test("injects the session inspector skill into every workspace codex home", () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-builtins-test-"));
  const sourceRoot = resolve(root, "source-skills");
  const sourceSkill = resolve(sourceRoot, "session-inspector");
  const workspaceHomes = [resolve(root, "workspace-one"), resolve(root, "workspace-two")];

  mkdirSync(sourceSkill, { recursive: true });
  writeFileSync(
    resolve(sourceSkill, "SKILL.md"),
    "---\nname: session-inspector\ndescription: test\n---\n",
    "utf8"
  );

  const workspaces = workspaceHomes.map((codexHome, index) => ({
    id: "workspace-" + (index + 1),
    name: "Workspace " + (index + 1),
    codexHome,
    cwd: root,
    created: "",
    updated: ""
  }));

  mkdirSync(resolve(workspaceHomes[0], "skills", "session-inspector"), { recursive: true });
  writeFileSync(resolve(workspaceHomes[0], "skills", "session-inspector", "stale.txt"), "stale", "utf8");

  const destinations = injectSessionInspectorSkills(workspaces, sourceRoot);

  assert.deepEqual(destinations, workspaceHomes.map((home) => resolve(home, "skills", "session-inspector")));
  for (const destination of destinations) {
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    assert.equal(resolve(destination, "..", readlinkSync(destination)), sourceSkill);
    assert.equal(readFileSync(resolve(destination, "SKILL.md"), "utf8"), "---\nname: session-inspector\ndescription: test\n---\n");
  }

  assert.deepEqual(injectSessionInspectorSkills(workspaces, sourceRoot), destinations);
});

test("injects all built-in skills into every workspace codex home", () => {
  const root = mkdtempSync(resolve(tmpdir(), "session-builtins-test-"));
  const sourceRoot = resolve(root, "source-skills");
  const workspaceHomes = [resolve(root, "workspace-one"), resolve(root, "workspace-two")];
  for (const [name, description] of [["session-inspector", "session"], ["browser-bridge", "browser"], ["threadex-config", "config"], ["threadex-author", "provenance"]]) {
    const sourceSkill = resolve(sourceRoot, name);
    mkdirSync(sourceSkill, { recursive: true });
    writeFileSync(resolve(sourceSkill, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
  }

  const workspaces = workspaceHomes.map((codexHome, index) => ({
    id: "workspace-" + (index + 1),
    name: "Workspace " + (index + 1),
    codexHome,
    cwd: root,
    created: "",
    updated: ""
  }));

  const destinations = injectBuiltinSkillsForWorkspaces(workspaces, sourceRoot);

  assert.equal(destinations.length, workspaceHomes.length * 4);
  for (const codexHome of workspaceHomes) {
    for (const name of ["session-inspector", "browser-bridge", "threadex-config", "threadex-author"]) {
      assert.equal(lstatSync(resolve(codexHome, "skills", name)).isSymbolicLink(), true);
      assert.equal(resolve(codexHome, "skills", readlinkSync(resolve(codexHome, "skills", name))), resolve(sourceRoot, name));
      assert.equal(readFileSync(resolve(codexHome, "skills", name, "SKILL.md"), "utf8").includes(`name: ${name}`), true);
    }
    assert.equal(
      readFileSync(resolve(codexHome, "rules", "browser-bridge.rules"), "utf8"),
      `prefix_rule(pattern=${JSON.stringify(["browser-bridge"])}, decision="allow", justification="Allow the authenticated Local Browser Bridge CLI to reach its loopback daemon")\n`
    );
  }
});
