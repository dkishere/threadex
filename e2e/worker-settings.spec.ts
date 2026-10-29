import { test, expect, type Page } from "@playwright/test";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyActorRoom, type ActorRoom } from "../src/domainActors";
import { DEFAULT_MODEL } from "../src/modelCatalog";
import { DomainActorStore, type ActorPersistence } from "../src/server/domainActorStore";
import { createDomainActorRouter } from "../src/server/domainActorRoutes";
import type { DomainActorService } from "../src/server/domainActorService";
import type { SessionStore } from "../src/server/sessionStore";
import type { CollaborationService } from "../src/server/collaborationService";
import { RoundtableActorSettings, createRoundtableActorSettingsRouter } from "../src/server/roundtableActorSettings";

async function fixture(page: Page) {
  // Real HTTP router, validation and actor store. Replace only the database adapter;
  // durable database reopen is covered by domainActorStore.test.ts.
  const rooms = new Map(["workspace", "other"].map(id => [id, emptyActorRoom(id)]));
  const store = new DomainActorStore({
    getWorkspace: async (id: string) => rooms.has(id) ? { id } : null,
    getDomainActorRoom: async (id: string) => structuredClone(rooms.get(id)!),
    changeDomainActorRoom: async (id: string, change: (room: ActorRoom) => unknown) => {
      const next = structuredClone(rooms.get(id)!); const result = change(next); next.revision++; rooms.set(id, next); return result;
    }
  } as unknown as ActorPersistence);
  const memory = { rolePrompt: "Build", roleSummary: "Builder", longTerm: "Keep knowledge", rolling: "Recent work" };
  await store.create("workspace", { id: "builder", name: "Builder", model: DEFAULT_MODEL, memory });
  await store.create("other", { id: "other", name: "Other worker", model: DEFAULT_MODEL, memory });
  const directory = mkdtempSync(join(tmpdir(), "worker-settings-"));
  const library = new RoundtableActorSettings(join(directory, "consultants.json"));
  library.save([{ id: "critic", name: "Critic", model: DEFAULT_MODEL, effort: "high", rolePrompt: "Review", isDefault: true }], 0);
  const originalLibrary = library.read();
  const service = { listActors: async (id: string) => (await store.getRoom(id)).actors,
    createActor: store.create.bind(store), updateActor: store.update.bind(store), deleteActor: store.delete.bind(store) } as unknown as DomainActorService;
  let signedIn = true, failRead = false, failSave = false;
  const app = express(); app.use(express.json());
  app.use("/api/settings/roundtable-actors", createRoundtableActorSettingsRouter(library));
  // The workspace's registered Codex projects (GET /api/workspaces/projects), mocked.
  app.get("/api/workspaces/projects", (req, res) => { res.json({ workspaceId: req.query.workspaceId,
    projects: req.query.workspaceId === "workspace" ? [{ id: "backend", name: "Backend" }, { id: "ui", name: "UI" }] : [] }); });
  app.use((req, res, next) => {
    res.locals.threadexUserAuthenticated = signedIn;
    if (req.method === "GET" && failRead) { res.status(503).json({ error: "Workers unavailable" }); return; }
    if (req.method === "PATCH" && failSave) { res.status(503).json({ error: "Save unavailable" }); return; }
    next();
  });
  app.use("/api/domain-actors", createDomainActorRouter(service, store, {} as SessionStore, {} as CollaborationService, { verify: async () => false }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test address");
  await page.route("**/api/**", async route => {
    const req = route.request();
    const target = new URL(req.url());
    const result = await fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, {
      method: req.method(), headers: { "Content-Type": "application/json" }, ...(req.postData() ? { body: req.postData() } : {})
    });
    await route.fulfill({ status: result.status, contentType: "application/json", body: await result.text() });
  });
  await page.goto("/e2e/support/worker-settings.html");
  await page.getByRole("button", { name: "Workers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Builder", exact: true })).toBeVisible();
  return { store, library, originalLibrary, failRead: (value: boolean) => { failRead = value; }, failSave: (value: boolean) => { failSave = value; },
    signOut: () => { signedIn = false; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("workers settings save and reload, memory and consultants retain independent values", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Builder renamed");
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("claude-opus-5-5");
    await page.getByRole("combobox", { name: "Effort", exact: true }).selectOption("max");
    await page.getByRole("checkbox", { name: "6 Astra", exact: true }).uncheck();
    await page.getByRole("textbox", { name: "Role prompt", exact: true }).fill("Edited role");
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Worker settings saved.");
    expect((await f.store.getRoom("workspace")).actors[0].memory.rolePrompt).toBe("Build");
    await expect(page.getByRole("textbox", { name: "Role prompt", exact: true })).toHaveValue("Edited role");
    await page.getByRole("button", { name: "Save worker memory", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Worker memory saved.");
    await page.reload(); await page.getByRole("button", { name: "Workers", exact: true }).click();
    await page.getByRole("button", { name: "Builder renamed", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveValue("claude-opus-5-5");
    await expect(page.getByRole("combobox", { name: "Effort", exact: true })).toHaveValue("max");
    await expect(page.getByRole("checkbox", { name: "6 Astra", exact: true })).not.toBeChecked();
    await expect(page.getByRole("textbox", { name: "Role prompt", exact: true })).toHaveValue("Edited role");
    await page.getByRole("button", { name: "Open worker chat" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened-actor", "builder");
    await page.getByRole("button", { name: "Consultants", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Critic");
    expect(f.library.read()).toEqual(f.originalLibrary);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Critic renamed");
    await page.getByRole("button", { name: "Save actors", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved. Defaults apply to new round tables.");
    expect((await f.store.getRoom("workspace")).actors[0].name).toBe("Builder renamed");
  } finally { await f.close(); }
});

test("delete requires confirmation and removes only the selected worker", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await expect(page.getByRole("group", { name: "Confirm delete worker" })).toContainText("Delete Builder?");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await f.store.getRoom("workspace")).actors).toHaveLength(1);
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByRole("status")).toHaveText("Worker Builder deleted.");
    await expect(page.getByRole("button", { name: "Builder", exact: true })).toHaveCount(0);
    expect((await f.store.getRoom("workspace")).actors).toHaveLength(0);
    expect((await f.store.getRoom("other")).actors[0].name).toBe("Other worker");
  } finally { await f.close(); }
});

test("deletion rejects a root with children and keeps drafts; a child can be deleted first", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.store.create("workspace", { id: "child", name: "Child", parentActorId: "builder", model: DEFAULT_MODEL,
      memory: { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" } });
    await page.getByRole("button", { name: "Reload workers" }).click();
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved name");
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Unsaved name");
    expect((await f.store.getRoom("workspace")).actors).toHaveLength(2);
    await page.getByRole("button", { name: "↳ Child", exact: true }).click();
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByRole("status")).toHaveText("Worker Child deleted.");
    expect((await f.store.getRoom("workspace")).actors.map(actor => actor.id)).toEqual(["builder"]);
  } finally { await f.close(); }
});

test("signed-out delete is rejected without losing the editor", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Draft");
    f.signOut();
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Draft");
    expect((await f.store.getRoom("workspace")).actors).toHaveLength(1);
  } finally { await f.close(); }
});

test("a late deletion updates the list without disturbing another worker's draft", async ({ page }) => {
  const f = await fixture(page);
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { entered = resolve; });
  await f.store.create("workspace", { id: "second", name: "Second", model: DEFAULT_MODEL,
    memory: { rolePrompt: "", roleSummary: "", longTerm: "", rolling: "" } });
  await page.getByRole("button", { name: "Reload workers" }).click();
  await page.route("**/api/domain-actors/workspace/actors/builder", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const result = await f.store.delete("workspace", "builder");
    entered(); await gate; await route.fulfill({ json: result });
  });
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await received;
    await page.getByRole("button", { name: "Second", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Second draft");
    release();
    await expect(page.getByRole("button", { name: "Builder", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Second draft");
    await expect(page.getByRole("status")).toHaveText("Worker Builder deleted.");
  } finally { release(); await f.close(); }
});

test("a late deletion does not affect the editor in another workspace", async ({ page }) => {
  const f = await fixture(page);
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/domain-actors/workspace/actors/builder", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const result = await f.store.delete("workspace", "builder");
    entered(); await gate; await route.fulfill({ json: result });
  });
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("button", { name: "Delete worker", exact: true }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await received;
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("button", { name: "Other worker", exact: true }).click();
    const response = page.waitForResponse(r => r.url().endsWith("/workspace/actors/builder") && r.request().method() === "DELETE");
    release(); await response;
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Other worker");
    await expect(page.getByText("Worker Builder deleted.")).toHaveCount(0);
    expect((await f.store.getRoom("other")).actors).toHaveLength(1);
  } finally { release(); await f.close(); }
});

test("create root and sub-workers in the selected workspace", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("button", { name: "Add worker", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Assistant");
    await page.getByRole("combobox", { name: "Parent worker" }).selectOption("builder");
    await page.getByRole("textbox", { name: "Role summary" }).fill("Help builder");
    await page.getByRole("button", { name: "Create worker" }).click();
    await expect(page.getByRole("status")).toHaveText("Worker created.");
    expect((await f.store.getRoom("workspace")).actors[1]).toMatchObject({ name: "Assistant", parentActorId: "builder", memory: { roleSummary: "Help builder" } });
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await expect(page.getByRole("button", { name: "Other worker", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Add worker", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("New root");
    await page.getByRole("button", { name: "Create worker" }).click();
    await expect(page.getByRole("status")).toHaveText("Worker created.");
    expect((await f.store.getRoom("other")).actors[1]).toMatchObject({ name: "New root", parentActorId: null });
    expect((await f.store.getRoom("workspace")).actors).toHaveLength(2);
  } finally { await f.close(); }
});

test("failed writes retain drafts; memory conflicts survive a settings save until explicit reload", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Retry builder");
    f.failSave(true);
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("Save unavailable");
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Retry builder");
    f.failSave(false);
    await f.store.updateMemory({ workspaceId: "workspace", actorId: "builder", baseVersion: 0, sourceEventId: "external",
      memory: { rolePrompt: "External role", roleSummary: "Builder", longTerm: "Keep knowledge", rolling: "Recent work" } });
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Worker settings saved.");
    await page.getByRole("textbox", { name: "Role prompt", exact: true }).fill("Local draft");
    await page.getByRole("button", { name: "Save worker memory", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("memory version changed");
    await expect(page.getByRole("textbox", { name: "Role prompt", exact: true })).toHaveValue("Local draft");
    expect((await f.store.getRoom("workspace")).actors[0].memory.rolePrompt).toBe("External role");
    await page.getByRole("button", { name: "Reload workers" }).click();
    await page.getByRole("button", { name: "Retry builder", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Role prompt", exact: true })).toHaveValue("External role");
  } finally { await f.close(); }
});

test("loading errors recover and signed-out users cannot configure workers", async ({ page }) => {
  const f = await fixture(page);
  try {
    f.failRead(true); await page.getByRole("button", { name: "Reload workers" }).click();
    await expect(page.getByRole("alert")).toHaveText("Workers unavailable");
    await expect(page.getByRole("button", { name: "Add worker", exact: true })).toHaveCount(0);
    f.failRead(false); await page.getByRole("button", { name: "Reload workers" }).click();
    await expect(page.getByRole("button", { name: "Builder", exact: true })).toBeVisible();
    f.signOut(); await page.getByRole("button", { name: "Reload workers" }).click();
    await expect(page.getByRole("alert")).toContainText("Sign in to configure workers");
    await expect(page.getByRole("button", { name: "Add worker", exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("a late save stays in its original workspace", async ({ page }) => {
  const f = await fixture(page);
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/domain-actors/workspace/actors/builder", async route => {
    const next = await f.store.update("workspace", "builder", route.request().postDataJSON());
    entered(); await gate; await route.fulfill({ json: next });
  });
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Delayed builder");
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await received;
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("button", { name: "Other worker", exact: true }).click();
    release();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Other worker");
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("button", { name: "Delayed builder", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Delayed builder");
    expect((await f.store.getRoom("other")).actors[0].name).toBe("Other worker");
  } finally { release(); await f.close(); }
});

test("worker editor fits a narrow viewport", async ({ page }) => {
  const f = await fixture(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("group", { name: "Projects", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Open Unassigned group chat", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened-room", "unassigned");
  } finally { await f.close(); }
});

test("workers are grouped by project and a root worker's projects are saved with its settings", async ({ page }) => {
  const f = await fixture(page);
  const patches: unknown[] = [];
  // The backend projectIds write (docs/actor-project-chats.md) is mocked here; the store applies the other fields.
  await page.route("**/api/domain-actors/workspace/actors/*", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON(); patches.push(body);
    const { projectIds, ...fields } = body;
    const next = await f.store.update("workspace", decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!), fields);
    await route.fulfill({ json: { ...next, ...(projectIds?.length ? { projectIds } : {}) } });
  });
  try {
    const groups = page.locator("section.worker-project-group");
    // Registered projects in registry order, including those without workers, then Unassigned.
    await expect(groups.locator("h4")).toHaveText(["Backend", "UI", "Unassigned"]);
    await expect(page.getByRole("group", { name: "Choose worker in Unassigned", exact: true }).getByRole("button")).toHaveText(["Builder"]);
    await expect(page.getByRole("group", { name: "Choose worker in Backend", exact: true })).toContainText("No workers");
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    const projects = page.getByRole("group", { name: "Projects", exact: true });
    await expect(projects.getByRole("checkbox")).toHaveCount(2);
    await projects.getByRole("checkbox", { name: "Backend" }).check();
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Worker settings saved.");
    expect(patches.at(-1)).toMatchObject({ name: "Builder", projectIds: ["backend"] });
    await expect(page.getByRole("group", { name: "Choose worker in Backend", exact: true }).getByRole("button")).toHaveText(["Builder"]);
    await expect(page.getByRole("group", { name: "Choose worker in Unassigned", exact: true })).toContainText("No workers");
    // Saved state is clean; unchecking makes it dirty again and saves [] (Unassigned).
    await expect(page.getByRole("button", { name: "Save worker settings", exact: true })).toBeDisabled();
    await projects.getByRole("checkbox", { name: "Backend" }).uncheck();
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toMatchObject({ projectIds: [] });
    await page.getByRole("button", { name: "Open Backend group chat", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-opened-room", "backend");
  } finally { await f.close(); }
});

test("a root worker can be moved to another project or removed from one", async ({ page }) => {
  const f = await fixture(page);
  const patches: unknown[] = [];
  await page.route("**/api/domain-actors/workspace/actors/*", async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON(); patches.push(body);
    const { projectIds, ...fields } = body;
    const next = await f.store.update("workspace", decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!), fields);
    await route.fulfill({ json: { ...next, ...(projectIds?.length ? { projectIds } : {}) } });
  });
  try {
    await page.getByRole("button", { name: "Builder", exact: true }).click();
    const projects = page.getByRole("group", { name: "Projects", exact: true });
    await projects.getByRole("checkbox", { name: "Backend" }).check();
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    // Move replaces the project in place; only unassigned registered projects are targets.
    const move = projects.getByRole("combobox", { name: "Move from Backend to", exact: true });
    await expect(move.locator("option")).toHaveText(["Move to…", "UI"]);
    await move.selectOption("ui");
    await expect(projects.getByRole("checkbox", { name: "UI" })).toBeChecked();
    await expect(projects.getByRole("checkbox", { name: "Backend" })).not.toBeChecked();
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toMatchObject({ projectIds: ["ui"] });
    await expect(page.getByRole("group", { name: "Choose worker in UI", exact: true }).getByRole("button")).toHaveText(["Builder"]);
    await projects.getByRole("button", { name: "Remove from UI", exact: true }).click();
    await expect(projects.getByRole("list", { name: "Assigned projects" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save worker settings", exact: true }).click();
    await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toMatchObject({ projectIds: [] });
    await expect(page.getByRole("group", { name: "Choose worker in Unassigned", exact: true }).getByRole("button")).toHaveText(["Builder"]);
  } finally { await f.close(); }
});
