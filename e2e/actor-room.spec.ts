import { expect, test, type Page } from "@playwright/test";
import { actorRoundChatKey, emptyActorRoom, type ActorRound, type CreateDomainActor, type DomainActor, type SubmitActorRequest } from "../src/domainActors";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../src/modelCatalog";
import { DomainActorStore, type ActorPersistence } from "../src/server/domainActorStore";
import { actorConclusionFlow } from "../src/server/testFixtures/actorConclusionFlow";
import { actorSummary } from "../src/server/domainActorSummary";
import type { ActorRoundtableView, StartActorRoundtable } from "../src/actorRoundtables";

const timestamp = "2026-10-22T21:23:04.000Z";
function actor(id: string, name: string): DomainActor {
  return { id, name, workspaceId: "actors-test", rootActorId: id, parentActorId: null, model: DEFAULT_MODEL, effort: "medium", allowedModels: [...MODEL_OPTIONS], memory: { version: 0, sourceEventIds: [], rolePrompt: "Maintain this domain", roleSummary: `${name} domain`, longTerm: "Stable knowledge", rolling: "Recent work" }, created: timestamp, updated: timestamp };
}
function round(room: ReturnType<typeof emptyActorRoom>, body: SubmitActorRequest): ActorRound {
  return { id: `round-${room.rounds.length}`, requestId: body.requestId, userPrompt: body.userPrompt, namedActorIds: body.namedActorIds ?? [], candidateSnapshots: room.actors.map(actor => ({ actorId: actor.id, actor, memoryVersion: actor.memory.version })), actorSnapshots: structuredClone(room.actors), stakeholderIds: ["product"], replies: [{ actorId: "product", status: "opinion", text: "Keep the scope focused; this is advice only." }], routingDecisions: {}, policies: { shPick: { order: ["fake"], threshold: {} }, claimTiebreak: { order: ["fake"], threshold: {} } }, ownerActorId: null, workItemId: null, status: "no_claims", error: null, created: timestamp, deadline: timestamp, lease: null };
}
async function refreshRoom(page: Page) {
  const refresh = page.getByRole("button", { name: "Refresh actors" });
  if (await refresh.count()) await refresh.click();
  else await page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/room"));
}
async function highlightToComposer(page: Page, selector: string) {
  await page.locator(selector).first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("dialog", { name: "Send selected text to composer" }).getByRole("button", { name: "Send to composer", exact: true }).click();
}
async function fixture(page: Page, initialActors = [actor("product", "Product")], projectTest = false, actorId?: string) {
  await page.route("**/api/workspaces/projects?*", route => {
    const workspaceId = new URL(route.request().url()).searchParams.get("workspaceId");
    return route.fulfill({ json: { workspaceId, projects: workspaceId === "actors-test"
      ? [{ id: "backend", name: "Backend" }, { id: "ui", name: "UI" }] : [{ id: "other", name: "Other project" }] } });
  });
  await page.route("**/api/composer-suggestion-keywords?*", route => route.fulfill({ json: { keywords: [] } }));
  await page.route("**/api/composer-suggestions?*", route => route.fulfill({ json: { entries: [] } }));
  await page.route("**/api/skills?*", route => route.fulfill({ json: { skills: [] } }));
  const room = emptyActorRoom("actors-test"); room.actors = initialActors;
  const calls: SubmitActorRequest[] = [];
  const created: CreateDomainActor[] = [];
  let rejectRequestOnce = false;
  let conflictOnce = false;
  let recoverLaunch = false;
  // Group chat round tables: the contract in docs/actor-roundtable-sessions.md, mocked.
  const roundtables: ActorRoundtableView[] = [];
  const roundtableCalls: StartActorRoundtable[] = [];
  let failRoundtableOnce = false;
  // Use the production registry validator and projection for create/memory mocks.
  const store = new DomainActorStore({ getWorkspace: async () => ({ id: room.workspaceId }), getDomainActorRoom: async () => room,
    changeDomainActorRoom: async (_workspaceId: string, mutate: (value: typeof room) => unknown) => { const result = mutate(room); room.revision++; return result; } } as unknown as ActorPersistence);
  await page.route("**/api/domain-actors/actors-test/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/room")) return route.fulfill({ json: room });
    const body = route.request().postDataJSON();
    if (path.endsWith("/actors")) { created.push(body); return route.fulfill({ json: await store.create(room.workspaceId, body) }); }
    if (path.endsWith("/memory")) {
      if (conflictOnce) { conflictOnce = false; room.actors[0].memory.version++; room.actors[0].memory.longTerm = "Updated elsewhere"; room.revision++; return route.fulfill({ status: 409, json: { error: "Actor memory version changed; reread and merge." } }); }
      const id = path.split("/").at(-2)!;
      return route.fulfill({ json: await store.updateMemory({ workspaceId: room.workspaceId, actorId: id, baseVersion: body.expectedVersion, sourceEventId: body.sourceEventId, memory: body.memory }) });
    }
    if (path.endsWith("/requests")) {
      calls.push(body);
      const saved = room.rounds.find(value => value.requestId === body.requestId) ?? round(room, body);
      if (!room.rounds.includes(saved)) { room.rounds.push(saved); room.revision++; }
      if (recoverLaunch) { const work = room.workItems.find(item => item.id === saved.workItemId); if (work) { work.dispatchError = null; work.status = "assigned"; work.dispatched = true; room.revision++; } }
      if (rejectRequestOnce) { rejectRequestOnce = false; return route.abort("connectionreset"); }
      return route.fulfill({ json: saved });
    }
    if (path.endsWith("/roundtables") && route.request().method() === "POST") {
      roundtableCalls.push(body);
      let saved = roundtables.find(value => value.requestId === body.requestId);
      if (!saved) {
        saved = { requestId: body.requestId, workspaceId: room.workspaceId, sessionId: `rt-session-${roundtables.length + 1}`, turnId: `rt-turn-${roundtables.length + 1}`,
          title: body.message.slice(0, 48), prompt: body.message, contextSummary: "", actorNames: body.actors.map((item: { name: string }) => item.name),
          sourceRoundId: body.sourceRoundId ?? null, created: new Date().toISOString(), state: "running", rounds: 1, conclusion: null, error: null };
        roundtables.unshift(saved);
        const { state: _state, rounds: _rounds, conclusion: _conclusion, error: _error, ...link } = saved;
        room.roundtables = [...(room.roundtables ?? []), link]; room.revision++;
      }
      if (failRoundtableOnce) { failRoundtableOnce = false; return route.abort("connectionreset"); }
      return route.fulfill({ json: saved });
    }
    if (path.endsWith("/roundtables")) return route.fulfill({ json: { roundtables } });
    throw new Error(`Unexpected actor API request: ${path}`);
  });
  const query = new URLSearchParams();
  if (projectTest) query.set("project-test", "");
  if (actorId) query.set("actorId", actorId);
  // The group chat composer reads the consultant library for round table mode; tests that use it override this.
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { revision: 0, actors: [] } }));
  await page.goto(`/e2e/support/actor-room.html?${query}`);
  await expect(page.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page.getByText("Loading actors…")).toHaveCount(0);
  return { room, calls, created, roundtables, roundtableCalls, failNextRoundtable: () => { failRoundtableOnce = true; }, failNextRequest: () => { rejectRequestOnce = true; }, conflictNextMemory: () => { conflictOnce = true; }, recoverNextLaunch: () => { recoverLaunch = true; } };
}

for (const status of ["queued", "responding"] as const) test(`group chat ${status} reply Stop targets a round and actor, with retry and a usable narrow composer`, async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  for (const requestId of ["one", "two"]) {
    const saved = round(state.room, { workspaceId: "actors-test", requestId, userPrompt: requestId });
    saved.status = status; saved.replies = []; saved.stakeholderIds = ["product", "platform"];
    state.room.rounds.push(saved);
  }
  state.room.revision++; await refreshRoom(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Draft survives chat Stop");
  const bubbles = page.locator('.side-chat-bubble[data-actor-id="product"]');
  const stop = bubbles.first().getByRole("button", { name: "Stop Product reply", exact: true });
  await expect(stop).toBeVisible();
  await expect(page.locator(".actor-room-reply-stop")).toHaveCount(4);
  await expect(page.locator(".actor-room-composer .stop-button")).toHaveCount(0);
  const calls: string[] = []; let attempt = 0; let release!: () => void;
  await page.route("**/rounds/*/replies/*/stop", async route => {
    calls.push(new URL(route.request().url()).pathname);
    if (++attempt === 1) return route.fulfill({ status: 500, json: { error: "Try again" } });
    await new Promise<void>(resolve => { release = resolve; });
    state.room.rounds[0].replies.push({ actorId: "product", status: "stopped", text: "Reply stopped." });
    state.room.revision++;
    return route.fulfill({ json: state.room.rounds[0].replies[0] });
  });
  await stop.click();
  await expect(bubbles.first().getByRole("alert")).toContainText("Stop failed");
  await stop.focus(); await page.keyboard.press("Enter");
  await expect(stop).toHaveText("Stopping…"); await expect(stop).toBeDisabled();
  await expect(bubbles.nth(1).getByRole("button", { name: "Stop Product reply" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop Platform reply" }).first()).toBeEnabled();
  release();
  await expect(bubbles.first()).toHaveAttribute("data-reply-status", "stopped");
  await expect(bubbles.first().getByRole("button", { name: "Stop Product reply" })).toHaveCount(0);
  await expect(page.locator(".actor-room-reply-stop")).toHaveCount(3);
  expect(calls).toEqual(Array(2).fill("/api/domain-actors/actors-test/rounds/round-0/replies/product/stop"));
  await expect(input).toHaveText("Draft survives chat Stop");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  const box = await page.getByRole("button", { name: "Stop Platform reply" }).first().boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

function stopRequestRoute(state: Awaited<ReturnType<typeof fixture>>, calls: string[], mode: { missing: boolean }) {
  return async (route: import("@playwright/test").Route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    const saved = state.room.rounds.find(value => value.requestId === path.split("/").at(-2));
    if (mode.missing || !saved) return route.fulfill({ json: { round: null } });
    saved.stoppedAt = "2026-10-26T10:00:00.000Z"; saved.status = "no_claims"; saved.error = "Stopped by user.";
    state.room.revision++;
    return route.fulfill({ json: { round: saved } });
  };
}

test("group chat Stop choosing actors stops a queued round without speakers", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "choose-stop", userPrompt: "Who should answer?" });
  saved.status = "queued"; saved.replies = []; saved.stakeholderIds = [];
  state.room.rounds.push(saved); state.room.revision++; await refreshRoom(page);
  const stop = page.getByRole("button", { name: "Stop choosing actors", exact: true });
  await expect(page.getByText("Choosing actors…")).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(page.locator(".actor-room-composer .stop-button")).toHaveCount(0);
  const calls: string[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const handler = stopRequestRoute(state, calls, { missing: false });
  await page.route("**/requests/*/stop", async route => { await held; return handler(route); });
  await stop.focus(); await page.keyboard.press("Enter");
  await expect(stop).toHaveText("Stopping…"); await expect(stop).toBeDisabled();
  release();
  await expect(page.getByText("Stopped. No actor was asked to reply.")).toBeVisible();
  await expect(page.getByText("Choosing actors…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop choosing actors" })).toHaveCount(0);
  await expect(page.getByText("Who should answer?", { exact: true })).toBeVisible();
  expect(calls).toEqual(["/api/domain-actors/actors-test/requests/choose-stop/stop"]);
  await expect(page.locator(".actor-room-composer .stop-button")).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Next message");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("Stop sending stays pending until the round is saved, then stops it", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  let releasePost!: () => void;
  const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
  await page.route("**/api/domain-actors/actors-test/requests", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    await heldPost; return route.fulfill({ status: 500, json: { error: "Not saved" } });
  });
  const calls: string[] = []; const mode = { missing: true };
  await page.route("**/requests/*/stop", route => stopRequestRoute(state, calls, mode)(route));
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Stop while sending");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Sending…", { exact: true })).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop sending", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => calls.length).toBe(1);
  const requestId = calls[0].split("/").at(-2)!;
  expect(calls[0]).toBe(`/api/domain-actors/actors-test/requests/${requestId}/stop`);
  await expect(stop).toHaveText("Stopping…");
  // The round now exists in the room; the pending stop must be re-sent.
  const saved = round(state.room, { workspaceId: "actors-test", requestId, userPrompt: "Stop while sending" });
  saved.id = "late-round"; saved.status = "queued"; saved.replies = []; saved.stakeholderIds = [];
  state.room.rounds.push(saved); state.room.revision++;
  mode.missing = false; calls.length = 0;
  await refreshRoom(page);
  await expect.poll(() => calls).toEqual([`/api/domain-actors/actors-test/requests/${requestId}/stop`]);
  await expect(page.getByText("Stopped. No actor was asked to reply.")).toBeVisible();
  await expect(page.getByText("Choosing actors…")).toHaveCount(0);
  releasePost();
});

test("individual chat waiting reply shows a per-reply Stop that posts to the replies stop endpoint", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")], false, "product");
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "solo", userPrompt: "Solo question", namedActorIds: ["product"] });
  saved.status = "responding"; saved.replies = []; saved.stakeholderIds = ["product"];
  state.room.rounds.push(saved); state.room.revision++; await refreshRoom(page);
  const calls: string[] = [];
  await page.route("**/rounds/*/replies/*/stop", route => {
    calls.push(new URL(route.request().url()).pathname);
    saved.replies.push({ actorId: "product", status: "stopped", text: "Reply stopped." }); state.room.revision++;
    return route.fulfill({ json: saved.replies[0] });
  });
  await expect(page.getByText("Waiting for Product…")).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop Product reply", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => calls).toEqual(["/api/domain-actors/actors-test/rounds/round-0/replies/product/stop"]);
});

test("group mentions find Iris by displayed name and retain the registered actor recipient", async ({ page }) => {
  const state = await fixture(page, [
    actor("threadex-composer-ui", "輸入操作與介面體驗"),
    actor("threadex-session-planning", "Session 組織與任務規劃")
  ]);
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("@i");
  const iris = page.getByRole("option", { name: /Iris/ });
  await expect(iris).toBeVisible();
  await iris.click();
  await expect(input).toHaveText("@輸入操作與介面體驗 ");
  await input.press("End");
  await input.pressSequentially("Review this composer");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  expect(state.calls[0].namedActorIds).toEqual(["threadex-composer-ui"]);
  expect(state.calls[0].userPrompt).toBe("@輸入操作與介面體驗 Review this composer");
  await input.fill("@輸入");
  await expect(iris).toBeVisible();
  await input.fill("@FIN");
  await expect(page.getByRole("option", { name: /Finn/ })).toBeVisible();
  await expect(iris).toHaveCount(0);
  await input.fill("@not-an-actor");
  await expect(page.getByText("No matching actors")).toBeVisible();
});

test("group Reply keeps the draft in place and targets the actor with its message and created task context", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "reply-context", userPrompt: "Original work" });
  saved.replies.push({ actorId: "platform", status: "opinion", text: "A separate platform reply" });
  state.room.rounds.push(saved);
  const work = { id: "created-product-task", roundId: saved.id, ownerActorId: "product", executorActorId: "product", model: DEFAULT_MODEL,
    dispatchKey: "created-product-task", taskSessionId: "tx_product_task", taskTurnId: "product-turn", status: "started" as const,
    dispatchError: null, created: timestamp, updated: timestamp, dispatched: true, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [] };
  state.room.workItems.push(work, { ...work, id: "second-product-task", taskSessionId: "tx_product_second" },
    { ...work, id: "unrelated-platform-task", ownerActorId: "platform", executorActorId: "platform", taskSessionId: "tx_platform_task" });
  state.room.revision++; await refreshRoom(page);
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Keep this draft");
  await page.locator('.side-chat-bubble[data-actor-id="product"]').getByRole("button", { name: "Reply to Product", exact: true }).click();
  await expect(input).toBeFocused(); await expect(input).toHaveText("Keep this draft");
  await expect(page.locator(".actor-reply-context")).toContainText("Keep the scope focused");
  await expect(page.locator(".actor-reply-context")).toContainText("tx_product_task");
  await expect(page.locator(".actor-reply-context")).toContainText("tx_product_second");
  await expect(page.locator(".actor-reply-context")).not.toContainText("tx_platform_task");
  expect(state.calls).toHaveLength(0); expect(await page.locator("body").getAttribute("data-opened-session")).toBeNull();
  await page.reload();
  await expect(input).toHaveText("Keep this draft"); await expect(page.locator(".actor-reply-context")).toContainText("Reply to Product");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  expect(state.calls[0].namedActorIds).toEqual(["product"]);
  const { parseResponseAnnotations } = await import("../src/client/responseAnnotations");
  const parsed = parseResponseAnnotations(state.calls[0].userPrompt)!;
  expect(parsed.request).toBe("Keep this draft"); expect(parsed.annotations).toHaveLength(1);
  expect(parsed.annotations[0].text).toContain(saved.replies[0].text);
  expect(parsed.annotations[0].text).toContain("created-product-task");
  expect(parsed.annotations[0].text).toContain("threadex://actors-test/tx_product_task#product-turn");
  expect(parsed.annotations[0].text).not.toContain("unrelated-platform-task");
  await expect(page.locator(".actor-reply-context")).toHaveCount(0);
  saved.replies = []; state.room.revision++; await refreshRoom(page);
  const taskOnlyRound = page.locator(".actor-room-round").filter({ has: page.locator('[data-work-item-id="created-product-task"]') });
  await taskOnlyRound.getByRole("button", { name: "Reply to Product", exact: true }).click();
  await expect(page.locator(".actor-reply-context")).toContainText("Created tasks");
  await expect(page.locator(".actor-reply-context")).toContainText("tx_product_task");
});

for (const width of [375, 1440]) {
  for (const long of [false, true]) {
    test(`Reply preview aligns content and controls at ${width}px with ${long ? "long" : "short"} text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const name = long ? `輸入操作與介面體驗${"LongActorName".repeat(12)}` : "Product";
      const state = await fixture(page, [actor("product", name)]);
      const saved = round(state.room, { workspaceId: "actors-test", requestId: "reply-layout", userPrompt: "Layout check" });
      saved.replies[0].text = long ? "長引用及無空格文字LongUnbrokenQuote".repeat(40) : "Short reply";
      state.room.rounds.push(saved); state.room.revision++; await refreshRoom(page);
      const input = page.getByRole("textbox", { name: "Message actors" });
      await input.fill("Keep this draft");
      await page.getByRole("button", { name: `Reply to ${name}`, exact: true }).click();
      const preview = page.locator(".actor-reply-context");
      await expect(preview).toBeVisible();
      const layout = await preview.evaluate(node => {
        const rect = (element: Element) => {
          const { left, right, top, bottom, width } = element.getBoundingClientRect();
          return { left, right, top, bottom, width };
        };
        const content = node.querySelector(":scope > div")!;
        const surface = node.parentElement!;
        return { preview: rect(node), icon: rect(node.querySelector(".composer-response-quote-icon")!),
          content: rect(content), title: rect(content.querySelector("strong")!), cancel: rect(node.querySelector("button")!),
          surface: rect(surface), editor: rect(surface.querySelector('[role="textbox"]')!),
          send: rect(surface.querySelector('[aria-label="Send"]')!),
          overflow: node.scrollWidth > node.clientWidth, surfaceOverflow: surface.scrollWidth > surface.clientWidth };
      });
      expect(layout.content.width).toBeGreaterThan(100);
      expect(layout.icon.right).toBeLessThanOrEqual(layout.content.left);
      expect(layout.content.right).toBeLessThanOrEqual(layout.cancel.left);
      expect(layout.title.right).toBeLessThanOrEqual(layout.cancel.left);
      expect(layout.preview.left).toBeGreaterThanOrEqual(layout.surface.left);
      expect(layout.preview.right).toBeLessThanOrEqual(layout.surface.right);
      expect(layout.cancel.right).toBeLessThanOrEqual(layout.preview.right);
      expect(layout.preview.bottom).toBeLessThanOrEqual(layout.editor.top);
      expect(layout.send.right).toBeLessThanOrEqual(layout.surface.right);
      expect(layout.overflow).toBe(false); expect(layout.surfaceOverflow).toBe(false);
      await expect(input).toHaveText("Keep this draft"); expect(state.calls).toHaveLength(0);
      await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
      await expect(preview).toHaveCount(0); await expect(input).toHaveText("Keep this draft");
    });
  }
}

test("Reply without a task can be cancelled, replaced or cleared without changing the draft", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "reply-no-task", userPrompt: "A question" });
  saved.replies.push({ actorId: "platform", status: "opinion", text: "Platform opinion without tasks" });
  state.room.rounds.push(saved); state.room.revision++; await refreshRoom(page);
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("My follow-up");
  await page.getByRole("button", { name: "Reply to Product", exact: true }).click();
  await page.getByRole("button", { name: "Cancel reply", exact: true }).click();
  await expect(input).toHaveText("My follow-up"); await expect(page.locator(".actor-reply-context")).toHaveCount(0);
  await page.getByRole("button", { name: "Reply to Product", exact: true }).click();
  await page.getByRole("button", { name: "Reply to Platform", exact: true }).click();
  await expect(page.locator(".actor-reply-context")).toContainText("Reply to Platform");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  expect(state.calls[0].namedActorIds).toEqual(["platform"]);
  expect(state.calls[0].userPrompt).toContain("Platform opinion without tasks");
  expect(state.calls[0].userPrompt).not.toContain("Created task context");
  await page.getByRole("button", { name: "Reply to Product", exact: true }).first().click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.reload(); await expect(page.locator(".actor-reply-context")).toHaveCount(0);
});

for (const individual of [false, true]) {
  test(`${individual ? "individual" : "group"} chat copies source text and highlights into its saved draft without Quote buttons`, async ({ page }) => {
    const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")], false, individual ? "product" : undefined);
    const saved = round(state.room, { workspaceId: "actors-test", requestId: "quote-test", userPrompt: "Original question", namedActorIds: ["product"] });
    const replyText = "**Keep scope**\n\n@Platform is context, with `code`.";
    saved.replies[0].text = replyText;
    state.room.rounds.push(saved); state.room.revision++;
    await refreshRoom(page);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copiedText = text; } } }));
    const reply = page.locator('.side-chat-bubble[data-actor-id="product"]').first();
    const copy = reply.getByRole("button", { name: "Copy message", exact: true });
    await copy.focus(); await page.keyboard.press("Enter");
    await expect(reply.getByRole("button", { name: "Message copied", exact: true })).toBeVisible();
    expect(await page.locator("body").getAttribute("data-copied-text")).toBe(replyText);
    const input = page.getByRole("textbox", { name: "Message actors" });
    await input.fill("Existing draft");
    await expect(page.getByRole("button", { name: "Quote message", exact: true })).toHaveCount(0);
    await highlightToComposer(page, '.side-chat-bubble[data-actor-id="product"] .markdown-content strong');
    await expect(input).toBeFocused();
    await expect(input).toHaveText("Existing draft");
    await expect(page.locator(".composer-response-quote")).toContainText("Keep scope");
    await page.reload();
    await expect(input).toHaveText("Existing draft");
    await expect(page.locator(".composer-response-quote")).toContainText("Keep scope");
    await page.getByRole("button", { name: "Remove quote" }).click();
    await expect(page.locator(".composer-response-quote")).toHaveCount(0);
    await expect(input).toHaveText("Existing draft");
    await highlightToComposer(page, '.side-chat-bubble[data-actor-id="product"] .markdown-content strong');
    await highlightToComposer(page, '.side-chat-question .actor-room-text');
    await expect(page.locator(".composer-response-quote")).toHaveCount(2);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.calls.length).toBe(1);
    expect(state.calls[0].namedActorIds).toEqual(individual ? ["product"] : []);
    const { parseResponseAnnotations } = await import("../src/client/responseAnnotations");
    const parsed = parseResponseAnnotations(state.calls[0].userPrompt)!;
    expect(parsed.request).toBe("Existing draft");
    expect(parsed.annotations.map(item => item.text)).toEqual(["Keep scope", "Original question"]);
    await expect(page.locator(".composer-response-quote")).toHaveCount(0);
    await expect(input).not.toContainText("Existing draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await highlightToComposer(page, '.side-chat-bubble[data-actor-id="product"] .markdown-content strong');
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(page.locator(".composer-response-quote")).toHaveCount(0);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Permission denied"); } } }));
    await page.locator('.side-chat-question').first().getByRole("button", { name: "Copy message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Could not copy message; retry" })).toBeVisible();
  });

  test(`${individual ? "individual" : "group"} chat stops only visible work, retains drafts and supports retry`, async ({ page }) => {
    const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")], false, individual ? "product" : undefined);
    const saved = round(state.room, { workspaceId: "actors-test", requestId: "stop-test", userPrompt: "Visible request", namedActorIds: ["product"] });
    saved.status = "assigned";
    state.room.rounds.push(saved);
    const work = { id: "visible-work", roundId: saved.id, ownerActorId: "product", executorActorId: "product", model: DEFAULT_MODEL,
      dispatchKey: "visible", taskSessionId: "visible-session", taskTurnId: "initial-turn", activeTurnId: "active-turn",
      status: "assigned" as const, dispatchError: null, created: timestamp, updated: timestamp, dispatched: true,
      dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [] };
    state.room.workItems.push(work, { ...work, id: "unrelated", roundId: "unrelated-round", ownerActorId: "platform", executorActorId: "platform", taskSessionId: "other-session" });
    state.room.revision++;
    await refreshRoom(page);
    const input = page.getByRole("textbox", { name: "Message actors" });
    const stop = page.getByRole("button", { name: individual ? "Stop" : "Stop Product task", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toHaveText(individual ? "Stop" : "Stop task");
    if (!individual) await expect(page.locator("form.composer").getByRole("button", { name: /Stop/ })).toHaveCount(0);
    const calls: unknown[] = [];
    let release: () => void = () => {};
    await page.route("**/api/runner/stop", async route => {
      calls.push(route.request().postDataJSON());
      if (calls.length === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        return route.fulfill({ status: 500, json: { error: "Try again" } });
      }
      state.room.workItems[0].stoppedAt = "2026-10-23T10:00:00.000Z";
      state.room.revision++;
      return route.fulfill({ json: { message: "Agent stopped." } });
    });
    await input.fill("Preserved next draft");
    await stop.click();
    await expect(stop).toBeDisabled();
    await expect(stop).toHaveText("Stopping…");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.fill("Edited while stopping");
    release();
    await expect(page.getByRole("alert")).toContainText("Stop failed: Try again");
    await expect(stop).toBeEnabled();
    // Close the draft's composer suggestions before testing the stop shortcut.
    await input.press("Tab");
    await input.focus();
    if (!individual) await page.evaluate(() => window.addEventListener("keydown", event => {
      if (event.key === "Escape") document.body.dataset.groupEscapeHandled = String(event.defaultPrevented);
    }));
    await input.press("Escape");
    expect(calls).toHaveLength(1);
    if (individual) {
      await expect(page.getByText("Press Esc again to stop", { exact: true })).toBeVisible();
      await input.press("Escape");
    } else {
      await input.press("Escape");
      await expect(page.getByText("Press Esc again to stop", { exact: true })).toHaveCount(0);
      await expect(page.locator("body")).toHaveAttribute("data-group-escape-handled", "true");
      expect(calls).toHaveLength(1);
      await stop.focus();
      await page.keyboard.press("Enter");
    }
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(input).toHaveText("Edited while stopping");
    await expect(page.getByText("Keep the scope focused; this is advice only.", { exact: true })).toBeVisible();
    expect(calls).toEqual(Array(2).fill({ turnId: "active-turn", sessionId: "visible-session" }));
    expect(state.room.workItems[1].stoppedAt).toBeUndefined();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => state.calls.length).toBe(1);
    expect(state.calls[0].userPrompt).toBe("Edited while stopping");
  });
}

test("group task Stop targets one execution across actors and repeated actor rounds", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const first = round(state.room, { workspaceId: "actors-test", requestId: "first", userPrompt: "First request" });
  first.status = "assigned"; first.stakeholderIds = ["product", "platform"];
  first.replies.push({ actorId: "platform", status: "opinion", text: "Other actor reply" });
  const second = { ...structuredClone(first), id: "second-round", requestId: "second", userPrompt: "Second request" };
  state.room.rounds.push(first, second);
  const makeWork = (id: string, roundId: string, actorId: string) => ({
    id, roundId, ownerActorId: actorId, executorActorId: actorId, model: DEFAULT_MODEL,
    dispatchKey: id, taskSessionId: `session-${id}`, taskTurnId: `initial-${id}`, activeTurnId: `active-${id}`,
    status: "assigned" as const, dispatchError: null, created: timestamp, updated: timestamp, dispatched: true,
    dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: []
  });
  state.room.workItems.push(makeWork("a", first.id, "product"), makeWork("b", first.id, "platform"), makeWork("c", second.id, "product"));
  state.room.revision++;
  await refreshRoom(page);
  const workCard = (id: string) => page.locator(`[data-work-item-id="${id}"]`);
  await expect(page.locator(".actor-room-task-stop")).toHaveCount(3);
  const calls: Array<{ sessionId: string; turnId: string }> = [];
  let release: () => void = () => {};
  await page.route("**/api/runner/stop", async route => {
    const body = route.request().postDataJSON(); calls.push(body);
    if (body.sessionId === "session-a") await new Promise<void>(resolve => { release = resolve; });
    const work = state.room.workItems.find(work => work.taskSessionId === body.sessionId)!;
    work.stoppedAt = "2026-10-24T10:00:00.000Z"; state.room.revision++;
    return route.fulfill({ json: { message: "Agent stopped." } });
  });
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Next draft");
  await workCard("a").getByRole("button", { name: "Stop Product task" }).click();
  await expect(workCard("a").getByRole("button", { name: "Stop Product task" })).toBeDisabled();
  await expect(workCard("b").getByRole("button", { name: "Stop Platform task" })).toBeEnabled();
  await expect(workCard("c").getByRole("button", { name: "Stop Product task" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  // Another actor can stop independently while the first stop is still pending.
  await workCard("b").getByRole("button", { name: "Stop Platform task" }).click();
  await expect(workCard("b").getByText("Stopped", { exact: true })).toBeVisible();
  release();
  await expect(workCard("a").getByText("Stopped", { exact: true })).toBeVisible();
  await expect(workCard("a").getByRole("button", { name: /Stop/ })).toHaveCount(0);
  await expect(workCard("b").getByRole("button", { name: /Stop/ })).toHaveCount(0);
  await expect(workCard("c").getByRole("button", { name: "Stop Product task" })).toBeEnabled();
  expect(calls).toEqual([{ sessionId: "session-a", turnId: "active-a" }, { sessionId: "session-b", turnId: "active-b" }]);
  expect(state.room.workItems[2].stoppedAt).toBeUndefined();
  await expect(input).toHaveText("Next draft");
  state.room.workItems[2].status = "completed";
  state.room.revision++;
  await refreshRoom(page);
  await expect(workCard("c").getByRole("button", { name: /Stop/ })).toHaveCount(0);
});

test("actor composer omits the project control and submits messages for automatic binding", async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator(".actor-room-tools")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create actor", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh actors", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Task project", { exact: true })).toHaveCount(0);
  await expect(page.locator("form.composer")).not.toContainText("Task project");
  await page.getByRole("textbox", { name: "Message actors" }).fill("Fix backend");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  await page.getByRole("textbox", { name: "Message actors" }).fill("Fix UI");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(2);
  expect(state.calls.map(call => call.userPrompt)).toEqual(["Fix backend", "Fix UI"]);
  for (const call of state.calls) {
    expect(call).not.toHaveProperty("newSessionProjectId");
    expect(call).not.toHaveProperty("newSessionCwd");
  }
});

test("workspace switches submit to the new workspace with automatic project binding", async ({ page }) => {
  await fixture(page, [actor("product", "Product")], true);
  const other = emptyActorRoom("other-workspace");
  other.actors = [{ ...actor("other-actor", "Other actor"), workspaceId: "other-workspace" }];
  const calls: SubmitActorRequest[] = [];
  await page.route("**/api/domain-actors/other-workspace/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/room")) return route.fulfill({ json: other });
    const body = route.request().postDataJSON(); calls.push(body);
    return route.fulfill({ json: round(other, body) });
  });
  await page.getByRole("button", { name: "Switch workspace" }).click();
  await expect(page.getByLabel("Task project", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message actors" }).fill("Fix this project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).not.toHaveProperty("newSessionProjectId");
  expect(calls[0]).not.toHaveProperty("newSessionCwd");
});

test("workspace room addresses existing sub actors without a roster toolbar", async ({ page }) => {
  const root = actor("product", "Product");
  const sub = { ...actor("ui", "UI"), parentActorId: root.id, rootActorId: root.id };
  const state = await fixture(page, [root, sub]);
  await expect(page.locator(".actor-room-tools, .actor-room-roster")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message actors" }).fill("@UI give advice about this screen");
  await expect(page.locator(".actor-room-mention-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  expect(state.calls[0].namedActorIds).toEqual([sub.id]);
});

test("a lost POST response reconciles with the saved round without resending", async ({ page }) => {
  const state = await fixture(page); state.failNextRequest();
  const prompt = "  @Product Give advice only.\nKeep this exact wording.  ";
  await page.getByRole("textbox", { name: "Message actors" }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Keep the scope focused; this is advice only.")).toBeVisible();
  await expect(page.locator(".actor-room-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("threadex.actorRoom.pending:actors-test"))).toBeNull();
  await page.reload();
  await expect(page.locator(".side-chat-question").first()).toHaveText(prompt.trim());
  await expect(page.getByRole("textbox", { name: "Message actors" }).locator("[data-slate-placeholder]")).toBeVisible();
  await expect(page.getByText("Keep the scope focused; this is advice only.")).toBeVisible();
  await expect(page.getByText("No actor offered to take this.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].userPrompt).toBe(prompt); expect(state.calls[0].namedActorIds).toEqual(["product"]);
  expect(state.room.rounds).toHaveLength(1); expect(state.room.workItems).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Open task" })).toHaveCount(0);
});

test("a saved failed receipt is cleared on reload while the next draft is preserved", async ({ page }) => {
  const state = await fixture(page);
  const request = { workspaceId: "actors-test", requestId: "lost-response", userPrompt: "Already delivered", namedActorIds: ["product"] };
  state.room.rounds.push(round(state.room, request)); state.room.revision++;
  await page.evaluate(request => {
    sessionStorage.setItem("threadex.actorRoom.pending:actors-test", JSON.stringify([{ ...request, error: "Failed to fetch" }]));
    sessionStorage.setItem("threadex.actorRoom.draft:actors-test", "Next unsent draft");
  }, request);
  await page.reload();
  await expect(page.getByText("Keep the scope focused; this is advice only.")).toBeVisible();
  await expect(page.locator(".actor-room-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message actors" })).toHaveText("Next unsent draft");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("threadex.actorRoom.pending:actors-test"))).toBeNull();
  expect(state.calls).toHaveLength(0);
});

test("a POST failing after a poll acknowledged delivery cannot restore its error bubble", async ({ page }) => {
  const state = await fixture(page);
  let release: () => void = () => {};
  let failed = false;
  await page.route("**/api/domain-actors/actors-test/requests", async route => {
    const body = route.request().postDataJSON(); state.calls.push(body);
    state.room.rounds.push(round(state.room, body)); state.room.revision++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.abort("connectionreset"); failed = true;
  });
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Delivered before the response");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  await input.fill("Next unsent draft");
  await refreshRoom(page);
  await expect(page.getByText("Keep the scope focused; this is advice only.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("threadex.actorRoom.pending:actors-test"))).toBeNull();
  release();
  await expect.poll(() => failed).toBe(true);
  await expect(page.locator(".actor-room-error")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  await expect(input).toHaveText("Next unsent draft");
  expect(state.calls).toHaveLength(1);
});

for (const individual of [false, true]) {
  test(`${individual ? "private" : "workspace"} composer stays available during slow sends and protects the next draft on failure and reload`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const state = individual ? await shellFixture(page) : await fixture(page);
    const calls: SubmitActorRequest[] = [];
    const releases: Array<() => void> = [];
    await page.route("**/api/domain-actors/actors-test/requests", async route => {
      calls.push(route.request().postDataJSON());
      await new Promise<void>(resolve => releases.push(resolve));
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
    });
    const input = page.getByRole("textbox", { name: "Message actors" });
    const send = page.getByRole("button", { name: "Send", exact: true });
    await input.fill("First message");
    await send.click();
    await expect.poll(() => calls.length).toBe(1);
    await expect(input.locator("[data-slate-placeholder]")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Configure model gears" })).toBeEnabled();
    await input.fill("Second message");
    await input.press("Enter");
    await input.press("Enter");
    await expect.poll(() => calls.length).toBe(2);
    await input.fill("Next unsent draft");
    releases.splice(0).forEach(release => release());
    await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(2);
    await expect(input).toHaveText("Next unsent draft");
    await page.reload();
    await expect(input).toHaveText("Next unsent draft");
    await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(2);
    await page.getByRole("button", { name: "Retry same request" }).first().click();
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toEqual(calls[0]);
    expect(calls[1].requestId).not.toBe(calls[0].requestId);
    releases.splice(0).forEach(release => release());
    await expect(input).toHaveText("Next unsent draft");
    expect(state.room.workItems).toHaveLength(individual ? 3 : 0);
    expect(errors).toEqual([]);
  });
}

test("a slow successful actor submission and room refresh leave the next draft and gear selection intact", async ({ page }) => {
  const state = await shellFixture(page);
  let releaseRequest: () => void = () => {};
  let releaseRefresh: () => void = () => {};
  let posted = false;
  let refreshing = false;
  await page.route("**/api/domain-actors/actors-test/requests", async route => {
    const body = route.request().postDataJSON(); state.requests.push(body);
    await new Promise<void>(resolve => { releaseRequest = resolve; });
    const saved = round(state.room, body);
    saved.stakeholderIds = body.namedActorIds; saved.responseProfile = body.responseProfile;
    saved.status = "responding"; saved.replies = [];
    state.room.rounds.push(saved); state.room.revision++; posted = true;
    await route.fulfill({ json: saved });
  });
  await page.route("**/api/domain-actors/actors-test/room*", async route => {
    if (posted) {
      refreshing = true;
      await new Promise<void>(resolve => { releaseRefresh = resolve; });
    }
    await route.fulfill({ json: state.room });
  });
  await state.input.fill("@Reviewer First actor message");
  await state.send.click();
  await expect.poll(() => state.requests.length).toBe(1);
  await state.input.fill("@Reviewer Next draft");
  const nextGear = page.getByRole("radio", { name: /Gear 3/ });
  await nextGear.locator("..").click();
  await expect(nextGear).toBeChecked();
  releaseRequest();
  await expect.poll(() => refreshing).toBe(true);
  await expect(state.input).toHaveText("@Reviewer Next draft");
  await expect(nextGear).toBeChecked();
  await expect(state.send).toBeEnabled();
  await expect(page.locator('[data-reply-status="waiting"]')).toHaveCount(1);
  releaseRefresh();
  await expect(page.getByRole("region", { name: "Actor conversation", exact: true }).getByRole("status")).toHaveCount(1);
  await expect(state.input).toHaveText("@Reviewer Next draft");
  expect(state.errors).toEqual([]);
});

test("decision selection creates separate actor bubbles that retain their order as replies arrive and after reload", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "selected", userPrompt: "Review together" });
  saved.status = "responding"; saved.stakeholderIds = ["product", "platform"]; saved.replies = [];
  state.room.rounds.push(saved); state.room.revision++;
  await refreshRoom(page);
  const bubbles = page.locator(".side-chat-bubble");
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(0)).toContainText("Waiting for Product");
  await expect(bubbles.nth(1)).toContainText("Waiting for Platform");
  // The second actor answers first; its bubble keeps its selected position.
  saved.replies.push({ actorId: "platform", status: "opinion", text: "Platform answer" }); state.room.revision++;
  await refreshRoom(page);
  await expect(bubbles.nth(0)).toHaveAttribute("data-reply-status", "waiting");
  await expect(bubbles.nth(1)).toContainText("Platform answer");
  await page.reload();
  await expect(bubbles.nth(0)).toContainText("Waiting for Product");
  await expect(bubbles.nth(1)).toContainText("Platform answer");
  saved.replies.push({ actorId: "product", status: "opinion", text: "Product answer" });
  saved.status = "no_claims"; state.room.revision++;
  await refreshRoom(page);
  await expect(bubbles.nth(0)).toContainText("Product answer");
  await expect(bubbles.nth(1)).toContainText("Platform answer");
  await expect(page.locator('[data-reply-status="waiting"]')).toHaveCount(0);
});

test("assigned waits for actual start event then shows owner model and task navigation", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform"), actor("research", "Research")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "work", userPrompt: "Implement the screen" });
  saved.status = "assigned"; saved.ownerActorId = "platform"; saved.workItemId = "work";
  saved.stakeholderIds = ["product", "platform", "research"];
  saved.replies = [{ actorId: "product", status: "claimed", text: "I can own the product flow" }, { actorId: "platform", status: "claimed", text: "I can implement the full change", model: "claude-sonnet-5-5" }, { actorId: "research", status: "timeout", text: "" }];
  saved.routingDecisions.owner = { ok: true, backend: "fake", model: "test", calibrated: false, latencyMs: 1, answers: { owner: { kind: "choice", choice: "platform", confidence: .8, probabilities: { product: .2, platform: .8 } } } };
  state.room.rounds.push(saved); state.room.workItems.push({ id: "work", roundId: saved.id, ownerActorId: "platform", executorActorId: "platform", model: "claude-sonnet-5-5", dispatchKey: "work", taskSessionId: "task-session", taskTurnId: "task-turn", status: "assigned", dispatchError: null, created: timestamp, updated: timestamp, dispatched: true, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [] }); state.room.revision++;
  await refreshRoom(page);
  await expect(page.getByText("Assigned · waiting to start")).toBeVisible();
  await expect(page.locator('[data-started="true"]')).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/threadex-actor-room-assigned.png" });
  // Group chat task line shows executor and model; owner details expand in place.
  const taskLine = page.locator('[data-work-item-id="work"]');
  await expect(taskLine.locator(".actor-room-task-toggle")).toContainText("Task · Sonnet 5.5");
  await taskLine.getByRole("button", { expanded: false }).click();
  await expect(taskLine.getByText("Owner: Platform", { exact: true })).toBeVisible();
  await expect(page.getByText("Platform was selected over Product", { exact: false })).toBeVisible();
  await expect(page.getByText("Timed out", { exact: true })).toBeVisible();
  state.room.workItems[0].status = "started"; state.room.revision++;
  await refreshRoom(page);
  await expect(page.getByText("Waiting for start confirmation")).toBeVisible();
  await expect(page.locator('[data-started="true"]')).toHaveCount(0);
  state.room.events.push({ id: "started", workspaceId: "actors-test", actorIds: ["platform"], type: "task.started", workItemId: "work", taskSessionId: "task-session", taskTurnId: "task-turn", summary: "Task started", created: timestamp }); state.room.revision++;
  await refreshRoom(page);
  await expect(page.locator('[data-started="true"]')).toBeVisible();
  await expect(page.getByText("Started", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open task" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/threadex-actor-room-started.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.getByRole("region", { name: "Workspace manager chat", exact: true }).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/threadex-actor-room-mobile.png" });
  await page.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened-session", "task-session");
});

test("a single request shows parent and parallel work with independent task navigation", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "parallel", userPrompt: "Work together concurrently" });
  saved.status = "assigned"; saved.ownerActorId = "product"; saved.workItemId = "parent";
  state.room.rounds.push(saved);
  for (const [id, executorActorId, delegatedTask] of [["parent", "product", ""], ["child", "platform", "Build the API"]]) {
    state.room.workItems.push({ id, roundId: saved.id, ownerActorId: "product", executorActorId, model: DEFAULT_MODEL,
      ...(delegatedTask ? { parentWorkItemId: "parent", delegatedTask } : {}), dispatchKey: id,
      taskSessionId: `session-${id}`, taskTurnId: `turn-${id}`, status: "assigned", dispatchError: null,
      created: timestamp, updated: timestamp, dispatched: true, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [] });
  }
  state.room.revision++;
  await refreshRoom(page);
  await expect(page.getByRole("button", { name: "Open task" })).toHaveCount(2);
  const child = page.locator(".actor-room-work").filter({ hasText: "Build the API" });
  // Platform is a root actor, not Product's sub-actor: the line names the delegation.
  await expect(child).toContainText("Working actor: Platform (delegated) · Owner: Product");
  await expect(child.locator(".actor-room-task-toggle")).toContainText("Delegated by Product");
  await child.getByRole("button", { name: "Open task" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-opened-session", "session-child");
});

test("memory conflict preserves draft and permits explicit reload then CAS save", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product")], false, "product"); state.conflictNextMemory();
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  const editor = page.locator(".actor-room-editor");
  await editor.getByLabel("Long-term knowledge").fill("My local draft survives");
  await editor.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Your draft is preserved");
  await expect(editor.getByLabel("Long-term knowledge")).toHaveValue("My local draft survives");
  await page.screenshot({ path: "/private/tmp/threadex-actor-room-memory-conflict.png" });
  await editor.getByRole("button", { name: "Replace draft with latest memory" }).click();
  await expect(editor.getByLabel("Long-term knowledge")).toHaveValue("Updated elsewhere");
  await editor.getByLabel("Long-term knowledge").fill("Updated elsewhere + merged draft");
  await editor.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(state.room.actors[0].memory.version).toBe(2);
  expect(state.room.actors[0].memory.longTerm).toBe("Updated elsewhere + merged draft");
});

test("routing failure keeps advice and failed replies without starting fallback work", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "failed", userPrompt: "Choose an owner" });
  saved.status = "routing_failed"; saved.error = "Selection service unavailable.";
  saved.stakeholderIds = ["product", "platform"];
  saved.replies.push({ actorId: "platform", status: "error", text: "", error: "Could not complete this reply" });
  saved.routingDecisions.owner = { ok: false, attempts: [{ backend: "fake", reason: "timeout" }] };
  state.room.rounds.push(saved); state.room.revision++;
  await refreshRoom(page);
  await expect(page.getByRole("alert")).toContainText("Could not route this request. Selection service unavailable.");
  await expect(page.getByText("Keep the scope focused; this is advice only.")).toBeVisible();
  await expect(page.getByText("Reply failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Could not complete this reply", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open task" })).toHaveCount(0);
  expect(state.calls).toHaveLength(0); expect(state.room.workItems).toHaveLength(0);
});

test("arbitration rejection explains the timeout and retries the saved request without overwriting a draft", async ({ page }) => {
  const state = await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "arbitration", userPrompt: "  Fix the original screen exactly.  " });
  saved.status = "routing_failed"; saved.error = "Claim arbitration failed. Name an actor to continue.";
  saved.responseProfile = { model: DEFAULT_MODEL, effort: "high" };
  saved.stakeholderIds = ["product", "platform"];
  saved.replies = [{ actorId: "product", status: "timeout", text: "" }, { actorId: "platform", status: "claimed", text: "I can cover part of this" }];
  saved.routingDecisions.owner = { ok: true, backend: "llm", model: "test", calibrated: false, latencyMs: 1,
    answers: { owner: { kind: "choice", choice: "other", confidence: .48 } } };
  state.room.rounds.push(saved); state.room.revision++;
  await refreshRoom(page);
  await expect(page.getByRole("alert")).toContainText("Decision did not find a suitable claimant");
  await expect(page.getByRole("alert")).toContainText("Timed out before selection: Product");
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("My next unsent message");
  state.failNextRequest();
  await page.getByRole("button", { name: "Retry request", exact: true }).click();
  await expect.poll(() => state.calls.length).toBe(1);
  // A retry goes back to the round's group chat; a legacy round without a project binding reads as Unassigned.
  expect(state.calls[0]).toEqual({ requestId: `retry:${saved.id}`, userPrompt: saved.userPrompt, namedActorIds: saved.namedActorIds, responseProfile: saved.responseProfile, chatProjectId: null });
  await expect(page.getByRole("button", { name: "Retry request", exact: true })).toHaveCount(0);
  await expect(input).toHaveText("My next unsent message");
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry request", exact: true })).toHaveCount(0);
  await expect(input).toHaveText("My next unsent message");
  expect(state.calls).toHaveLength(1);
  expect(state.room.rounds).toHaveLength(2);
});

test("uncertain task launch retries the persisted round identity without creating new work", async ({ page }) => {
  const state = await fixture(page);
  const saved = round(state.room, { workspaceId: "actors-test", requestId: "reserved-request", userPrompt: "  Build the screen exactly.  ", namedActorIds: ["product"] });
  saved.status = "assigned"; saved.ownerActorId = "product"; saved.workItemId = "reserved-work";
  saved.taskSelection = { newSessionProjectId: "backend" };
  saved.taskBinding = { workspaceId: "actors-test", cwd: "/backend", projectId: "backend", source: "explicit" };
  saved.replies = [{ actorId: "product", status: "claimed", text: "I will implement this", model: DEFAULT_MODEL }];
  state.room.rounds.push(saved);
  state.room.workItems.push({ id: "reserved-work", roundId: saved.id, ownerActorId: "product", executorActorId: "product", model: DEFAULT_MODEL, dispatchKey: "reserved-work", taskSessionId: "reserved-session", taskTurnId: "reserved-turn", status: "assigned", dispatchError: "Launch receipt is uncertain", dispatched: false, dispatchLease: null, executionRevision: 0, executionHistory: [], assignmentRequests: [], created: timestamp, updated: timestamp }); state.room.revision++;
  await refreshRoom(page);
  state.recoverNextLaunch();
  await page.getByRole("button", { name: "Retry task launch" }).click();
  await expect(page.getByRole("button", { name: "Retry task launch" })).toHaveCount(0);
  // A legacy round bound to a project by its explicit task binding reads as, and retries in, that project's chat.
  expect(state.calls).toEqual([{ newSessionProjectId: "backend", requestId: saved.requestId, userPrompt: saved.userPrompt, namedActorIds: saved.namedActorIds, chatProjectId: "backend" }]);
  expect(state.room.workItems).toHaveLength(1);
  await expect(page.getByText("Assigned · waiting to start")).toBeVisible();
  await expect(page.locator('[data-started="true"]')).toHaveCount(0);
});

test("expired user credentials show the existing Threadex sign-in entry", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/domain-actors/actors-test/room*", route => route.fulfill({ status: 403, json: { code: "AUTH_REQUIRED", error: "Actor registry and requests require a signed-in user." } }));
  await refreshRoom(page);
  await expect(page.getByRole("alert")).toContainText("require a signed-in user");
  await expect(page.getByRole("link", { name: "Sign in to Threadex" })).toHaveAttribute("href", "/");
});

test("manager composer suggests root and sub-actor names with mouse, keyboard and cancellation", async ({ page }) => {
  const root = actor("product", "Product Lead");
  const sub = { ...actor("ui", "UI Designer"), parentActorId: root.id, rootActorId: root.id };
  const state = await fixture(page, [root, sub]);
  const chat = page.getByRole("region", { name: "Workspace manager chat" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(chat.locator(":scope > .composer .composer-editor")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message actors" });
  const menu = page.getByRole("listbox", { name: "Mention an actor" });
  await input.fill("@");
  await expect(menu.getByRole("option")).toHaveCount(2);
  await input.press("ArrowDown");
  await expect(menu.getByRole("option", { name: "UI Designer", exact: false })).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveText("@UI Designer ");
  expect(state.calls).toHaveLength(0);
  await expect(menu).toHaveCount(0);
  await input.pressSequentially("and @pro");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await input.press("Tab");
  await expect(input).toHaveText("@UI Designer and @Product Lead ");
  await expect(input).toBeFocused();
  await input.pressSequentially("Advice only");
  await input.press("Enter");
  await expect.poll(() => state.calls.length).toBe(1);
  expect(state.calls[0].namedActorIds).toEqual([root.id, sub.id]);
  expect(state.calls[0].userPrompt).toBe("@UI Designer and @Product Lead Advice only");
  await expect(input.locator("[data-slate-placeholder]")).toBeVisible();
  await input.fill("@missing");
  await expect(menu).toContainText("No matching actors");
  await input.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveText("@missing");
  await input.fill("@ui");
  await menu.getByRole("option", { name: "UI Designer", exact: false }).click();
  await expect(input).toHaveText("@UI Designer ");
  await expect(input).toBeFocused();
  await input.fill("contact@example.com");
  await expect(menu).toHaveCount(0);
});

test("manager composer and suggestions stay reachable on small and desktop screens", async ({ page }) => {
  await fixture(page, [actor("product", "Product"), actor("platform", "Platform")]);
  const input = page.getByRole("textbox", { name: "Message actors" });
  for (const viewport of [{ width: 390, height: 320 }, { width: 768, height: 600 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await input.fill(Array.from({ length: 20 }, () => "Long draft line").join("\n") + "\n@");
    const option = page.getByRole("option", { name: "Product", exact: false });
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeInViewport();
    await option.click();
    const send = page.getByRole("button", { name: "Send", exact: true });
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    const bounds = await page.locator(".actor-room-composer").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  }
});

test("the real shell opens actors in Manager without creating a legacy session, including workspace switches and reloads", async ({ page }) => {
  const errors: string[] = [];
  const legacyWrites: string[] = [];
  const workspaces = ["actors-test", "second"].map(id => ({ id, name: id === "second" ? "Second workspace" : "Actor workspace", cwd: "/tmp/actors", codexHome: "/tmp/actors", accountIds: [] }));
  let activeWorkspace = workspaces[0];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/workspace-manager" && request.method() !== "GET") legacyWrites.push(path);
    if (path === "/api/workspaces/switch") {
      activeWorkspace = workspaces.find(item => item.id === request.postDataJSON().workspaceId)!;
      return json({ activeWorkspace, workspaces });
    }
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace, workspaces, activeSessionId: "ordinary-session", activeSession: null, sessions: [], accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, workspaceName: activeWorkspace.name, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, capturedAt: timestamp, totalTasks: 0, runningTasks: 0, pendingTasks: 0, tasks: [], pendingEvents: 0 });
    // No sidebar actor tabs here: this test covers the Manager room only.
    if (path.endsWith("/actors/summary")) return json({ workspaceId: activeWorkspace.id, revision: 1, actors: [] });
    if (path.endsWith("/room")) { const room = emptyActorRoom(activeWorkspace.id); room.actors = [{ ...actor("owner", activeWorkspace.id === "second" ? "Second owner" : "Product"), workspaceId: activeWorkspace.id }]; return json(room); }
    if (path === "/api/events") return json({ events: [], cursor: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/sessions") return json({ sessions: [], hasMore: false, projects: [] });
    return json({ accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&view=workspace-chat");
  const chat = page.getByRole("region", { name: "Workspace manager chat" });
  await expect(chat.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  // An older group chat link (no chat key) opens the Unassigned chat, where the former workspace chat lives.
  await expect(page).toHaveURL(/workspaceId=actors-test#view=workspace-chat&chat=unassigned$/);
  await expect(page.getByRole("dialog", { name: "Actors", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/sessionId=/);
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await page.getByRole("combobox", { name: "Gear 2 model", exact: true }).selectOption("claude-sonnet-5-5");
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.locator(".manager-title-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manager history", exact: true })).toHaveCount(0);
  await expect(chat.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await page.getByRole("tab", { name: "Second workspace", exact: true }).click();
  await expect(page).toHaveURL(/workspaceId=second/);
  await expect(chat.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page).not.toHaveURL(/sessionId=/);
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).not.toHaveValue("claude-sonnet-5-5");
  await page.getByRole("combobox", { name: "Gear 2 model", exact: true }).selectOption("gpt-6-astra");
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await chat.getByRole("textbox", { name: "Message actors" }).fill("@");
  await expect(page.getByRole("option", { name: "Second owner", exact: false })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/threadex-manager-actor-suggestions.png" });
  await page.reload();
  await expect(chat.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page).not.toHaveURL(/sessionId=/);
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toHaveValue("gpt-6-astra");
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await page.getByRole("tab", { name: "Actor workspace", exact: true }).click();
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toHaveValue("claude-sonnet-5-5");
  expect(legacyWrites).toEqual([]);
  expect(errors).toEqual([]);
});

test("the real shell deep-links an actor view that survives reload and returns with Back", async ({ page }) => {
  const errors: string[] = [];
  const workspace = { id: "actors-test", name: "Actor workspace", cwd: "/tmp/actors", codexHome: "/tmp/actors", accountIds: [] };
  const room = emptyActorRoom("actors-test"); room.actors = [actor("root-1", "Planner")];
  const individual = round(room, { workspaceId: "actors-test", requestId: "private-1", userPrompt: "Plan the release", namedActorIds: ["root-1"] });
  individual.stakeholderIds = ["root-1"]; individual.replies = [{ actorId: "root-1", status: "opinion", text: "Release plan advice." }];
  room.rounds.push(individual); room.revision = 1;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace: workspace, workspaces: [workspace], activeSessionId: "ordinary-session", activeSession: null, sessions: [], accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/domain-actors/actors-test/actors/summary") return json({ workspaceId: "actors-test", revision: 1, actors: [{ id: "root-1", name: "Planner", rootActorId: "root-1", parentActorId: null, model: DEFAULT_MODEL, counts: { open: 2, attention: 1 }, running: 1 }] });
    if (path === "/api/domain-actors/actors-test/room") return json(room);
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, workspaceName: workspace.name, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, capturedAt: timestamp, totalTasks: 0, runningTasks: 0, pendingTasks: 0, tasks: [], pendingEvents: 0 });
    if (path === "/api/events") return json({ events: [], cursor: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/sessions") return json({ sessions: [], hasMore: false, projects: [] });
    return json({ accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&view=actor&actorId=root-1");
  const expectActorView = async () => {
    const view = page.getByRole("region", { name: "Actor view", exact: true });
    await expect(view.getByRole("heading", { name: "Finn · Planner", exact: true })).toBeVisible();
    for (const avatar of await view.locator(".domain-actor-identity > .actor-avatar").all()) {
      await expect(avatar).toHaveAttribute("aria-hidden", "true");
      const bounds = await avatar.boundingBox();
      expect(bounds?.width).toBe(36);
      expect(bounds?.height).toBe(36);
    }
    await expect(page.getByRole("tab", { name: "Workers", exact: false })).toHaveAttribute("aria-selected", "true");
    const row = page.locator("nav#sidebar-panel-actors").getByRole("button", { name: "Planner", exact: false });
    await expect(row).toContainText("Open 2");
    await expect(row).toContainText("Needs you 1");
    await expect(row).toHaveAttribute("aria-current", "true");
    const sessions = page.locator("#session-panel-actor-sessions");
    await expect(sessions).toBeVisible();
    await expect(sessions.getByRole("tab", { name: "Sessions", exact: true })).toBeVisible();
    await expect(page.getByLabel("Message audience")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Planner timeline", exact: true })).toBeVisible();
    await expect(page.getByText("Release plan advice.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Workspace manager chat" })).toHaveCount(0);
    await expect(page).toHaveURL(/view=actor&actorId=root-1/);
    await expect(page).not.toHaveURL(/sessionId=/);
  };
  await expectActorView();
  await page.screenshot({ path: "/private/tmp/threadex-actor-view.png" });
  await page.reload();
  await expectActorView();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("region", { name: "Actor view", exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=actor/);
  await expect(page).not.toHaveURL(/actorId=/);
  expect(errors).toEqual([]);
});

// Real-shell fixture with two root actors, one sub-actor and three work items (S9).
// With `projects`, Planner (and its sub-actor) belongs to the Backend project, UI has no workers and Reviewer is Unassigned;
// the mock partitions `room?chat=` the way docs/actor-project-chats.md specifies.
async function shellFixture(page: Page, search = "view=actor&actorId=root-1", options: { projects?: boolean } = {}) {
  const errors: string[] = [];
  const requests: SubmitActorRequest[] = [];
  const snapshotRequests: string[] = [];
  const chatQueries: Array<string | null> = [];
  const workspace = { id: "actors-test", name: "Actor workspace", cwd: "/tmp/actors", codexHome: "/tmp/actors", accountIds: [] };
  const sub = { ...actor("sub-1", "Planner helper"), parentActorId: "root-1", rootActorId: "root-1" };
  const planner = { ...actor("root-1", "Planner"), ...(options.projects ? { projectIds: ["backend"] } : {}) };
  const room = emptyActorRoom("actors-test"); room.actors = [planner, actor("root-2", "Reviewer"), sub]; room.revision = 1;
  const projects = options.projects ? [{ id: "backend", name: "Backend" }, { id: "ui", name: "UI" }] : [];
  const baseRound = round(room, { workspaceId: "actors-test", requestId: "seed", userPrompt: "Seed request" });
  room.rounds.push(baseRound);
  const item = (id: string, ownerActorId: string, executorActorId: string, status: "started" | "needs_user", updated: string, history: Array<{ executorActorId: string; taskSessionId: string }> = []) => ({
    id, roundId: baseRound.id, ownerActorId, executorActorId, model: DEFAULT_MODEL, dispatchKey: id, taskSessionId: `sess-${id}`, taskTurnId: `turn-${id}`, status,
    dispatchError: null, created: timestamp, updated, dispatched: true, dispatchLease: null, executionRevision: 0, assignmentRequests: [],
    executionHistory: history.map(entry => ({ ...entry, model: DEFAULT_MODEL, taskTurnId: "old-turn", dispatchKey: "old", dispatched: true, status: "failed" as const }))
  });
  room.workItems.push(
    item("started", "root-1", "sub-1", "started", "2026-10-22T21:25:00.000Z"),
    item("needs", "root-1", "root-1", "needs_user", "2026-10-22T21:24:00.000Z", [{ executorActorId: "root-1", taskSessionId: "sess-old" }]),
    item("other", "root-2", "root-2", "started", "2026-10-22T21:23:30.000Z"));
  const summary = { workspaceId: "actors-test", revision: 1, actors: [
    { id: "root-1", name: "Planner", rootActorId: "root-1", parentActorId: null, model: DEFAULT_MODEL, counts: { open: 2, attention: 1 }, running: 1 },
    { id: "root-2", name: "Reviewer", rootActorId: "root-2", parentActorId: null, model: DEFAULT_MODEL, counts: { open: 1, attention: 0 }, running: 1 },
    { id: "sub-1", name: "Planner helper", rootActorId: "root-1", parentActorId: "root-1", model: DEFAULT_MODEL, counts: { open: 1, attention: 0 }, running: 1 }] };
  if (options.projects) Object.assign(summary, { actors: summary.actors.map(entry => entry.id === "root-1" ? { ...entry, projectIds: ["backend"] } : entry),
    groups: [{ key: "backend", projectId: "backend", name: "Backend", registered: true, actorIds: ["root-1"] },
      { key: "ui", projectId: "ui", name: "UI", registered: true, actorIds: [] },
      { key: "unassigned", projectId: null, name: "Unassigned", registered: true, actorIds: ["root-2"] }] });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace: workspace, workspaces: [workspace], activeSessionId: "ordinary-session", activeSession: null, sessions: [], accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/workspaces/projects") return json({ workspaceId: "actors-test", projects });
    if (path === "/api/domain-actors/actors-test/actors/summary") return json(summary);
    if (path === "/api/domain-actors/actors-test/actors") return json({ actors: room.actors });
    if (path === "/api/domain-actors/actors-test/room") {
      const chat = url.searchParams.get("chat"); chatQueries.push(chat);
      if (chat === null || !options.projects) return json(room);
      // Server-side partition: only that chat's group rounds (single-actor rounds are private).
      return json({ ...room, rounds: room.rounds.filter(item => item.namedActorIds.length !== 1 && (actorRoundChatKey(item) ?? "unassigned") === chat) });
    }
    if (path === "/api/domain-actors/actors-test/requests") {
      const body = request.postDataJSON() as SubmitActorRequest; requests.push(body);
      const saved = round(room, body); saved.status = "no_claims"; saved.chatProjectId = body.chatProjectId ?? null; room.rounds.push(saved); room.revision++;
      return json(saved);
    }
    // Opening a card asks the shell for that session; the mock has no such session, so it answers 404.
    if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(path)) { snapshotRequests.push(path.split("/")[3]); return route.fulfill({ status: 404, json: { error: "not found" } }); }
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, workspaceName: workspace.name, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, capturedAt: timestamp, totalTasks: 0, runningTasks: 0, pendingTasks: 0, tasks: [], pendingEvents: 0 });
    if (path === "/api/events") return json({ events: [], cursor: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/sessions") return json({ sessions: [], hasMore: false, projects: [] });
    return json({ accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&${search}`);
  return { room, errors, requests, snapshotRequests, chatQueries, input: page.getByRole("textbox", { name: "Message actors" }), preview: page.locator(".actor-room-mention-preview"),
    send: page.getByRole("button", { name: "Send", exact: true }), sidebarActors: page.locator("nav#sidebar-panel-actors"), cards: page.locator("#session-panel-actor-sessions article.actor-session-card"),
    row: (id: string) => page.locator(`nav#sidebar-panel-actors button.actor-list-row[data-actor-id="${id}"]`) };
}

test("Settings Agent actors separates consultant library and workspace workers and preserves navigation", async ({ page }) => {
  const s = await shellFixture(page);
  await page.route("**/api/profile-analytics?*", route => route.fulfill({ json: { accounts: [], activity: [], reasoning: [], skills: [], trend: [], summary: {} } }));
  // Same ID across registries must remain two independent records. Missing type exercises legacy data.
  let library = { revision: 7, actors: [{ id: "root-1", name: "Saved adviser", model: DEFAULT_MODEL, effort: "high", rolePrompt: "Review assumptions", isDefault: true }] };
  const saves: unknown[] = [];
  await page.route("**/api/settings/roundtable-actors", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); saves.push(body);
      library = { revision: library.revision + 1, actors: body.actors };
    }
    await route.fulfill({ json: library });
  });
  async function openSettings() {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(s.errors).toEqual([]);
    await page.getByRole("tab", { name: "Agent actors", exact: true }).click();
  }
  await openSettings();
  const panel = page.getByRole("tabpanel", { name: "Agent actors", exact: true });
  await expect(panel.getByRole("heading", { name: "Consultants", exact: true })).toBeVisible();
  const name = panel.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("Saved adviser");
  await name.fill("Updated adviser");
  await panel.getByRole("button", { name: "Workers", exact: true }).click();
  await expect(panel).toContainText("Workspace: Actor workspace");
  // No project is registered here, so every worker is Unassigned (roots with their sub-actor).
  const workers = panel.getByRole("group", { name: "Choose worker in Unassigned", exact: true });
  await expect(workers.getByRole("button")).toHaveText(["Planner", "↳ Planner helper", "Reviewer"]);
  await expect(workers).not.toContainText("Saved adviser");
  await panel.getByRole("button", { name: "Consultants", exact: true }).click();
  await expect(name).toHaveValue("Updated adviser");
  await panel.getByRole("button", { name: "Save actors", exact: true }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ revision: 7, actors: [{ id: "root-1", name: "Updated adviser", isDefault: true }] });
  await panel.getByRole("button", { name: "Workers", exact: true }).click();
  await workers.getByRole("button", { name: "Planner helper", exact: false }).click();
  await expect(panel.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Planner helper");
  await panel.getByRole("button", { name: "Open worker chat", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/actorId=sub-1/);
  await expect(s.cards).toHaveCount(1);
  await openSettings();
  await panel.getByRole("button", { name: "Workers", exact: true }).click();
  await panel.getByRole("button", { name: "Open Unassigned group chat", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=actor/);
  await expect(page).toHaveURL(/#view=workspace-chat&chat=unassigned$/);
  expect(s.requests).toEqual([]);
  expect(s.errors).toEqual([]);
});

async function conclusionFixture(page: Page) {
  const shell = await shellFixture(page);
  const flow = actorConclusionFlow();
  let rejectAck = false;
  await page.route("**/api/domain-actors/actors-test/room*", async route => route.fulfill({ json: await flow.service.getRoom(flow.workspaceId) }));
  await page.route("**/api/domain-actors/actors-test/actors/summary", async route => route.fulfill({ json: actorSummary(await flow.service.getRoom(flow.workspaceId), []) }));
  await page.route("**/api/domain-actors/actors-test/actors/*/conclusions/*/ack", async route => {
    if (rejectAck) { rejectAck = false; return route.fulfill({ status: 503, json: { error: "Temporary acknowledgement failure" } }); }
    const parts = new URL(route.request().url()).pathname.split("/");
    await route.fulfill({ json: await flow.store.acknowledgeConclusion(flow.workspaceId, decodeURIComponent(parts[5]), decodeURIComponent(parts[7])) });
  });
  await refreshRoom(page);
  return { ...shell, flow, failNextAck: () => { rejectAck = true; } };
}

test("reviewed task completion appears only in executor Individual dialog and badge; Ack persists without erasing history", async ({ page }) => {
  const s = await conclusionFixture(page);
  await s.row("sub-1").click();
  await s.input.fill("@Reviewer Keep my draft");
  await s.flow.complete();
  await refreshRoom(page);
  await expect(page.locator('[data-kind="conclusion"]')).toHaveCount(0);
  await expect(page.locator(".actor-conclusion")).toHaveCount(0);
  await s.flow.finish();
  await expect(s.row("sub-1").locator('[data-kind="conclusion"]')).toHaveText("Conclusions 1", { timeout: 10000 });
  await expect(s.row("root-1").locator('[data-kind="conclusion"]')).toHaveCount(0);
  await expect(s.row("root-2").locator('[data-kind="conclusion"]')).toHaveCount(0);
  await expect(page.getByLabel("Message audience")).toHaveCount(0);
  await expect(s.input).toHaveText("@Reviewer Keep my draft");
  // Review conclusions arrive in the same timeline, regardless of the next message's audience.
  const conclusion = page.getByRole("article", { name: "Planner helper conclusion", exact: true });
  await expect(conclusion).toHaveCount(1);
  await expect(conclusion).toContainText("Verified conclusion for turn");
  await expect(conclusion).toContainText("Review passed");
  await s.flow.service.observe(s.flow.event("runner.result", "turn", "replay")); await s.flow.service.settled();
  await refreshRoom(page);
  await expect(conclusion).toHaveCount(1);
  expect(s.flow.reviewCalls()).toBe(1);
  s.failNextAck();
  await conclusion.getByRole("button", { name: "Ack", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not acknowledge conclusion" })).toBeVisible();
  await expect(s.row("sub-1").locator('[data-kind="conclusion"]')).toHaveText("Conclusions 1");
  await conclusion.getByRole("button", { name: "Ack", exact: true }).click();
  await expect(conclusion).toContainText("Acknowledged");
  await expect(s.row("sub-1").locator('[data-kind="conclusion"]')).toHaveCount(0);
  await page.reload();
  await expect(conclusion).toContainText("Verified conclusion for turn");
  await expect(conclusion).toContainText("Acknowledged");
  await expect(s.row("sub-1").locator('[data-kind="conclusion"]')).toHaveCount(0);
  await s.flow.service.observe(s.flow.event("runner.runner.started", "next-turn", "start-next", "2026-10-23T12:02:00.000Z"));
  await refreshRoom(page);
  await expect(conclusion).toContainText("Verified conclusion for turn");
  await conclusion.getByRole("button", { name: "Open task", exact: true }).click();
  await expect.poll(() => s.snapshotRequests).toContain("task");
  await s.row("root-1").click();
  await expect(page.locator(".actor-conclusion")).toHaveCount(0);
  expect(s.errors).toEqual([]);
});

test("review issues never create an actor conclusion or badge", async ({ page }) => {
  const s = await conclusionFixture(page);
  await s.row("sub-1").click();
  await s.flow.complete(); await s.flow.finish("issues_found");
  await refreshRoom(page);
  await page.reload();
  await expect(s.row("sub-1")).toBeVisible();
  await expect(page.locator(".actor-conclusion")).toHaveCount(0);
  await expect(page.locator('[data-kind="conclusion"]')).toHaveCount(0);
  expect((await s.flow.store.getRoom(s.flow.workspaceId)).workItems[0].completionReviews![0].status).toBe("issues_found");
  expect(s.errors).toEqual([]);
});

test("add a sub-actor from its parent view without launching work", async ({ page }) => {
  const s = await shellFixture(page);
  const parent = s.room.actors[0];
  parent.allowedModels = [DEFAULT_MODEL];
  const store = new DomainActorStore({ getWorkspace: async () => ({ id: s.room.workspaceId }),
    changeDomainActorRoom: async (_workspaceId: string, mutate: (value: typeof s.room) => unknown) => {
      const result = mutate(s.room); s.room.revision++; return result;
    } } as unknown as ActorPersistence);
  await page.route("**/api/domain-actors/actors-test/actors", async route => {
    await route.fulfill({ json: await store.create(s.room.workspaceId, route.request().postDataJSON()) });
  });
  await refreshRoom(page);
  await page.getByRole("button", { name: "Add sub-actor", exact: true }).click();
  const editor = page.locator(".actor-room-editor");
  await expect(editor.getByRole("combobox", { name: "Parent", exact: true })).toHaveValue(parent.id);
  await expect(editor.getByRole("combobox", { name: "Default model", exact: true })).toHaveCount(0);
  await expect(editor).toContainText("Choose Claude or GPT in the chat composer");
  await expect(editor.getByLabel("Role and instructions")).toHaveValue("");
  await editor.getByLabel("Name", { exact: true }).fill("Release helper");
  await editor.getByLabel("Role and instructions").fill("Prepare release checks");
  await editor.getByLabel("Domain summary").fill("Release verification");
  await editor.getByRole("button", { name: "Create actor", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const children = page.getByRole("region", { name: "Sub-actors of Planner", exact: true });
  await expect(children).toContainText("Release helper");
  await expect(children).toContainText("Sub-actors (2)");
  expect(s.room.actors.at(-1)?.parentActorId).toBe(parent.id);
  expect(s.room.actors.at(-1)?.rootActorId).toBe(parent.id);
  expect(s.room.actors.at(-1)?.allowedModels).toEqual(parent.allowedModels);
  expect(s.requests).toHaveLength(0);
  expect(s.room.workItems).toHaveLength(3);
  await page.reload();
  await expect(children).toContainText("Release helper");
  await s.row("sub-1").click();
  await expect(page.locator(".actor-room-tools")).toContainText("Sub-actor of Planner");
  await expect(page.getByRole("button", { name: "Add sub-actor", exact: true })).toHaveCount(0);
  expect(s.errors).toEqual([]);
});

test("individual actor offers sub-actor creation with the selected parent and cancellation is inert", async ({ page }) => {
  const s = await fixture(page, [actor("product", "Product")], false, "product");
  await page.getByRole("button", { name: "Add sub-actor", exact: true }).click();
  await expect(page.locator(".actor-room-editor").getByRole("combobox", { name: "Parent", exact: true })).toHaveValue("product");
  await page.getByRole("button", { name: "Close memory editor" }).click();
  expect(s.created).toHaveLength(0);
  expect(s.calls).toHaveLength(0);
});

test("actor timeline interleaves sources and task events, keeps replay unique and updates live", async ({ page }) => {
  const s = await shellFixture(page);
  s.room.rounds = [];
  s.room.workItems = [];
  const at = (minute: number) => `2026-10-23T10:0${minute}:00Z`;
  for (const [index, namedActorIds] of [["root-1", "root-2"], ["root-1"]].entries()) {
    const saved = round(s.room, { workspaceId: "actors-test", requestId: `mix-${index}`, userPrompt: `Mixed message ${index}`, namedActorIds });
    saved.created = at(index * 3); s.room.rounds.push(saved);
  }
  s.room.events = [
    { id: "start-a", workspaceId: "actors-test", actorIds: ["root-1"], roundId: "round-0", workItemId: "a", type: "task.started", created: at(1), summary: "", taskSessionId: "a", taskTurnId: "t" },
    { id: "start-b", workspaceId: "actors-test", actorIds: ["root-1"], roundId: "round-0", workItemId: "b", type: "task.started", created: at(2), summary: "", taskSessionId: "b", taskTurnId: "t" },
  ];
  s.room.revision++;
  await refreshRoom(page);
  const entries = page.locator(".actor-timeline-entry");
  await expect(entries).toHaveCount(4);
  expect(await entries.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-timeline-kind")))).toEqual(["conversation", "task", "task", "conversation"]);
  await expect(entries.first()).toContainText("Group chat");
  await expect(entries.last()).toContainText("Direct · Planner");
  await expect(entries).toHaveCount(4);
  s.room.events.push({ ...s.room.events[0], id: "replay" }, { ...s.room.events[0], id: "end-a", type: "task.turn_completed", created: at(4) });
  s.room.revision++;
  await refreshRoom(page);
  await expect(entries).toHaveCount(5);
  await expect(entries.last()).toContainText("Task turn ended");
  await expect(page.locator(".actor-conclusion")).toHaveCount(0);
  expect(s.errors).toEqual([]);
});

test("actor view Individual dialog sends only to the viewed actor", async ({ page }) => {
  const s = await shellFixture(page);
  await expect(s.input).toBeVisible();
  await expect(s.input.locator("[data-slate-placeholder]")).not.toContainText("@");
  await s.input.fill("Plan the next release");
  await expect(s.preview).toHaveCount(0);
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(1);
  expect(s.requests[0].namedActorIds).toEqual(["root-1"]);
  expect(s.requests[0].userPrompt).toBe("Plan the next release");
  expect(s.errors).toEqual([]);
});

test("actor composer gears persist selection and send the selected response profile with mentions", async ({ page }) => {
  const s = await shellFixture(page);
  const composer = page.getByRole("form", { name: "Message actors" });
  await expect(s.input).toBeVisible();
  const configure = composer.getByRole("button", { name: "Configure model gears" });
  await configure.click();
  await page.getByRole("combobox", { name: "Gear 2 model", exact: true }).selectOption("gpt-6-sol");
  await page.getByRole("combobox", { name: "Gear 2 effort", exact: true }).selectOption("high");
  await configure.click();
  await s.input.fill("Discard this draft");
  await composer.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(s.input).not.toContainText("Discard this draft");
  await expect(composer.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
  await s.input.fill("Private advice");
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(1);
  expect(s.requests[0].responseProfile).toEqual({ model: "gpt-6-sol", effort: "high" });
  expect(s.requests[0].namedActorIds).toEqual(["root-1"]);
  await s.input.fill("@Reviewer Group advice");
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(2);
  expect(s.requests[1].responseProfile).toEqual(s.requests[0].responseProfile);
  expect(s.requests[1].namedActorIds).toEqual(["root-1"]);
  await page.reload();
  await expect(composer.getByRole("radio", { checked: true })).toHaveAttribute("aria-label", /Sol.*high/i);
  expect(s.errors).toEqual([]);
});

test("actor view removes audience selection and mentions never expand recipients", async ({ page }) => {
  const s = await shellFixture(page);
  await expect(page.getByLabel("Message audience")).toHaveCount(0);
  await expect(page.locator(".actor-compose-recipient")).toHaveCount(0);
  await expect(page.locator("form.composer")).not.toContainText("mentioned actors");
  // Old group drafts remain stored, but cannot select an audience for this composer.
  await page.evaluate(() => sessionStorage.setItem("threadex.actorRoom.draft:actors-test:root-1:group", "@Reviewer old group draft"));
  await page.reload();
  await s.input.fill("hello team");
  await expect(s.send).toBeEnabled();
  await expect(s.preview).toHaveCount(0);
  await s.input.fill("@Reviewer hello");
  await expect(s.send).toBeEnabled();
  await expect(s.preview).toHaveCount(0);
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(1);
  expect(s.requests[0].namedActorIds).toEqual(["root-1"]);
  expect(s.requests[0].userPrompt).toBe("@Reviewer hello");
  await s.row("root-2").click();
  await s.input.fill("@Planner hello back");
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(2);
  expect(s.requests[1].namedActorIds).toEqual(["root-2"]);
  expect(s.errors).toEqual([]);
});

test("workspace gears follow actor changes and shared updates while dialog drafts remain separate", async ({ page }) => {
  const s = await shellFixture(page);
  const configure = page.getByRole("button", { name: "Configure model gears" });
  await s.input.fill("Planner unsent draft");
  await configure.click();
  await page.getByRole("combobox", { name: "Gear 2 model", exact: true }).selectOption("claude-sonnet-5-5");
  await configure.click();
  await s.row("root-2").click();
  await expect(s.input).not.toContainText("Planner unsent draft");
  await configure.click();
  await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toHaveValue("claude-sonnet-5-5");
  await page.getByRole("combobox", { name: "Gear 2 effort", exact: true }).selectOption("high");
  await configure.click();
  await s.row("root-1").click();
  await expect(s.input).toHaveText("Planner unsent draft");
  await page.reload();
  await expect(s.input).toHaveText("Planner unsent draft");
  await configure.click();
  await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toHaveValue("claude-sonnet-5-5");
  await expect(page.getByRole("combobox", { name: "Gear 2 effort", exact: true })).toHaveValue("high");
  await configure.click();
  // A different browser tab updates the same workspace's stored source.
  await page.evaluate(() => {
    const key = "threadex.sideChatGearPreferences:actors-test";
    const next = JSON.parse(localStorage.getItem(key)!); next.activeGearIndex = 0;
    localStorage.setItem(key, JSON.stringify(next)); window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  await expect(page.getByRole("radio", { checked: true })).toHaveAttribute("id", "actor-room-gear-1");
  expect(s.errors).toEqual([]);
});

test("gear configuration stays inside a short viewport, scrolls and closes with Escape or an outside click", async ({ page }) => {
  await fixture(page);
  const configure = page.getByRole("button", { name: "Configure model gears" });
  const menu = page.getByRole("group", { name: "Model gear configuration" });
  await configure.click();
  // Reposition an already-open menu when the available viewport shrinks.
  await page.setViewportSize({ width: 390, height: 320 });
  await expect(menu).toBeInViewport();
  const lastModel = page.getByRole("combobox", { name: "Gear 5 model", exact: true });
  await lastModel.scrollIntoViewIfNeeded();
  await lastModel.selectOption("claude-sonnet-5-5");
  await expect(lastModel).toHaveValue("claude-sonnet-5-5");
  const bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
  expect(await menu.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await lastModel.press("Escape");
  await expect(menu).toHaveCount(0);
  await configure.click();
  await page.mouse.click(2, 2);
  await expect(menu).toHaveCount(0);
});

for (const mode of ["Individual"]) {
  test(`${mode} composer offers workspace keywords, paths and slash skills alongside actor mentions`, async ({ page }) => {
    const s = await shellFixture(page);
    await page.route("**/api/composer-suggestion-keywords?*", route => route.fulfill({ json: { keywords: ["deployment"] } }));
    await page.route("**/api/composer-suggestions?*", route => route.fulfill({ json: { entries: [{ path: "src", kind: "directory" }] } }));
    await page.route("**/api/skills?*", route => route.fulfill({ json: { skills: [{ name: "browser-bridge", path: "/skills/browser-bridge/SKILL.md", description: "Inspect a browser", scope: "workspace" }] } }));
    await page.reload();
    await expect(page.getByLabel("Message audience")).toHaveCount(0);
    await s.input.fill("dep");
    await page.getByRole("option", { name: "/deployment", exact: false }).click();
    await expect(s.input).toHaveText("deployment ");
    await expect(s.input).toBeFocused();
    await s.input.fill("src");
    await s.input.press("ArrowDown"); await s.input.press("Tab");
    await expect(s.input).toHaveText("@src/ ");
    await s.input.fill("/brow");
    await page.getByRole("option", { name: "/browser-bridge", exact: false }).click();
    await expect(s.input).toHaveText("$browser-bridge ");
    await s.input.fill("@Rev");
    await s.input.press("Enter");
    await expect(s.input).toHaveText("@Reviewer ");
    expect(s.requests).toHaveLength(0);
    await s.input.press("End"); await s.input.press("d");
    await expect(page.getByRole("listbox", { name: "Composer suggestions" })).toBeVisible();
    await s.input.press("Escape");
    await expect(page.getByRole("listbox", { name: "Composer suggestions" })).toHaveCount(0);
    await s.input.fill("@Reviewer deployment $browser-bridge @src/");
    await s.send.click();
    await expect.poll(() => s.requests.length).toBe(1);
    expect(s.requests[0].userPrompt).toContain("deployment $browser-bridge @src/");
    expect(s.requests[0].namedActorIds).toEqual(["root-1"]);
    expect(s.errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`actor dialogs keep navigation and composer reachable through long conversations at ${width}px`, async ({ page }) => {
    const s = await shellFixture(page);
    await page.setViewportSize({ width, height: 800 });
    if (width < 768) await page.getByRole("button", { name: "Toggle middle panel", exact: true }).click();
    for (const namedActorIds of [["root-1"], ["root-1", "root-2"]]) {
      for (let index = 0; index < 12; index++) {
        const saved = round(s.room, { workspaceId: "actors-test", requestId: `${namedActorIds.length}-${index}`, userPrompt: `Question ${index}: ${"long-message-".repeat(35)}`, namedActorIds });
        saved.stakeholderIds = namedActorIds;
        saved.replies = [{ actorId: "root-1", status: "opinion", text: `Reply ${index}\n\n${"A detailed reply. ".repeat(25)}\n\n\`\`\`text\n${"wide-code-".repeat(70)}\n\`\`\`` }];
        s.room.rounds.push(saved);
      }
    }
    s.room.revision++;
    await refreshRoom(page);
    const transcript = page.getByRole("region", { name: "Actor conversation", exact: true });
    const audience = page.getByLabel("Message audience");
    const bottomGap = () => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    {
      await expect(transcript.locator(".actor-room-round")).toHaveCount(25);
      await expect.poll(bottomGap).toBeLessThan(2);
      await expect(audience).toHaveCount(0);
      await expect(s.input).toBeInViewport();
      await expect(s.send).toBeInViewport();
      const configure = page.getByRole("button", { name: "Configure model gears" });
      await expect(configure).toBeInViewport();
      await configure.click();
      await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toBeVisible();
      const menu = page.getByRole("group", { name: "Model gear configuration" });
      const bounds = await menu.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
      expect(await menu.evaluate(node => node.parentElement === document.body)).toBe(true);
      const lastModel = page.getByRole("combobox", { name: "Gear 5 model", exact: true });
      await lastModel.scrollIntoViewIfNeeded();
      await lastModel.selectOption("gpt-6-sol");
      await expect(lastModel).toHaveValue("gpt-6-sol");
      await transcript.evaluate(node => { node.scrollTop = 100; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await expect(menu).toBeVisible();
      await configure.click();
      // Wide code scrolls within the reply rather than widening the conversation.
      expect(await transcript.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await transcript.evaluate(node => { node.scrollTop = 100; node.dispatchEvent(new Event("scroll")); });
      s.room.revision++;
      await refreshRoom(page);
      await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(100);
      await expect(s.input).toBeInViewport();
    }
    await expect(page.getByRole("region", { name: "Planner timeline", exact: true })).toHaveAttribute("tabindex", "0");
    await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(100);
    await page.screenshot({ path: `/private/tmp/threadex-actor-dialog-${width}.png` });
    expect(s.errors).toEqual([]);
  });
}

test("actor view drafts are isolated per actor without an audience selector", async ({ page }) => {
  const s = await shellFixture(page);
  await s.input.fill("draft for planner");
  await s.row("root-2").click();
  await expect(page.getByRole("region", { name: "Actor view", exact: true }).getByRole("heading", { name: "Vera · Reviewer", exact: true, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/actorId=root-2/);
  await expect(s.input.locator("[data-slate-placeholder]")).toBeVisible();
  await expect(s.input).not.toContainText("draft for planner");
  await expect(page.getByLabel("Message audience")).toHaveCount(0);
  await s.row("root-1").click();
  await expect(page.getByRole("region", { name: "Actor view", exact: true }).getByRole("heading", { name: "Finn · Planner", exact: true, level: 1 })).toBeVisible();
  await expect(s.input).toHaveText("draft for planner");
  await expect(page.getByLabel("Message audience")).toHaveCount(0);
  expect(s.requests).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("actor sessions panel lists the tree's sessions, filters, opens a session and narrows for sub-actors", async ({ page }) => {
  const s = await shellFixture(page);
  await expect(s.cards).toHaveCount(3);
  await expect(page.locator('article[data-session-id="sess-started"]')).toContainText("Executed by Planner helper");
  await expect(page.locator('article[data-session-id="sess-needs"]')).toHaveAttribute("data-current", "true");
  await expect(page.locator('article[data-session-id="sess-old"]')).toHaveAttribute("data-current", "false");
  await expect(page.locator('article[data-session-id="sess-old"]')).toContainText("Earlier session");
  await expect(page.locator('article[data-session-id="sess-other"]')).toHaveCount(0);
  await page.getByLabel("Filter sessions").selectOption({ label: "Needs you" });
  await expect(s.cards).toHaveCount(1);
  await expect(s.cards.first()).toHaveAttribute("data-session-id", "sess-needs");
  await s.cards.first().click();
  await expect.poll(() => s.snapshotRequests).toContain("sess-needs");
  await expect(page.locator("section.chat[data-actor-view='true']")).toBeVisible();
  await s.row("sub-1").click();
  await expect(page).toHaveURL(/actorId=sub-1/);
  await expect(s.cards).toHaveCount(1);
  await expect(s.cards.first()).toHaveAttribute("data-session-id", "sess-started");
  expect(s.errors).toEqual([]);
});

test("actor view sidebar tabs switch lists and Back/popstate restore the actor view", async ({ page }) => {
  const s = await shellFixture(page);
  const actorView = page.locator('section.chat[data-actor-view="true"]');
  await expect(actorView).toBeVisible();
  await page.getByRole("tab", { name: "Sessions", exact: false }).first().click();
  await expect(page.locator("#sidebar-panel-sessions")).toBeVisible();
  await expect(s.sidebarActors).toHaveCount(0);
  await page.getByRole("tab", { name: "Workers", exact: false }).click();
  await expect(s.sidebarActors).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).not.toHaveURL(/view=actor/);
  await expect(actorView).toHaveCount(0);
  await page.goBack();
  await expect(actorView).toBeVisible();
  await expect(page).toHaveURL(/actorId=root-1/);
  await page.goForward();
  await expect(actorView).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=actor/);
  expect(s.errors).toEqual([]);
});

test("actor view compact layout switches between the actor sessions and sidebar, and stays usable on a phone", async ({ page }) => {
  const s = await shellFixture(page);
  await page.setViewportSize({ width: 900, height: 800 });
  const toggle = page.locator(".workspace-manager-panel-switch");
  const middle = page.locator("#session-panel-actor-sessions");
  await expect(toggle).toBeVisible();
  await expect(middle).toBeVisible();
  await toggle.click();
  await expect(middle).toBeHidden();
  await expect(page.locator("nav#sidebar-panel-actors, #sidebar-panel-sessions").first()).toBeVisible();
  await page.getByRole("button", { name: "Back to actor", exact: true }).click();
  await expect(middle).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  // On a phone the Sessions column covers the dialog; collapsing it reveals the composer.
  await expect(middle).toBeVisible();
  await expect(s.input).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle middle panel", exact: true }).click();
  await expect(s.input).toBeVisible();
  await s.input.scrollIntoViewIfNeeded();
  await expect(s.input).toBeInViewport();
  expect(s.errors).toEqual([]);
});

test("a project group chat entry is current only while that group chat is open", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  const all = s.sidebarActors.getByRole("button", { name: "Unassigned group chat", exact: true });
  await expect(all).toHaveAttribute("aria-current", "true");
  await s.row("root-1").click();
  await expect(page.locator('section.chat[data-actor-view="true"]')).toBeVisible();
  await expect(all).not.toHaveAttribute("aria-current", "true");
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&sessionId=ordinary-session");
  await expect(page.locator('section.chat[data-actor-view="true"]')).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Workspace manager chat" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Workers", exact: false }).click();
  await expect(s.sidebarActors).toBeVisible();
  await expect(all).not.toHaveAttribute("aria-current", "true");
  expect(s.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`Workers sidebar groups workers by project with collapsible groups and per-group running counts at ${width}px`, async ({ page }) => {
  const s = await shellFixture(page, "", { projects: true });
  await page.setViewportSize({ width, height: 900 });
  await page.getByRole("tab", { name: "Workers", exact: false }).click();
  const groups = s.sidebarActors.locator("section.actor-list-group");
  // Registered projects in registry order (including one with no workers), then Unassigned last.
  await expect(groups).toHaveCount(3);
  await expect(groups.locator("h3")).toHaveText([/Backend/, /UI/, /Unassigned/]);
  const backend = groups.nth(0);
  await expect(backend.getByRole("heading", { level: 3 })).toBeVisible();
  await expect(backend.locator("button.actor-list-row")).toHaveCount(2);
  await expect(backend.locator('button.actor-list-row[data-sub="true"]')).toHaveAttribute("data-actor-id", "sub-1");
  // Planner and its sub-actor each run one task: the group counts 2, the sub-actor is not added twice.
  await expect(backend.locator("h3 .actor-list-running")).toHaveAttribute("aria-label", "2 running");
  await expect(groups.nth(1).locator("button.actor-list-row")).toHaveCount(0);
  await expect(groups.nth(1)).toContainText("No workers in this project.");
  await expect(groups.nth(1).locator("h3 .actor-list-running")).toHaveCount(0);
  await expect(groups.nth(2).locator("button.actor-list-row")).toHaveAttribute("data-actor-id", "root-2");
  await expect(groups.nth(2).locator("h3 .actor-list-running")).toHaveAttribute("aria-label", "1 running");
  // Collapsing keeps the heading and hides the group's rows.
  const toggle = backend.getByRole("button", { name: /Backend/ }).first();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(backend.locator("button.actor-list-row").first()).toBeHidden();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(backend.locator("button.actor-list-row").first()).toBeVisible();
  const box = await s.sidebarActors.boundingBox();
  if (box) expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(s.errors).toEqual([]);
});

test("each project has its own group chat: URL, reload, history, @ candidates, request and draft are per project", async ({ page }) => {
  const s = await shellFixture(page, "", { projects: true });
  await page.getByRole("tab", { name: "Workers", exact: false }).click();
  await s.sidebarActors.getByRole("button", { name: "Backend group chat", exact: true }).click();
  await expect(page).toHaveURL(/#view=workspace-chat&chat=backend$/);
  const chat = page.getByRole("region", { name: "Workspace manager chat" });
  await expect(chat.getByRole("heading", { name: "Backend group chat" })).toBeVisible();
  await expect(s.sidebarActors.getByRole("button", { name: "Backend group chat", exact: true })).toHaveAttribute("aria-current", "true");
  await expect.poll(() => s.chatQueries.includes("backend")).toBe(true);
  // The server partition: the legacy seed round lives in Unassigned, not here.
  await expect(chat.locator("section.actor-room-round")).toHaveCount(0);
  // @ lists only Backend's workers (Planner and its sub-actor), not Unassigned Reviewer.
  await s.input.click();
  await s.input.pressSequentially("@");
  const mentions = page.getByRole("listbox", { name: "Mention an actor" });
  await expect(mentions.getByRole("option")).toHaveCount(2);
  await expect(mentions).not.toContainText("Reviewer");
  await page.keyboard.press("Escape");
  await s.input.fill("Backend draft");
  // Another project's chat has its own (empty) draft and its own members.
  await s.sidebarActors.getByRole("button", { name: "Unassigned group chat", exact: true }).click();
  await expect(page).toHaveURL(/#view=workspace-chat&chat=unassigned$/);
  await expect(chat.getByRole("heading", { name: "Unassigned group chat" })).toBeVisible();
  await expect(chat.locator("section.actor-room-round")).toHaveCount(1);
  await expect(s.input).not.toContainText("Backend draft");
  await page.goBack();
  await expect(page).toHaveURL(/#view=workspace-chat&chat=backend$/);
  await expect(chat.getByRole("heading", { name: "Backend group chat" })).toBeVisible();
  await expect(s.input).toHaveText("Backend draft");
  await page.goForward();
  await expect(chat.getByRole("heading", { name: "Unassigned group chat" })).toBeVisible();
  await page.goBack();
  await page.reload();
  await expect(chat.getByRole("heading", { name: "Backend group chat" })).toBeVisible();
  await expect(s.input).toHaveText("Backend draft");
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(1);
  expect(s.requests[0]).toMatchObject({ userPrompt: "Backend draft", chatProjectId: "backend", namedActorIds: [] });
  await expect(chat.locator("section.actor-room-round")).toHaveCount(1);
  // A project without workers explains how to add them and cannot send.
  await s.sidebarActors.getByRole("button", { name: "UI group chat", exact: true }).click();
  await expect(chat).toContainText("No workers in this project yet.");
  await s.input.fill("Anyone?");
  await expect(s.send).toBeDisabled();
  // The Unassigned chat sends with chatProjectId null.
  await s.sidebarActors.getByRole("button", { name: "Unassigned group chat", exact: true }).click();
  await s.input.fill("Unassigned request");
  await s.send.click();
  await expect.poll(() => s.requests.length).toBe(2);
  expect(s.requests[1]).toMatchObject({ userPrompt: "Unassigned request", chatProjectId: null });
  expect(s.errors).toEqual([]);
});

test("a group chat opened beside a task session keeps the project chat key in the URL", async ({ page }) => {
  const s = await shellFixture(page, "sessionId=task-1#view=workspace-chat&chat=backend", { projects: true });
  await expect(page).toHaveURL(/sessionId=task-1/);
  await expect(page).toHaveURL(/#view=workspace-chat&chat=backend$/);
  await expect(page.getByRole("region", { name: "Workspace manager chat" }).getByRole("heading", { name: "Backend group chat" })).toBeVisible();
  expect(s.errors).toEqual([]);
});

const consultantLibrary = { revision: 1, actors: [
  { type: "consultant", id: "critic", name: "Critic", model: DEFAULT_MODEL, effort: "high", rolePrompt: "Find the risks", isDefault: true },
  { type: "consultant", id: "builder", name: "Builder", model: DEFAULT_MODEL, effort: "high", rolePrompt: "Find the simplest path", isDefault: true },
  { type: "consultant", id: "user", name: "User advocate", model: DEFAULT_MODEL, effort: "medium", rolePrompt: "Speak for users", isDefault: false }] };

for (const width of [1280, 390]) test(`group chat round table opens a new session and keeps only a reference card at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 860 });
  const state = await fixture(page);
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: consultantLibrary }));
  const toggle = page.getByRole("button", { name: "Round table mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // The session round table's picker and defaults, inside the group chat composer.
  const picker = page.getByRole("group", { name: "Round table actors" });
  await expect(picker.getByRole("button", { name: "Select actors" })).toContainText("Critic, Builder");
  await picker.getByRole("button", { name: "Select actors" }).click();
  await page.getByRole("checkbox", { name: "User advocate" }).check();
  await page.keyboard.press("Escape");
  await expect(picker.getByRole("button", { name: "Select actors" })).toContainText("Critic, Builder, User advocate");
  const input = page.getByRole("textbox", { name: "Message actors" });
  await input.fill("Should we split the billing service?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.openedSession)).toBe("rt-session-1");
  expect(state.roundtableCalls).toHaveLength(1);
  expect(state.roundtableCalls[0]).toMatchObject({ message: "Should we split the billing service?" });
  expect(state.roundtableCalls[0].actors.map(item => item.name)).toEqual(["Critic", "Builder", "User advocate"]);
  expect(Object.keys(state.roundtableCalls[0]).sort()).toEqual(["actors", "message", "requestId"]);
  // No in-place group chat round is created; the mode turns off after one prompt.
  expect(state.calls).toHaveLength(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(picker).toHaveCount(0);
  const card = page.locator("button.actor-roundtable-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Should we split the billing service?");
  await expect(card).toContainText("Critic, Builder, User advocate");
  await expect(card.locator(".actor-roundtable-state")).toHaveText("In progress");
  // Progress does not bump the room revision; the card polls the list while running.
  Object.assign(state.roundtables[0], { state: "done", conclusion: "Keep one service for now; split billing exports first." });
  await expect(card.locator(".actor-roundtable-state")).toHaveText("Done", { timeout: 8000 });
  await expect(card).toContainText("split billing exports first");
  await expect(card).toBeInViewport();
  const box = await card.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  await page.evaluate(() => { delete document.body.dataset.openedSession; });
  await card.click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.openedSession)).toBe("rt-session-1");
  await expect(input).toBeVisible();
});

test("group chat round table keeps an uncertain request and retries it with the same request ID", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: consultantLibrary }));
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  await page.getByRole("textbox", { name: "Message actors" }).fill("Pick a queue backend");
  state.failNextRoundtable();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const receipt = page.getByRole("region", { name: "Round table delivery" });
  await expect(receipt.getByRole("alert")).toContainText("Your round table request is saved.");
  expect(await page.evaluate(() => document.body.dataset.openedSession)).toBeUndefined();
  await receipt.getByRole("button", { name: "Retry same request" }).click();
  await expect.poll(() => page.evaluate(() => document.body.dataset.openedSession)).toBe("rt-session-1");
  expect(state.roundtableCalls.map(call => call.requestId)).toEqual([state.roundtableCalls[0].requestId, state.roundtableCalls[0].requestId]);
  await expect(receipt).toHaveCount(0);
  await expect(page.locator("button.actor-roundtable-card")).toHaveCount(1);
  // Attachments are not part of the round table contract, so they block sending in this mode.
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  await page.getByLabel("Attach files to actor message").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await page.getByRole("textbox", { name: "Message actors" }).fill("With a file");
  await expect(page.getByText("Round tables in a new session cannot take attachments yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});

