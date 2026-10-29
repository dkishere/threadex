import assert from "node:assert/strict";
import test from "node:test";
import { resolveActorTaskBinding } from "./domainActorProject";

const workspace = { id: "default", cwd: "/work/tools/threadex" };
const projects = [
  { id: "dev", name: "dev", roots: ["/work"] },
  { id: "threadex", name: "threadex", roots: ["/work/tools/threadex"] },
  { id: "backend", name: "hub-backend", roots: ["/work/hub-backend", "/work/backend-secondary"] }
];
const noRepo = () => false;

test("default workspace selects a registered project mentioned in the current request", () => {
  assert.deepEqual(resolveActorTaskBinding(workspace, projects, { userPrompt: "fix hub-backend CI" }, noRepo),
    { workspaceId: "default", cwd: "/work/hub-backend", projectId: "backend", source: "message" });
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "fix hub-backend-new CI" }, noRepo).source, "workspace");
});

test("a concrete repository under an umbrella project uses that registered root, without directory scanning", () => {
  const checked: string[] = [];
  const result = resolveActorTaskBinding(workspace, projects, { userPrompt: "check beta tags on example-service" }, path => {
    checked.push(path); return path === "/work/example-service";
  });
  assert.equal(result.projectId, "dev"); assert.equal(result.cwd, "/work");
  assert.ok(checked.every(path => path.endsWith("/example-service")));
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "fix hub-backend" }, path => path === "/work/hub-backend").projectId, "backend");
});

test("absolute file paths use the most specific registered project; unrelated paths cannot become cwd", () => {
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "file:///work/tools/threadex/src/main.ts:12 failed" }, noRepo).projectId, "threadex");
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "file:///work/e2e-test/dist/main.js:19 failed" }, noRepo).projectId, "dev");
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "read /elsewhere/secrets.txt" }, noRepo).cwd, workspace.cwd);
  assert.throws(() => resolveActorTaskBinding(workspace, projects, { userPrompt: "compare /work/e2e-test/a.ts and /work/tools/threadex/b.ts" }, noRepo), /Select the project/);
});

test("explicit project and cwd win over message references and must be consistent registry roots", () => {
  const input = { userPrompt: "fix hub-backend", newSessionProjectId: "threadex" };
  assert.equal(resolveActorTaskBinding(workspace, projects, input, noRepo).cwd, workspace.cwd);
  assert.equal(resolveActorTaskBinding(workspace, projects, { ...input, newSessionProjectId: "backend", newSessionCwd: "/work/backend-secondary" }, noRepo).cwd, "/work/backend-secondary");
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "fix", newSessionCwd: "/work/hub-backend" }, noRepo).projectId, "backend");
  for (const invalid of [{ newSessionProjectId: "missing" }, { newSessionCwd: "/arbitrary" },
    { newSessionProjectId: "threadex", newSessionCwd: "/work/hub-backend" }]) {
    assert.throws(() => resolveActorTaskBinding(workspace, projects, { userPrompt: "fix", ...invalid }, noRepo), /registered/);
  }
});

test("ambiguous projects require an explicit choice and missing references retain the workspace fallback", () => {
  assert.throws(() => resolveActorTaskBinding(workspace, projects, { userPrompt: "compare threadex and hub-backend" }, noRepo), /Select the project/);
  assert.equal(resolveActorTaskBinding(workspace, [], { userPrompt: "fix this" }, noRepo).cwd, workspace.cwd);
  assert.equal(resolveActorTaskBinding(workspace, projects, { userPrompt: "fix this" }, noRepo).source, "workspace");
});

test("workspace switches use only the target registry, including colliding project IDs", () => {
  const other = { id: "other", cwd: "/other" };
  const otherProjects = [{ id: "backend", name: "hub-backend", roots: ["/other/backend"] }];
  assert.equal(resolveActorTaskBinding(other, otherProjects, { userPrompt: "hub-backend" }, noRepo).cwd, "/other/backend");
  assert.throws(() => resolveActorTaskBinding(other, otherProjects, { userPrompt: "fix", newSessionProjectId: "threadex" }, noRepo), /registered/);
});

test("an actor's sole project is a default after explicit and message project selection", () => {
  const resolve = (input: { userPrompt: string; newSessionProjectId?: string }, defaults = ["dev"]) =>
    resolveActorTaskBinding(workspace, projects, input, noRepo, defaults);
  assert.deepEqual(resolve({ userPrompt: "fix this" }),
    { workspaceId: "default", cwd: "/work", projectId: "dev", source: "actor" });
  assert.equal(resolve({ userPrompt: "fix hub-backend" }).projectId, "backend");
  assert.equal(resolve({ userPrompt: "read /work/tools/threadex/src/main.ts" }).projectId, "threadex");
  assert.equal(resolve({ userPrompt: "fix hub-backend", newSessionProjectId: "threadex" }).source, "explicit");
  assert.equal(resolve({ userPrompt: "fix this" }, ["dev", "dev"]).projectId, "dev");
});

test("ambiguous or invalid actor defaults cannot silently fall back to the workspace", () => {
  for (const defaults of [["missing"], ["dev", "backend"], ["rootless"]]) {
    const registry = [...projects, { id: "rootless", name: "Empty", roots: [] }];
    assert.throws(() => resolveActorTaskBinding(workspace, registry, { userPrompt: "fix this" }, noRepo, defaults), /Select/);
    assert.equal(resolveActorTaskBinding(workspace, registry, { userPrompt: "fix hub-backend" }, noRepo, defaults).projectId, "backend");
    assert.equal(resolveActorTaskBinding(workspace, registry, { userPrompt: "fix", newSessionProjectId: "dev" }, noRepo, defaults).projectId, "dev");
  }
  const other = { id: "other", cwd: "/other" };
  assert.throws(() => resolveActorTaskBinding(other, [], { userPrompt: "fix" }, noRepo, ["dev"]), /registered root/);
  assert.equal(resolveActorTaskBinding(other, [], { userPrompt: "fix" }, noRepo).cwd, "/other");
});
