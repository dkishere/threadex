import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { MODEL_CATALOG } from "../modelCatalog";
import { DomainActorStore } from "./domainActorStore";
import { DomainActorService, type DomainActorDependencies } from "./domainActorService";
import { createDomainActorRouter } from "./domainActorRoutes";
import type { CollaborationService } from "./collaborationService";
import { SessionStore } from "./sessionStore";

test("signed-in hierarchy promotion persists through the HTTP registry after reopening", async () => {
  if (process.env.SESSION_PG_SCHEMA) throw new Error("Requires an isolated generated schema; unset SESSION_PG_SCHEMA.");
  const path = `/private/tmp/actor-hierarchy-route-${randomUUID()}`;
  let sessions = new SessionStore(path);
  let server: ReturnType<express.Express["listen"]> | undefined;
  const memory = { rolePrompt: "Role", roleSummary: "Summary", longTerm: "Knowledge", rolling: "Recent" };
  const avatar = "data:image/png;base64,YQ==";
  const start = async () => {
    await sessions.ready();
    const store = new DomainActorStore(sessions);
    const service = new DomainActorService(store, {} as DomainActorDependencies);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { res.locals.threadexUserAuthenticated = req.headers["x-test-user"] === "signed-in"; next(); });
    app.use(createDomainActorRouter(service, store, sessions, {} as CollaborationService, { verify: async () => false }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    return { store, base: `http://127.0.0.1:${address.port}/default/actors` };
  };
  const closeServer = async () => { server!.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; };
  try {
    const first = await start();
    await first.store.create("default", { id: "root", name: "Root", model: MODEL_CATALOG.luna.id, memory });
    await first.store.create("default", { id: "child", name: "Child", parentActorId: "root", model: MODEL_CATALOG.luna.id, memory, avatar });
    await first.store.change("default", room => { room.actors.find(actor => actor.id === "root")!.projectIds = ["project-one"]; });
    const headers = { "Content-Type": "application/json", "x-test-user": "signed-in" };
    const getChild = async (base: string) => {
      const response = await fetch(base, { headers }); assert.equal(response.status, 200);
      return (await response.json()).actors.find((actor: { id: string }) => actor.id === "child");
    };
    const before = await getChild(first.base);
    const input = { parentActorId: null, expectedParentActorId: "root", expectedRootActorId: "root" };
    const post = (signedIn: boolean) => fetch(`${first.base}/child/hierarchy`, { method: "POST",
      headers: signedIn ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal((await post(false)).status, 403);
    assert.equal((await post(true)).status, 200);
    assert.equal((await post(true)).status, 409);
    const promoted = await getChild(first.base);
    assert.deepEqual(promoted, { ...before, parentActorId: null, rootActorId: "child", projectIds: ["project-one"], updated: promoted.updated });
    await closeServer(); await sessions.close();
    sessions = new SessionStore(path);
    const reopened = await start();
    assert.deepEqual(await getChild(reopened.base), promoted);
  } finally {
    if (server) await closeServer();
    await sessions.close();
  }
});
