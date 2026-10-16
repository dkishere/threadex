import { expect, test } from "./support/authenticated-test";
import { apiBaseUrl, selectSession } from "./support/mock-runner";
import { scenarioSessions } from "./support/scenarios";
import { DEFAULT_MODEL, MODEL_CATALOG, normalizeModelId } from "../src/modelCatalog";
import type { RoundtableRound } from "../src/roundtable";
test.beforeEach(async ({ page }) => {
  await page.route("https://api.dicebear.com/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c4b5fd"/><circle cx="32" cy="32" r="18" fill="#7c3aed"/></svg>' }));
});

test("legacy selected actors use the saved preset avatar after loading and reopening", async ({ page, request }) => {
  const sessionId = scenarioSessions.switchAlpha.id;
  const avatar = "https://api.dicebear.com/10.x/pixel-art/svg?seed=saved-avatar";
  await page.route("**/api/settings/roundtable-actors", route => route.fulfill({ json: { revision: 2, actors: [
    { id: "astra-preset", name: "AstraXH", model: MODEL_CATALOG.astra.id, effort: "xhigh", rolePrompt: "", isDefault: true, avatar }
  ] } }));
  await page.addInitScript(({ sessionId, model }) => {
    const key = `threadex.roundtable:default:${sessionId}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ enabled: true, actors: [
      { id: "legacy-astra", name: "AstraXH", model, effort: "xhigh", systemPrompt: "" },
      { id: "other", name: "Other", model, effort: "high", systemPrompt: "" }
    ] }));
  }, { sessionId, model: MODEL_CATALOG.astra.id });
  await selectSession(request, sessionId);
  await page.goto(`/?workspaceId=default&sessionId=${sessionId}`);
  const toggle = page.getByRole("button", { name: "Round table mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  const image = page.getByRole("dialog", { name: "Round table settings" }).getByRole("img", { name: "AstraXH avatar" });
  await expect(image).toHaveAttribute("src", avatar);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(image).toHaveAttribute("src", avatar);
});

test("saved actors can be edited in Settings, selected as defaults and reused in round tables", async ({ page, request }) => {
  let library: any = { revision: 0, actors: [] };
  await page.route("**/api/settings/roundtable-actors", async route => {
    if (route.request().method() === "PUT") library = { ...route.request().postDataJSON(), revision: library.revision + 1 };
    await route.fulfill({ json: library });
  });
  await selectSession(request, scenarioSessions.switchAlpha.id);
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchAlpha.id}`);
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /^Toggle workspace menu/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Agent actors" }).click();
  const panel = page.getByRole("tabpanel", { name: "Agent actors" });
  await panel.getByRole("button", { name: "Add saved actor" }).click();
  const first = panel.getByRole("region", { name: "Saved actor 1" });
  await first.getByLabel("Name", { exact: true }).fill("Sceptic");
  await first.getByLabel("Model", { exact: true }).selectOption(MODEL_CATALOG.claudeSonnet.id);
  await first.getByLabel("Role prompt").fill("Challenge the assumptions");
  await expect(first.getByLabel("Effort", { exact: true }).locator('option[value="ultra"]')).toHaveCount(0);
  await first.getByLabel("Effort", { exact: true }).selectOption("max");
  await first.getByLabel("Default actor").check();
  const avatarPng = await first.locator(".actor-avatar").screenshot();
  await first.getByLabel("Upload avatar").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: avatarPng });
  await expect(first.locator(".actor-avatar img")).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await panel.getByRole("button", { name: "Add saved actor" }).click();
  const second = panel.getByRole("region", { name: "Saved actor 2" });
  await second.getByLabel("Name", { exact: true }).fill("Builder");
  await second.getByLabel("Role prompt").fill("Consider feasibility");
  await panel.getByRole("button", { name: "Save actors", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved.");
  await panel.screenshot({ path: "/private/tmp/threadex-roundtable-library.png" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Round table settings" });
  await dialog.getByText("Customise selected actors", { exact: true }).click();
  await expect(dialog.locator(".roundtable-actor-grid .actor-avatar img").first()).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await dialog.getByRole("button", { name: "Edit actor 1", exact: true }).click();
  await expect(dialog.getByLabel("Actor 1 name")).toHaveValue("Sceptic");
  await expect(dialog.getByLabel("Actor 1 effort")).toHaveValue("max");
  await expect(dialog.getByLabel("Actor 1 model")).toHaveValue(MODEL_CATALOG.claudeSonnet.id);
  await expect(dialog.getByLabel("Actor 1 system prompt")).toHaveValue("Challenge the assumptions");
  const removedName = await dialog.locator(".roundtable-actor-tile").nth(1).locator("strong").innerText();
  await dialog.getByRole("button", { name: "Select actors", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Builder", exact: true }).check();
  await expect(dialog.locator(".roundtable-actor-tile")).toHaveCount(3);
  await dialog.getByRole("checkbox", { name: removedName, exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Edit actor 2", exact: true }).click();
  await expect(dialog.getByLabel("Actor 2 system prompt")).toHaveValue("Consider feasibility");
  await dialog.getByRole("button", { name: "Select actors", exact: true }).click();
  await dialog.getByRole("button", { name: "Manage actors", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Agent actor settings", exact: true });
  await expect(popup).toBeVisible();
  const added = popup.getByRole("region", { name: "Saved actor 3" });
  await added.getByLabel("Name", { exact: true }).fill("Designer");
  await added.getByLabel("DiceBear style").selectOption("lorelei");
  await added.getByRole("button", { name: "Shuffle DiceBear" }).click();
  await popup.getByRole("button", { name: "Save actors", exact: true }).click();
  await expect(popup.getByRole("status")).toContainText("Saved.");
  await popup.getByRole("button", { name: "Close actor settings" }).click();
  await dialog.getByRole("button", { name: "Select actors", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Designer", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog.locator(".roundtable-actor-tile").last().locator("img")).toHaveAttribute("src", /lorelei/);
  await dialog.getByRole("button", { name: "Edit actor 2", exact: true }).click();
  await dialog.screenshot({ path: "/private/tmp/threadex-roundtable-avatar-grid.png" });
  await page.reload();
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  await dialog.getByText("Customise selected actors", { exact: true }).click();
  await expect(dialog.locator(".roundtable-actor-tile").nth(1)).toContainText("Builder");
  await expect(dialog.locator(".roundtable-actor-tile")).toHaveCount(3);
});

test("composer round table highlights the input and requires re-enabling for each prompt", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  await selectSession(request, session.id);
  const baseline = await (await request.get(`${apiBaseUrl}/api/sessions/${session.id}/snapshot`)).json();
  const rounds: RoundtableRound[] = [];
  const submissions: any[] = [];
  let nativeChatRequests = 0;
  page.on("request", req => { if (req.url().endsWith("/api/chat") && req.method() === "POST") nativeChatRequests++; });
  await page.route("**/api/roundtable/sessions/*", route => route.fulfill({ json: { rounds } }));
  const sessionSnapshot = () => ({ ...baseline,
    turns: [...baseline.turns, ...rounds.map(round => ({ id: round.turnId, sessionId: session.id, userInput: round.prompt,
      agentResponse: round.status === "done" ? round.summary : "Round table in progress", status: round.status === "done" ? "done" : ["queued", "actors"].includes(round.status) ? "todo" : "running",
      created: round.created, tokenIn: 0, tokenOut: 0, runnerPid: null, runnerLogPath: null, pendingReason: round.status === "actors" ? "stopped" : round.status === "queued" ? "queued" : null,
      requestMetadata: { roundtable: true }, liveItems: [], developerInstructions: [], steerMessages: [] }))] });
  await page.route(`**/api/sessions/${session.id}/snapshot`, route => route.fulfill({ json: sessionSnapshot() }));
  await page.route("**/api/workspace/snapshot*", async route => {
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.activeSessionId === session.id && payload.activeSession) payload.activeSession = sessionSnapshot();
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/roundtable/turns", async route => {
    const body = route.request().postDataJSON(); submissions.push(body);
    const round: RoundtableRound = { turnId: body.turnId, sessionId: session.id, prompt: body.message, revision: 1,
      created: new Date(Date.now() + rounds.length * 1000).toISOString(), status: rounds.length ? "queued" : "actors",
      context: "Host constraints", summarizerModel: DEFAULT_MODEL, hostModel: DEFAULT_MODEL, hostEffort: "high",
      answers: body.actors.map((actor: any) => ({ actor, text: "", status: "running", error: null })), summary: "", error: null, tokenIn: 0, tokenOut: 0 };
    rounds.push(round);
    await route.fulfill({ status: 202, json: { sessionId: session.id, round } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const toggle = page.getByRole("button", { name: "Round table mode", exact: true });
  const surface = page.locator(".composer .composer-shell");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(surface).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await toggle.click();
  await page.mouse.move(0, 0);
  await expect(toggle).toContainText("Next prompt only");
  await expect(surface).toHaveCSS("background-color", "rgb(245, 243, 255)");
  await expect(toggle).toHaveCSS("background-color", "rgb(124, 58, 237)");
  const settings = page.getByRole("dialog", { name: "Round table settings" });
  await expect(settings).toBeVisible();
  await settings.getByText("Customise selected actors", { exact: true }).click();
  await expect(settings.locator(".roundtable-actor-tile")).toHaveCount(2);
  await settings.getByRole("button", { name: "Edit actor 1", exact: true }).click();
  await expect(settings.getByLabel("Actor 1 model")).toHaveValue(normalizeModelId(baseline.modelPreferences.gearProfiles[0].model));
  await expect(settings.getByLabel("Actor 1 system prompt")).toHaveValue("");
  const firstName = await settings.getByLabel("Actor 1 name").inputValue();
  await settings.getByRole("button", { name: "Edit actor 2", exact: true }).click();
  await expect(settings.getByLabel("Actor 2 model")).toHaveValue(normalizeModelId(baseline.modelPreferences.gearProfiles[1].model));
  await expect(settings.getByLabel("Actor 2 system prompt")).toHaveValue("");
  expect(firstName).not.toBe(await settings.getByLabel("Actor 2 name").inputValue());
  await settings.getByLabel("Actor 2 model").selectOption(MODEL_CATALOG.claudeSonnet.id);
  await settings.getByLabel("Actor 2 system prompt").fill("Focus on risks");
  await settings.screenshot({ path: "/private/tmp/threadex-roundtable-settings.png" });
  await expect(page.locator(".content-header-actions .concurrent-widget")).toBeVisible();
  await expect(page.locator(".content-header-actions .roundtable-widget")).toBeVisible();
  await settings.getByRole("button", { name: "Close round table settings" }).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Discuss the migration options");
  await surface.screenshot({ path: "/private/tmp/threadex-roundtable-composer-active.png" });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const progress = page.locator(".messages .roundtable-turn").first();
  await expect(progress).toContainText("Actors thinking");
  await expect(page.locator(".messages .turn-status").filter({ hasText: "Stopped" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit queued prompt", exact: true })).toHaveCount(0);
  await expect(progress.locator(".roundtable-answer")).toHaveCount(2);
  await expect(progress.locator(".actor-avatar img")).toHaveCount(2);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(surface).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(composer).not.toContainText("Discuss the migration options");
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(settings.locator(".roundtable-actor-tile")).toHaveCount(2);
  await settings.getByRole("button", { name: "Close round table settings" }).click();
  await composer.fill("Also consider rollout cost");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(submissions).toHaveLength(2);
  expect(submissions.map(body => body.sessionId)).toEqual([session.id, session.id]);
  expect(submissions[1].actors).toEqual(submissions[0].actors);
  expect(submissions[0].actors[1].model).toBe(MODEL_CATALOG.claudeSonnet.id);
  expect(nativeChatRequests).toBe(0);
  rounds[0].answers.forEach(answer => { answer.status = "done"; answer.text = `- ${answer.actor.name}'s proposal`; });
  rounds[0].answers[0].attempts = [{ id: "activity-attempt", logPath: "/fixture/actor.jsonl", status: "done",
    startedAt: "2026-10-14T00:00:00.000Z", lastActivityAt: "2026-10-14T00:02:00.000Z", finishedAt: "2026-10-14T00:02:00.000Z",
    eventCount: 12, lastEvent: "run.done" }];
  rounds[0].status = "done"; rounds[0].summary = "Host conclusion: stage the migration and compare costs."; rounds[0].revision++;
  await expect(progress).toContainText("Complete");
  await expect(page.locator(".messages-pane > .messages")).toContainText("Host conclusion: stage the migration");
  await progress.locator("summary").first().click();
  await expect(progress).toContainText("proposal");
  await progress.screenshot({ path: "/private/tmp/threadex-roundtable-progress.png" });
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".messages-pane > .messages")).toContainText("Host conclusion: stage the migration");
  const [firstActor, secondActor] = rounds[0].answers.map(answer => answer.actor.name);
  rounds[0].synthesis = { issues: [
    { topic: "[Rollout](https://example.com/rollout)", positions: [{ view: "Stage the migration. See [plan](https://example.com/plan)", actors: [firstActor, secondActor],
      details: [{ actors: [firstActor], detail: "Start with [a pilot](https://example.com/pilot)" }] }] },
    { topic: "Monitoring", positions: [{ view: "Monitor errors", actors: [secondActor, firstActor] }] },
    { topic: "Cost", positions: [{ view: "Cost is secondary", actors: [secondActor] }, { view: "Compare cloud costs first", actors: [firstActor] }] },
    { topic: "Follow-up", positions: [{ view: "Review [the earlier decision](threadex://default/example#1)", actors: [secondActor] }] }] };
  rounds[0].revision++;
  const card = page.getByRole("region", { name: "Round table synthesis" });
  await card.getByRole("button", { name: "Context", exact: true }).click();
  const contextPopup = page.getByRole("dialog", { name: "Round table context", exact: true });
  await expect(contextPopup).toContainText("Host constraints");
  await page.keyboard.press("Escape");
  await expect(contextPopup).toHaveCount(0);
  await card.getByRole("button", { name: "Context", exact: true }).click();
  await contextPopup.getByRole("button", { name: "Close round table context" }).click();
  await expect(contextPopup).toHaveCount(0);
  await expect(card.getByRole("region", { name: "Consensus" })).toContainText("Stage the migration");
  const consensus = card.getByRole("region", { name: "Consensus" });
  await expect(consensus.getByRole("link", { name: "Rollout", exact: true })).toHaveAttribute("href", "https://example.com/rollout");
  await expect(consensus.getByRole("link", { name: "plan", exact: true })).toHaveAttribute("href", "https://example.com/plan");
  await expect(consensus.locator(".roundtable-issue").first().locator(".roundtable-position > .markdown-content")).toHaveCount(0);
  await expect(consensus).toContainText("Monitor errors");
  await expect(consensus.locator(".roundtable-issue").first().locator(".roundtable-detail .roundtable-supporter")).toHaveText([firstActor, secondActor]);
  await expect(consensus.locator(".roundtable-detail").nth(1)).toContainText("Stage the migration");
  await expect(consensus.getByRole("link", { name: "a pilot" })).toHaveAttribute("href", "https://example.com/pilot");
  await expect(consensus.locator(".roundtable-issue").first().locator(".roundtable-supporter")).toHaveText([firstActor, secondActor]);
  await expect(consensus.locator(".roundtable-issue").nth(1).locator(".roundtable-supporter")).toHaveText([firstActor, secondActor]);
  await expect(consensus.locator(".roundtable-issue").nth(1).locator(".roundtable-detail")).toHaveText(`${firstActor}${secondActor}：Monitor errors`);
  const disagreements = card.getByRole("region", { name: "Disagreements" });
  await expect(disagreements.locator(".roundtable-position")).toHaveCount(2);
  await expect(disagreements.locator(".roundtable-supporter")).toHaveText([firstActor, secondActor]);
  const other = card.getByRole("region", { name: "Other points" });
  await expect(other).toContainText(`No position recorded: ${firstActor}`);
  await expect(other.getByRole("link", { name: "the earlier decision" })).toHaveAttribute("href", "?threadId=example&workspaceId=default&turnNumbers=1");
  await expect(page.locator(".messages-pane > .messages")).not.toContainText("Host conclusion: stage the migration");
  await card.screenshot({ path: "/private/tmp/threadex-roundtable-synthesis.png" });
  await card.locator(".roundtable-responses > summary").click();
  await card.locator(".roundtable-answer > summary").first().click();
  await expect(card.locator(".roundtable-answer").first().getByText(`${firstActor}'s proposal`, { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "Activity log · Attempt 1" })).toHaveAttribute("href",
    `/api/roundtable/sessions/${session.id}/turns/${rounds[0].turnId}/attempts/activity-attempt/log`);
  await expect(card.locator(".roundtable-activity")).toContainText("12 events");
  await card.locator(".roundtable-responses > summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Turns", exact: true }).click();
  await page.locator(`.prompt-turn-card[data-turn-id="${rounds[0].turnId}"]`).click();
  await expect(page.locator(`.prompt-turn-card[data-turn-id="${rounds[0].turnId}"] .prompt-turn-roundtable`)).toHaveText("Round table(2)");
  await expect(card).toBeVisible();
  await expect.poll(() => card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await card.screenshot({ path: "/private/tmp/threadex-roundtable-synthesis-mobile.png" });
  await page.evaluate(sessionId => localStorage.removeItem(`threadex.roundtable:default:${sessionId}`), session.id);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByRole("region", { name: "Consensus" })).toContainText("Start with");
  await expect(card.getByRole("region", { name: "Consensus" })).toContainText("Stage the migration");
  await page.getByRole("button", { name: "Round table settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await settings.screenshot({ path: "/private/tmp/threadex-roundtable-mobile.png" });
  await settings.getByRole("button", { name: "Close round table settings" }).click();
  await toggle.click();
  await settings.getByRole("button", { name: "Close round table settings" }).click();
  await expect(surface).toHaveCSS("background-color", "rgb(245, 243, 255)");
  await expect(toggle.locator(".roundtable-toggle-count")).toBeVisible();
  await expect.poll(() => surface.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await surface.screenshot({ path: "/private/tmp/threadex-roundtable-composer-mobile-active.png" });

  // The host classifies the queued prompt independently of the prior decision.
  rounds[1].status = "done";
  rounds[1].answers.forEach(answer => { answer.status = "done"; answer.text = `${answer.actor.name}'s review evidence`; });
  rounds[1].synthesis = { taskType: "code_review", template: "summary", overview: "One retry bug and a test gap need attention.", sections: [
    { title: "Findings", items: [
      { text: "**P1:** Retry can duplicate writes. See [retry code](https://example.com/retry).", actors: [firstActor, secondActor] },
      { text: "No test covers reconnection after a partial write.", actors: [firstActor] }
    ] },
    { title: "Open questions", items: [{ text: "The server's retry guarantee remains unverified.", actors: [secondActor] }] }
  ] };
  rounds[1].summary = "One retry bug and a test gap need attention.\n\n**Findings**\n\n- Retry can duplicate writes.";
  rounds[1].revision++;
  const summaryCard = page.locator('.messages .roundtable-synthesis[data-template="summary"]');
  await expect(summaryCard).toBeVisible();
  await expect(summaryCard.locator(".roundtable-template")).toHaveText("Code review · Summary");
  await expect(summaryCard).toContainText("One retry bug and a test gap");
  await expect(summaryCard.getByRole("region", { name: "Findings", exact: true }).locator(".roundtable-summary-item")).toHaveCount(2);
  await expect(summaryCard.getByRole("link", { name: "retry code", exact: true })).toHaveAttribute("href", "https://example.com/retry");
  await expect(summaryCard.locator('[aria-label="Contributors"]')).toHaveCount(3);
  await expect(summaryCard.getByRole("region", { name: "Open questions", exact: true })).toContainText("unverified");
  await expect(summaryCard).not.toContainText("No position recorded");
  await expect(summaryCard.getByRole("region", { name: "Consensus", exact: true })).toHaveCount(0);
  await expect(summaryCard.getByRole("region", { name: "Disagreements", exact: true })).toHaveCount(0);
  await expect(summaryCard.getByRole("button", { name: "Next round", exact: true })).toBeEnabled();
  await expect.poll(() => summaryCard.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await summaryCard.screenshot({ path: "/private/tmp/threadex-roundtable-summary-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await summaryCard.screenshot({ path: "/private/tmp/threadex-roundtable-summary.png" });
  await summaryCard.locator(".roundtable-responses > summary").click();
  await summaryCard.locator(".roundtable-answer > summary").first().click();
  await expect(summaryCard).toContainText(`${firstActor}'s review evidence`);
  await page.reload();
  await expect(summaryCard.locator(".roundtable-template")).toHaveText("Code review · Summary");
  await expect(page.locator('.messages .roundtable-synthesis[data-template="decision"] .roundtable-template')).toHaveText("Decision");
  expect(await page.locator('.messages [data-copy-markdown]').evaluateAll(elements => elements.map(element => element.getAttribute("data-copy-markdown")))).toContain(rounds[1].summary);
});

test("round table mode works before the first host session exists", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.switchBeta.id);
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`);
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /^New thread(?: in .+)?$/ }).first().click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Round table settings" }).locator(".roundtable-actor-tile")).toHaveCount(2);
  await page.getByRole("button", { name: "Close round table settings" }).click();
  let body: any;
  await page.route("**/api/roundtable/turns", route => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "Deliberate fixture rejection; keep the draft" } });
  });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("A new round table topic");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => body?.sessionId).toMatch(/^tx_/);
  expect(body.turnId).toMatch(/^rt_/);
  expect(body.actors).toHaveLength(2);
  await expect(composer).toHaveText("A new round table topic");
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toHaveAttribute("aria-pressed", "true");
  const firstId = body.turnId;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => body.turnId).toBe(firstId);
  await page.getByRole("button", { name: /^New thread(?: in .+)?$/ }).first().click();
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "Round table mode", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Round table mode", exact: true }).click();
  await page.getByRole("button", { name: "Close round table settings" }).click();
  const adoptedSessionId = scenarioSessions.switchBeta.id;
  await page.route("**/api/roundtable/turns", route => {
    body = route.request().postDataJSON();
    const round: RoundtableRound = { turnId: body.turnId, sessionId: adoptedSessionId, prompt: body.message, revision: 1,
      created: new Date().toISOString(), status: "actors", context: "", summarizerModel: DEFAULT_MODEL,
      hostModel: DEFAULT_MODEL, hostEffort: "high", answers: body.actors.map((actor: any) => ({ actor, text: "", status: "running", error: null })),
      summary: "", error: null, tokenIn: 0, tokenOut: 0 };
    return route.fulfill({ status: 202, json: { sessionId: adoptedSessionId, round } });
  });
  await composer.fill("A successful new round table topic");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`sessionId=${adoptedSessionId}`));
  const toggle = page.getByRole("button", { name: "Round table mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(composer).not.toContainText("A successful new round table topic");
  await toggle.click();
  await expect(page.getByRole("dialog", { name: "Round table settings" }).locator(".roundtable-actor-tile strong")).toHaveText(body.actors.map((actor: any) => actor.name));
});
