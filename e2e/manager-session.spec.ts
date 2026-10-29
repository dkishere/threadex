import { expect, test, type Page } from "@playwright/test";
import { emptyActorRoom, type ActorRound, type DomainActor, type SubmitActorRequest } from "../src/domainActors";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../src/modelCatalog";

const timestamp = "2026-10-22T21:23:04.000Z";
function actor(id: string, name: string): DomainActor {
  return { id, name, workspaceId: "actors-test", rootActorId: id, parentActorId: null, model: DEFAULT_MODEL, effort: "medium", allowedModels: [...MODEL_OPTIONS], memory: { version: 0, sourceEventIds: [], rolePrompt: "Maintain this domain", roleSummary: `${name} domain`, longTerm: "Stable knowledge", rolling: "Recent work" }, created: timestamp, updated: timestamp };
}
function round(room: ReturnType<typeof emptyActorRoom>, body: SubmitActorRequest): ActorRound {
  return { id: `round-${room.rounds.length}`, requestId: body.requestId, userPrompt: body.userPrompt, namedActorIds: body.namedActorIds ?? [], candidateSnapshots: room.actors.map(actor => ({ actorId: actor.id, actor, memoryVersion: actor.memory.version })), actorSnapshots: structuredClone(room.actors), stakeholderIds: ["product"], replies: [{ actorId: "product", status: "opinion", text: "Keep the scope focused; this is advice only." }], routingDecisions: {}, policies: { shPick: { order: ["fake"], threshold: {} }, claimTiebreak: { order: ["fake"], threshold: {} } }, ownerActorId: null, workItemId: null, status: "no_claims", error: null, created: timestamp, deadline: timestamp, lease: null };
}
async function shellFixture(page: Page, search = "view=actor&actorId=root-1") {
  const errors: string[] = [];
  const requests: SubmitActorRequest[] = [];
  const snapshotRequests: string[] = [];
  const workspace = { id: "actors-test", name: "Actor workspace", cwd: "/tmp/actors", codexHome: "/tmp/actors", accountIds: [] };
  const sub = { ...actor("sub-1", "Planner helper"), parentActorId: "root-1", rootActorId: "root-1" };
  const room = emptyActorRoom("actors-test"); room.actors = [actor("root-1", "Planner"), actor("root-2", "Reviewer"), sub]; room.revision = 1;
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
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith("/file-changes")) return json({ fileChanges: [{ path: "src/example.ts", kind: "update", additions: 1, deletions: 0, turnIds: [] }], totals: { files: 1, additions: 1, deletions: 0 } });
    if (path === "/api/sessions/switch") {
      const id = request.postDataJSON()?.sessionId;
      const snapshot = id ? await request.frame().evaluate(async id => (await fetch(`/api/sessions/${id}/snapshot`)).json(), id) : { session: null, turns: [] };
      return json(snapshot);
    }
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace: workspace, workspaces: [workspace], activeSessionId: "ordinary-session", activeSession: null, sessions: [], accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/domain-actors/actors-test/actors/summary") return json(summary);
    if (path === "/api/domain-actors/actors-test/room") return json(room);
    if (path === "/api/domain-actors/actors-test/requests") {
      const body = request.postDataJSON() as SubmitActorRequest; requests.push(body);
      const saved = round(room, body); saved.status = "no_claims"; room.rounds.push(saved); room.revision++;
      return json(saved);
    }
    // Opening a card asks the shell for that session; the mock has no such session, so it answers 404.
    if (/^\/api\/sessions\/[^/]+\/snapshot$/.test(path)) { snapshotRequests.push(path.split("/")[3]); return route.fulfill({ status: 404, json: { error: "not found" } }); }
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, workspaceName: workspace.name, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, capturedAt: timestamp, totalTasks: 0, runningTasks: 0, pendingTasks: 0, tasks: [], pendingEvents: 0 });
    if (path === "/api/events") return json({ events: [], cursor: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/sessions") return json({ sessions: [], hasMore: false, projects: [] });
    return json({ accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sideChats: [], jobs: [], actors: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.route("**/api/security/status", route => route.fulfill({ json: { configured: true, authenticated: true, canSetup: false } }));
  await page.goto(`/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&${search}`);
  return { room, errors, requests, snapshotRequests, input: page.getByRole("textbox", { name: "Message actors" }), preview: page.locator(".actor-room-mention-preview"),
    send: page.getByRole("button", { name: "Send", exact: true }), sidebarActors: page.locator("nav#sidebar-panel-actors"), cards: page.locator("#session-panel-actor-sessions article.actor-session-card"),
    row: (id: string) => page.locator(`nav#sidebar-panel-actors button.actor-list-row[data-actor-id="${id}"]`) };
}

for (const width of [1440, 900, 390]) {
  test(`manager keeps chat mounted while claims and tasks open beside it at ${width}px`, async ({ page }) => {
    const s = await shellFixture(page, "view=workspace-chat");
    await page.setViewportSize({ width, height: 900 });
    await expect(s.input).toBeVisible();
    await expect(page.locator(".workspace-manager-toggle")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Workspace manager", includeHidden: true })).toHaveCount(0);
    await expect(page.locator(".sidebar-toolbar").getByRole("button", { name: "Search sessions", exact: true, includeHidden: true })).toHaveCount(1);
    const writes: string[] = [];
    page.on("request", request => { if (request.method() !== "GET") writes.push(new URL(request.url()).pathname); });
    const saved = s.room.rounds[0];
    saved.stakeholderIds = ["root-1", "root-2", "sub-1"];
    saved.replies = ["root-1", "root-2", "sub-1"].map(actorId => ({ actorId, status: "claimed", text: `Offer from ${actorId}` }));
    s.room.workItems.find(work => work.id === "other")!.taskSessionId = "";
    s.room.revision++;
    await page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/room"));
    // Group chat: one task block per round with a line per task; claims stay open with a badge beside the name.
    const planner = page.locator('.manager-conversation .actor-room-tasks .actor-room-work[data-owner-actor-id="root-1"]');
    const reviewer = page.locator('.manager-conversation .actor-room-tasks .actor-room-work[data-owner-actor-id="root-2"]');
    const helper = page.locator('.manager-conversation article[data-actor-id="sub-1"]');
    await expect(page.locator(".manager-conversation .actor-room-round").last().locator(".actor-room-tasks")).toHaveCount(1);
    await expect(page.locator(".manager-conversation .actor-room-claims")).toHaveCount(0);
    await expect(helper.locator(".actor-room-claim-badge")).toHaveAttribute("aria-label", "Full claim");
    await expect(helper.locator(".side-chat-answer")).toHaveText("Offer from sub-1");
    await expect(helper.getByRole("button", { expanded: false })).toHaveCount(0);
    // A long brief ellipsizes inside the task block instead of widening it past the chat.
    const tasks = page.locator(".manager-conversation .actor-room-tasks");
    expect(await tasks.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(planner).toHaveCount(2);
    // The started task runs in the owner's sub-actor; the line names that relation.
    await expect(planner.and(page.locator('[data-work-item-id="started"]')).locator(".actor-room-task-toggle")).toContainText("Sub-actor of Planner");
    await expect(reviewer).toHaveCount(1);
    await expect(reviewer.getByText("Session not available yet")).toBeVisible();
    await expect(reviewer.getByRole("button", { name: "Open task", exact: true })).toHaveCount(0);
    await expect(helper.locator(".actor-room-claim")).toHaveCount(0);
    await expect(helper.getByRole("button", { name: /Open/ })).toHaveCount(0);
    await expect(page.locator(".manager-conversation .actor-room-work")).toHaveCount(3);
    await s.input.fill("Keep this draft while reading tasks");
    const editor = await s.input.elementHandle();
    const url = page.url();
    await page.route("**/api/sessions/*/snapshot", route => {
      const id = new URL(route.request().url()).pathname.split("/")[3];
      return route.fulfill({ json: { session: { id, workspaceId: "actors-test", title: `Session ${id}`, threadId: null }, turns: [{ id: `turn-${id}`, sessionId: id, userInput: "Task question", agentResponse: `Task answer ${id}`, status: "done", created: timestamp, updated: timestamp, tokenIn: 0, tokenOut: 0, accountId: null }] } });
    });
    const task = (id: string) => planner.and(page.locator(`[data-work-item-id="${id}"]`)).getByRole("button", { name: "Open task", exact: true });
    await task("started").click();
    const panel = page.locator(".manager-details > .session-main-block");
    await expect(panel.getByText("Task answer sess-started", { exact: true })).toBeVisible();
    await expect(page.locator(".manager-details iframe")).toHaveCount(0);
    expect(page.frames()).toHaveLength(1);
    await panel.locator(".composer [contenteditable=true]").fill("Only started session draft");
    await expect(page.locator(".workspace-manager-dashboard")).toBeHidden();
    await expect(page).toHaveURL(/sessionId=sess-started#view=workspace-chat$/);
    if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(s.input).toHaveText("Keep this draft while reading tasks");
    expect(await editor!.evaluate(node => node.isConnected)).toBe(true);
    await task("needs").focus(); await task("needs").press("Enter");
    await expect(panel.getByText("Task answer sess-needs", { exact: true })).toBeVisible();
    await expect(panel.getByText("Task answer sess-started", { exact: true })).toHaveCount(0);
    await expect(panel.locator(".composer [contenteditable=true]")).not.toContainText("Only started session draft");
    const composer = panel.locator(".composer");
    await expect(composer).toHaveCSS("padding", "0px");
    await expect(page.locator(".manager-title-bar")).toHaveCount(0);
    const collapse = panel.getByRole("button", { name: "Close session and show dashboard" });
    await expect(collapse).toBeInViewport();
    await expect(panel.locator(".content-header-heading > :first-child")).toHaveAttribute("aria-label", "Close session and show dashboard");
    const collapseBounds = await collapse.boundingBox();
    const headingBounds = await panel.locator(".content-header h1").boundingBox();
    expect(collapseBounds!.x + collapseBounds!.width).toBeLessThanOrEqual(headingBounds!.x);
    await expect(composer.getByRole("button", { name: "Configure model gears" })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Managed mode", exact: true })).toBeVisible();
    await expect(composer.locator("input[type=file]")).toHaveCount(1);
    await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await composer.getByRole("button", { name: "Configure model gears" }).click();
    await expect(page.getByRole("combobox", { name: "Gear 2 model", exact: true })).toBeVisible();
    await composer.getByRole("button", { name: "Configure model gears" }).click();
    await panel.getByRole("button", { name: "Concurrent", exact: true }).click();
    const dropdown = panel.getByRole("dialog", { name: "Concurrent sessions" });
    await expect(dropdown).toBeInViewport();
    const bounds = await dropdown.boundingBox();
    const frameBounds = await page.locator(".manager-details > .session-main-block").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(frameBounds!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(frameBounds!.x + frameBounds!.width + 1);
    await panel.getByRole("button", { name: "Close Concurrent" }).click();
    await panel.locator(".session-changes-tag").click();
    await expect(panel.getByRole("dialog", { name: "All session changes" })).toBeInViewport();
    await panel.locator(".session-changes-tag").click();
    await composer.getByRole("button", { name: "Round table mode", exact: true }).click();
    await expect(panel.getByRole("dialog", { name: "Round table settings", exact: true })).toBeInViewport();
    await panel.getByRole("button", { name: "Round table settings", exact: true }).press("Escape");
    await composer.getByRole("button", { name: "Round table mode", exact: true }).click();
    await panel.locator(".composer [contenteditable=true]").fill("Only session needs draft");
    await page.screenshot({ path: `/private/tmp/threadex-manager-full-session-${width}.png` });
    const close = page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" });
    await close.focus(); await close.press("Enter");
    await expect(page.locator(".manager-details > .session-main-block")).toHaveCount(0);
    await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
    if (width >= 768) {
      await expect(task("needs")).toBeFocused();
      const chat = await page.locator(".manager-conversation").boundingBox();
      const details = await page.locator(".manager-details").boundingBox();
      expect(chat!.x + chat!.width).toBeLessThanOrEqual(details!.x + 1);
    } else await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(s.input).toHaveText("Keep this draft while reading tasks");
    await expect(s.send).toBeInViewport();
    expect(await page.locator(".manager-workspace").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/private/tmp/threadex-manager-${width}.png` });
    // Opening the complete session retains its existing selection and policy sync.
    expect(writes.filter(path => path !== "/api/sessions/switch" && !path.startsWith("/api/session-approval-policy/"))).toEqual([]);
    expect(s.errors).toEqual([]);
  });
}

test("embedded full composer sends attachments and suggestions to its selected session", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await page.route("**/api/sessions/sess-started/snapshot", route => route.fulfill({ json: { session: { id: "sess-started", workspaceId: "actors-test", title: "Send target" }, turns: [] } }));
  await page.route("**/api/composer-suggestions?*", route => route.fulfill({ json: { entries: [{ path: "src/example.ts", kind: "file" }] } }));
  const sent: any[] = [];
  await page.route("**/api/chat", async route => {
    const body = route.request().postDataJSON(); sent.push(body);
    await route.fulfill({ contentType: "text/event-stream", body: `event: result\ndata: ${JSON.stringify({ sessionId: body.sessionId, turnId: body.turnId, reply: "Submission received", elapsedMs: 1 })}\n\nevent: done\ndata: {"ok":true}\n\n` });
  });
  await s.input.fill("Actor draft stays here");
  await page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: "Open task", exact: true }).click();
  const frame = page.locator(".manager-details > .session-main-block");
  const composer = frame.locator("form.composer");
  const editor = composer.getByRole("textbox", { name: "Message", exact: true });
  await expect(frame.locator(".content-header h1")).toHaveText("Send target");
  await editor.fill("example");
  await frame.getByRole("option", { name: /example.ts/ }).click();
  await composer.locator("input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Manager attachment") });
  await expect(composer).toContainText("notes.txt");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].sessionId).toBe("sess-started");
  expect(sent[0].workspaceId).toBe("actors-test");
  expect(sent[0].message).toContain("src/example.ts");
  expect(sent[0].attachments[0].name).toBe("notes.txt");
  await expect(frame.getByText("Submission received", { exact: true })).toBeVisible();
  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  await expect(s.input).toHaveText("Actor draft stays here");
  expect(s.requests).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("running session keeps queue and steer controls and closing never stops its runner", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await page.route("**/api/sessions/sess-started/snapshot", route => route.fulfill({ json: {
    session: { id: "sess-started", workspaceId: "actors-test", title: "Running target" },
    turns: [{ id: "running-turn", sessionId: "sess-started", userInput: "Work in progress", agentResponse: "", status: "running", created: timestamp, updated: timestamp, tokenIn: 0, tokenOut: 0, accountId: null }]
  } }));
  const stops: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/runner/stop") stops.push(request.postData() ?? ""); });
  await page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: "Open task", exact: true }).click();
  const frame = page.locator(".manager-details > .session-main-block");
  const composer = frame.locator("form.composer");
  await expect(composer.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
  // Esc in the manager must never cancel tasks shown in the right-hand panel.
  await s.input.press("Escape");
  await s.input.press("Escape");
  await composer.getByRole("textbox", { name: "Message", exact: true }).press("Escape");
  await composer.getByRole("textbox", { name: "Message", exact: true }).press("Escape");
  await page.locator("body").press("Escape");
  await page.locator("body").press("Escape");
  await frame.getByRole("button", { name: "Concurrent", exact: true }).click();
  const dropdown = frame.getByRole("dialog", { name: "Concurrent sessions", exact: true });
  await expect(dropdown).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dropdown).toBeHidden();
  await expect(page.getByText("Press Esc again to stop agent", { exact: true })).toHaveCount(0);
  expect(stops).toEqual([]);
  await composer.getByRole("textbox", { name: "Message", exact: true }).fill("Follow up");
  await expect(composer.getByRole("button", { name: "Queue", exact: true })).toBeEnabled();
  await expect(composer.getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  expect(stops).toEqual([]);
  // Explicit controls remain available after returning to the dashboard.
  await page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: "Open task", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
  await composer.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
  const stopped = page.waitForRequest(request => new URL(request.url()).pathname === "/api/runner/stop");
  await composer.getByRole("button", { name: "Stop agent", exact: true }).click();
  expect((await stopped).postDataJSON()).toEqual({ turnId: "running-turn", sessionId: "sess-started" });
  const actorStop = page.locator(".manager-conversation").getByRole("button", { name: "Stop", exact: true });
  await expect(actorStop).toHaveAttribute("title", "Stop");
  await actorStop.click();
  await expect.poll(() => stops.map(body => JSON.parse(body).turnId).sort()).toEqual(["running-turn", "turn-other", "turn-started"]);
  expect(s.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`right task session shows its own queued prompt at ${width}px`, async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await page.setViewportSize({ width, height: 900 });
  const queuedBySession: Record<string, Array<Record<string, unknown>>> = {};
  await page.route("**/api/sessions/*/snapshot", route => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: {
      session: { id, workspaceId: "actors-test", title: `Session ${id}` },
      turns: [
        { id: `turn-${id}`, sessionId: id, userInput: "Work in progress", agentResponse: "", status: "running", created: timestamp, updated: timestamp, tokenIn: 0, tokenOut: 0, accountId: null },
        ...(queuedBySession[id] ?? [])
      ]
    } });
  });
  const queuedForSessions: string[] = [];
  await page.route("**/api/pending-turns", route => {
    const body = route.request().postDataJSON();
    queuedForSessions.push(body.sessionId);
    queuedBySession[body.sessionId] ??= [];
    queuedBySession[body.sessionId].push({ id: body.turnId, sessionId: body.sessionId, userInput: body.message, agentResponse: "", status: "todo", pendingReason: "queued", created: timestamp, updated: timestamp, tokenIn: 0, tokenOut: 0, accountId: null });
    return route.fulfill({ json: { ok: true, turn: { id: body.turnId, status: "todo" } } });
  });
  await page.route("**/api/pending-turns/*", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const body = route.request().postDataJSON();
    queuedBySession[body.sessionId] = (queuedBySession[body.sessionId] ?? []).filter(turn => turn.id !== id);
    return route.fulfill({ json: { ok: true } });
  });

  const openTask = (id: string) => page.locator(`.manager-conversation [data-work-item-id="${id}"]`).getByRole("button", { name: "Open task", exact: true });
  await openTask("started").click();
  const details = page.locator(".manager-details > .session-main-block");
  const composer = details.locator("form.composer");
  await composer.getByRole("textbox", { name: "Message", exact: true }).fill("Queue in the started task");
  const queueButton = composer.getByRole("button", { name: "Queue", exact: true });
  await expect(queueButton).toBeInViewport();
  await queueButton.click();
  const queuedPrompts = composer.locator(".queued-prompts");
  const queuedPrompt = queuedPrompts.locator(".queued-prompt");
  await expect(queuedPrompt).toContainText("Queue in the started task");
  expect(queuedForSessions).toEqual(["sess-started"]);
  await expect(queuedPrompts).toHaveCSS("display", "grid");
  await expect(queuedPrompt).toBeInViewport();
  await expect(queuedPrompt.locator(".queued-prompt-text")).toBeVisible();
  await expect(composer.getByRole("button", { name: "Stop agent", exact: true })).toBeInViewport();
  if (width === 390) {
    const card = await queuedPrompt.boundingBox();
    const text = await queuedPrompt.locator(".queued-prompt-text").boundingBox();
    const actions = await queuedPrompt.locator(".queued-prompt-actions").boundingBox();
    expect(text!.width).toBeGreaterThan(20);
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
    expect(await page.locator(".manager-workspace").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  }
  for (let index = 2; index <= 6; index++) {
    const message = `Queue item ${index}`;
    await composer.getByRole("textbox", { name: "Message", exact: true }).fill(message);
    await composer.getByRole("button", { name: "Queue", exact: true }).click();
  }
  await expect(queuedPrompt).toHaveCount(6);
  expect(queuedForSessions).toEqual(Array(6).fill("sess-started"));
  await expect.poll(() => queuedPrompts.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  const lastQueuedPrompt = queuedPrompt.last();
  await lastQueuedPrompt.scrollIntoViewIfNeeded();
  await expect(lastQueuedPrompt).toContainText("Queue item 6");

  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
  await openTask("needs").click();
  const otherComposer = page.locator(".manager-details > .session-main-block form.composer");
  await expect(otherComposer.locator(".queued-prompt")).toHaveCount(0);
  await expect(otherComposer).not.toContainText("Queue in the started task");

  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
  await openTask("started").click();
  const restoredPrompt = page.locator(".manager-details > .session-main-block form.composer .queued-prompt").filter({ hasText: "Queue in the started task" });
  await expect(restoredPrompt).toContainText("Queue in the started task");
  await restoredPrompt.getByRole("button", { name: "Delete queued prompt", exact: true }).click();
  await expect(restoredPrompt).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&sessionId=sess-started");
  await expect(page.locator(".manager-workspace")).toHaveCount(0);
  await expect(page.locator(".prompt-turn-queue")).toBeVisible();
  await expect(page.locator(".prompt-turn-queue .prompt-turn-card-queued")).toHaveCount(5);
  await expect(page.locator(".prompt-turn-queue")).toContainText("Queue item 6");
  await expect(page.locator(".session-main-block > .composer > .queued-prompts")).toHaveCount(0);
  expect(s.errors).toEqual([]);
});

test("standalone running session still supports the double Escape stop shortcut", async ({ page }) => {
  const s = await shellFixture(page);
  await page.route("**/api/sessions/sess-started/snapshot", route => route.fulfill({ json: {
    session: { id: "sess-started", workspaceId: "actors-test", title: "Standalone running target" },
    turns: [{ id: "standalone-turn", sessionId: "sess-started", userInput: "Work", agentResponse: "", status: "running", created: timestamp, tokenIn: 0, tokenOut: 0 }]
  } }));
  const stops: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/runner/stop") stops.push(request.postData() ?? ""); });
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&sessionId=sess-started");
  await expect(page.locator(".manager-workspace")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeVisible();
  await page.locator("body").press("Escape");
  await expect(page.getByText("Press Esc again to stop agent", { exact: true })).toBeVisible();
  expect(stops).toEqual([]);
  await page.locator("body").press("Escape");
  await expect.poll(() => stops.map(body => JSON.parse(body))).toEqual([{ turnId: "standalone-turn", sessionId: "sess-started" }]);
  expect(s.errors).toEqual([]);
});

test("native session navigation returns to the dashboard and the standalone block retains its controls", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await page.route("**/api/sessions/sess-started/snapshot", route => route.fulfill({ json: { session: { id: "sess-started", workspaceId: "actors-test", title: "Shared main block" }, turns: [] } }));
  const open = page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: "Open task", exact: true });
  await open.click();
  await expect(page.locator(".session-main-block .content-header h1")).toHaveText("Shared main block");
  await page.getByRole("button", { name: "All workers", exact: false }).click();
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  await expect(page.locator(".session-main-block")).toHaveCount(0);
  await open.click();
  await expect(page.locator(".session-main-block .content-header h1")).toHaveText("Shared main block");
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&sessionId=sess-started");
  await expect(page.locator(".manager-workspace")).toHaveCount(0);
  await expect(page.locator(".content-header h1")).toHaveText("Shared main block");
  await expect(page.locator(".content-header-actions").getByRole("button", { name: "Concurrent", exact: true })).toBeVisible();
  await expect(page.locator(".content-header-actions .session-changes-tag")).toBeVisible();
  await expect(page.locator("form.composer [contenteditable=true]")).toBeVisible();
  expect(s.errors).toEqual([]);
});

test("global session list leaves Manager previews and keeps URL, reload and history in sync", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  const sessions = ["started", "needs"].map(name => ({ id: `sess-${name}`, workspaceId: "actors-test", cwd: "/tmp/actors", title: `Global ${name}`, created: timestamp, updated: timestamp }));
  await page.route(url => url.pathname === "/api/sessions", route => route.fulfill({ json: { sessions, hasMore: false, projects: [] } }));
  await page.route("**/api/workspace/snapshot*", route => route.fulfill({ json: {
    activeWorkspace: { id: "actors-test", name: "Actor workspace", cwd: "/tmp/actors", accountIds: [] },
    workspaces: [], activeSessionId: null, activeSession: null, sessions, accounts: [], workspaceAccounts: [],
    sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0
  } }));
  await page.route("**/api/sessions/*/snapshot", route => {
    const session = sessions.find(session => new URL(route.request().url()).pathname.split("/")[3] === session.id);
    return route.fulfill({ json: { session, turns: [] } });
  });
  await page.reload();
  await expect(page).toHaveURL(/#view=workspace-chat$/);
  const managerUrl = page.url();
  const row = (id: string) => page.locator(`button.session-row[data-session-id="${id}"]`);
  const checkSession = async (index: number) => {
    await expect(page).toHaveURL(new RegExp(`workspaceId=actors-test&sessionId=${sessions[index].id}$`));
    await expect(page.locator(".manager-workspace")).toHaveCount(0);
    await expect(page.locator(".content-header h1")).toHaveText(sessions[index].title);
  };
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  // Direct navigation from the sessionless Manager entry.
  await row("sess-started").click();
  await checkSession(0);
  await page.goBack();
  await expect(page).toHaveURL(managerUrl);
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  // A previous claim/task preview must not capture subsequent global navigation,
  // even when the user selects the very same session from the list.
  await page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: "Open task", exact: true }).click();
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global started");
  await expect(page).toHaveURL(/sessionId=sess-started#view=workspace-chat$/);
  const taskUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global started");
  await page.goBack();
  await expect(page).toHaveURL(managerUrl);
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global started");
  await row("sess-started").click();
  await checkSession(0);
  await row("sess-needs").click();
  await checkSession(1);
  await page.reload();
  await checkSession(1);
  await page.goBack();
  await checkSession(0);
  await page.goBack();
  await expect(page).toHaveURL(taskUrl);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global started");
  await page.goForward();
  await checkSession(0);
  await page.goForward();
  await checkSession(1);
  // Opening the room over a normal session clears the session and shows the dashboard.
  await page.getByRole("tab", { name: "Workers", exact: false }).click();
  const beforeOpen = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "All workers", exact: false }).click();
  await expect(page).toHaveURL(managerUrl);
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(beforeOpen + 1);
  // A task opened inside the room keeps a combined deep link across reload.
  const openNeeds = page.locator('.manager-conversation [data-work-item-id="needs"]').getByRole("button", { name: "Open task", exact: true });
  await openNeeds.click();
  await expect(page).toHaveURL(/sessionId=sess-needs#view=workspace-chat$/);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global needs");
  const combinedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(combinedUrl);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global needs");
  expect(await page.evaluate(() => history.length)).toBe(beforeOpen + 2);
  // Reopening the same task must not append a duplicate history entry.
  await openNeeds.click();
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global needs");
  expect(await page.evaluate(() => history.length)).toBe(beforeOpen + 2);
  await page.goBack();
  await expect(page).toHaveURL(managerUrl);
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(combinedUrl);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global needs");
  // A pasted combined deep link also preserves the selected turn.
  await page.goto(`${combinedUrl.replace("#", "&turnId=turn-focus#")}`);
  await expect(page.locator(".manager-details .content-header h1")).toHaveText("Global needs");
  await expect(page).toHaveURL(/sessionId=sess-needs&turnId=turn-focus#view=workspace-chat$/);
  expect(s.errors).toEqual([]);
});

test("manager ignores a late session response and recovers from a missing session", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await expect(page.locator('.manager-conversation [data-work-item-id="started"]')).toBeVisible();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/sessions/sess-started/snapshot", async route => {
    await delayed;
    await route.fulfill({ json: { session: { id: "sess-started", workspaceId: "actors-test", title: "Late session" }, turns: [] } }).catch(() => {});
  });
  const open = (id: string) => page.locator(`.manager-conversation [data-work-item-id="${id}"]`).getByRole("button", { name: "Open task", exact: true });
  await open("started").click();
  await open("needs").click();
  const panel = page.getByRole("region", { name: "Task session", exact: true });
  await expect(panel.getByRole("alert")).toContainText("not found");
  await expect(panel.locator(".manager-task-header > :first-child")).toHaveAttribute("aria-label", "Close session and show dashboard");
  release();
  await expect(panel.getByRole("heading")).toHaveText("sess-needs");
  await expect(panel.getByText("Late session", { exact: true })).toHaveCount(0);
  await page.route("**/api/sessions/sess-needs/snapshot", route => route.fulfill({ json: { session: { id: "sess-needs", workspaceId: "actors-test", title: "Recovered session" }, turns: [] } }));
  await panel.getByRole("button", { name: "Retry session" }).click();
  await expect(page.locator(".manager-details > .session-main-block").locator(".content-header h1")).toHaveText("Recovered session");
  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".workspace-manager-dashboard")).toBeVisible();
  expect(s.errors).toEqual([]);
});

test("a reloaded group chat + session link keeps the composer and explains an ended worker instead of a blank", async ({ page }) => {
  const s = await shellFixture(page, "sessionId=sess-started#view=workspace-chat");
  let group: unknown = null;
  await page.route("**/api/sessions/sess-started/snapshot", route => route.fulfill({ json: { session: { id: "sess-started", workspaceId: "actors-test", title: "Linked task" }, turns: [] } }));
  await page.route("**/api/concurrent/sessions/sess-started", route => route.fulfill({ json: { group } }));
  await page.reload();
  const details = page.locator(".manager-details > .session-main-block");
  await expect(details.locator(".content-header h1")).toHaveText("Linked task");
  await expect(details.locator("form.composer")).toBeVisible();
  await expect(details.locator(".composer-ended-notice")).toHaveCount(0);
  const member = (localId: string, sessionId: string) => ({ localId, sessionId, task: "Steered", sourceSessionId: sessionId, sourceTurnId: null, fork: null, model: DEFAULT_MODEL, effort: "medium", stopped: false, observed: {} });
  // Actor steering records its target as a worker of an actor_tree_* coordination group.
  group = { id: "actor_tree_test", workspaceId: "actors-test", mainSessionId: "sess-main", revision: 1, created: timestamp, updated: timestamp, lease: null,
    members: [member("main", "sess-main"), member("sess-started", "sess-started")], messages: [], results: [],
    activity: { main: { status: "idle" }, "sess-started": { status: "idle" } } };
  await page.reload();
  await expect(details.locator(".content-header h1")).toHaveText("Linked task");
  await expect(details.locator(".composer-ended-notice")).toHaveText("This Concurrent worker has ended and cannot accept new prompts.");
  await expect(details.locator("form.composer")).toBeHidden();
  expect(s.errors).toEqual([]);
});

test("a claim and dashboard card open their exact session and a foreign workspace is rejected", async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  s.room.workItems = s.room.workItems.filter(work => work.id === "started");
  s.room.rounds[0].status = "assigned";
  s.room.rounds[0].replies = [{ actorId: "root-1", status: "claimed", text: "I can take this" }];
  s.room.rounds[0].stakeholderIds = ["root-1"];
  s.room.revision++;
  await page.route("**/api/workspace-manager?*", route => route.fulfill({ json: { manager: null, capturedAt: timestamp, runningTasks: 1, pendingTasks: 0, tasks: [{ sessionId: "dashboard-session", title: "Dashboard task", status: "running", comments: [], queuedTurns: 0 }], pendingEvents: 0 } }));
  await page.route("**/api/sessions/*/snapshot", route => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: { session: { id, workspaceId: id === "dashboard-session" ? "another-workspace" : "actors-test", title: `Exact ${id}` }, turns: [] } });
  });
  await page.reload();
  await s.input.fill("Preserved draft");
  const url = page.url();
  await page.locator('.manager-conversation [data-work-item-id="started"]').getByRole("button", { name: /^Open (task|host session)$/ }).click();
  const panel = page.locator(".manager-details > .session-main-block");
  await expect(panel.locator(".content-header h1")).toHaveText("Exact sess-started");
  await expect(panel.locator(".composer [contenteditable=true]")).toBeVisible();
  // Reopening the current task refreshes it rather than leaving a loading panel.
  await page.locator(".manager-conversation").getByRole("button", { name: "Open task", exact: true }).click();
  await expect(panel.locator(".content-header h1")).toHaveText("Exact sess-started");
  await page.screenshot({ path: "/private/tmp/threadex-manager-session.png" });
  await page.locator(".manager-details").getByRole("button", { name: "Close session and show dashboard" }).click();
  await page.getByRole("button", { name: "Dashboard task", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This session is not available in this workspace.");
  await page.getByRole("button", { name: "Close session and show dashboard" }).click();
  await expect(page.getByRole("button", { name: "Dashboard task", exact: true })).toBeVisible();
  await expect(s.input).toHaveText("Preserved draft");
  expect(page.url()).toBe(url);
  expect(s.errors).toEqual([]);
});

for (const width of [1440, 390]) test(`group chat round table opens its own session beside the chat, survives reload and links back at ${width}px`, async ({ page }) => {
  const s = await shellFixture(page, "view=workspace-chat");
  await page.setViewportSize({ width, height: 900 });
  const session = { id: "rt-session", workspaceId: "actors-test", cwd: "/tmp/actors", title: "Billing split", threadId: null, created: timestamp, updated: timestamp };
  const turns = [{ id: "rt-turn", sessionId: session.id, userInput: "Should we split billing?", agentResponse: "Round table answer in its own session", status: "done", created: timestamp, updated: timestamp, tokenIn: 0, tokenOut: 0, accountId: null }];
  const view = { requestId: "", workspaceId: "actors-test", sessionId: session.id, turnId: "rt-turn", title: "Billing split", prompt: "Should we split billing?", contextSummary: "",
    actorNames: ["Critic", "Builder"], sourceRoundId: null, created: "2026-10-22T21:30:00.000Z", state: "done", rounds: 1, conclusion: "Split billing exports first.", error: null };
  const starts: any[] = [];
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { revision: 1, actors: [
    { type: "consultant", id: "critic", name: "Critic", model: DEFAULT_MODEL, effort: "high", rolePrompt: "", isDefault: true },
    { type: "consultant", id: "builder", name: "Builder", model: DEFAULT_MODEL, effort: "high", rolePrompt: "", isDefault: true }] } }));
  await page.route("**/api/domain-actors/actors-test/roundtables**", route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/sessions/rt-session")) return route.fulfill({ json: { roundtable: starts.length ? view : null } });
    if (path.includes("/sessions/")) return route.fulfill({ json: { roundtable: null } });
    if (request.method() === "POST") {
      const body = request.postDataJSON(); starts.push(body);
      if (!view.requestId) {
        view.requestId = body.requestId;
        const { state: _s, rounds: _r, conclusion: _c, error: _e, ...link } = view;
        s.room.roundtables = [link]; s.room.revision++;
      }
      return route.fulfill({ json: view });
    }
    return route.fulfill({ json: { roundtables: starts.length ? [view] : [] } });
  });
  await page.route("**/api/sessions/rt-session/snapshot", route => route.fulfill({ json: { session, turns } }));
  // Answer switches directly so a navigation cannot interrupt the fixture's in-page snapshot read.
  await page.route("**/api/sessions/switch", route => route.fulfill({ json: route.request().postDataJSON()?.sessionId === session.id ? { session, turns } : { session: null, turns: [] } }));
  await page.route("**/api/sessions/ordinary-session/snapshot", route => route.fulfill({ status: 404, json: { error: "not found" } }));
  await expect(s.input).toBeVisible();
  const managerUrl = page.url();
  const chat = page.locator(".manager-conversation");
  await chat.getByRole("button", { name: "Round table mode", exact: true }).click();
  await expect(chat.getByRole("group", { name: "Round table actors" })).toContainText("Critic, Builder");
  await s.input.fill("Should we split billing?");
  await s.send.click();
  // Left: the group chat with a reference card; right: the new session with the existing transcript UI.
  await expect(page).toHaveURL(/sessionId=rt-session#view=workspace-chat$/);
  const panel = page.locator(".manager-details > .session-main-block");
  await expect(panel.getByText("Round table answer in its own session", { exact: true })).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(s.requests).toHaveLength(0);
  // Inside the split the chat is already beside the session, so the source link is not repeated.
  await expect(panel.getByRole("button", { name: "Open group chat that started this round table" })).toHaveCount(0);
  if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
  const card = chat.locator("button.actor-roundtable-card");
  await expect(card).toContainText("Billing split");
  await expect(card).toContainText("Critic, Builder");
  await expect(card.locator(".actor-roundtable-state")).toHaveText("Done");
  await expect(card).toContainText("Split billing exports first.");
  await expect(card).toBeInViewport();
  const taskUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(taskUrl);
  // A reloaded deep link shows the linked session first, also on a phone.
  await expect(page.locator(".manager-details > .session-main-block").getByText("Round table answer in its own session", { exact: true })).toBeVisible();
  if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(chat.locator("button.actor-roundtable-card")).toHaveCount(1);
  await page.goBack();
  await expect(page).toHaveURL(managerUrl);
  await page.goForward();
  await expect(page).toHaveURL(taskUrl);
  // The same session opened on its own links back to the group chat that started it.
  await page.route(url => url.pathname === "/api/sessions", route => route.fulfill({ json: { sessions: [session], hasMore: false, projects: [] } }));
  await page.route("**/api/workspace/snapshot*", route => route.fulfill({ json: {
    activeWorkspace: { id: "actors-test", name: "Actor workspace", cwd: "/tmp/actors", accountIds: [] },
    workspaces: [], activeSessionId: null, activeSession: null, sessions: [session], accounts: [], workspaceAccounts: [],
    sessionExecutionStatuses: {}, approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 } }));
  await page.goto("/e2e/support/actor-room.html?shell=1&workspaceId=actors-test&sessionId=rt-session");
  await expect(page.locator(".manager-workspace")).toHaveCount(0);
  await expect(page.getByText("Round table answer in its own session", { exact: true })).toBeVisible();
  const source = page.getByRole("button", { name: "Open group chat that started this round table" });
  await expect(source).toBeVisible();
  await source.click();
  await expect(page).toHaveURL(/sessionId=rt-session#view=workspace-chat$/);
  await expect(page.locator(".manager-workspace")).toHaveCount(1);
  if (width < 768) await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(chat.locator("button.actor-roundtable-card")).toBeVisible();
  expect(await page.locator(".manager-workspace").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expect(s.errors).toEqual([]);
});
