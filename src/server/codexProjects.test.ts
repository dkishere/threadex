import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listCodexProjects, resolveCodexProjectCwd } from "./codexProjects";

test("reads ordered project roots from the current Codex state database", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-projects-"));
  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);
  `);
  database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("beta", "Beta", 1);
  database.prepare("INSERT INTO projects VALUES (?, ?, ?)").run("alpha", "Alpha", 0);
  database.prepare("INSERT INTO project_roots VALUES (?, ?, ?)").run("alpha", 1, "/work/alpha-secondary");
  database.prepare("INSERT INTO project_roots VALUES (?, ?, ?)").run("alpha", 0, "/work/alpha");
  database.close();

  assert.deepEqual(listCodexProjects(codexHome), [
    { id: "alpha", name: "Alpha", roots: ["/work/alpha", "/work/alpha-secondary"] },
    { id: "beta", name: "Beta", roots: [] }
  ]);
  assert.equal(resolveCodexProjectCwd(codexHome, "alpha"), "/work/alpha");
  assert.equal(resolveCodexProjectCwd(codexHome, "beta"), null);
  assert.equal(resolveCodexProjectCwd(codexHome, "missing"), null);
});
