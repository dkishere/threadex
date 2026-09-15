import { expect, test } from "@playwright/test";
import { apiBaseUrl, selectSession } from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";
import type { TurnGrill } from "../src/turnGrill.js";

test("Grill uses one turn composer, gates follow-up on a thread response, and preserves question management", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  await selectSession(request, session.id);
  let saved: TurnGrill | null = null;
  const actions: any[] = [];
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/sessions/*/turns/*/grill", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { grill: saved } });
    const body = route.request().postDataJSON(); actions.push(body);
    if (body.action === "respond") await responseGate;
    const issues = body.action === "start" ? [
      { id: "q1", md: "**Does the empty-input case preserve the existing result?** Add a fixture that exercises the public API.", responseMd: "", status: "open", selected: true },
      { id: "q2", md: "Which permission check protects the update endpoint?", responseMd: "", status: "open", selected: true }
    ] : body.issues.map((issue: any) => ({ ...issue, responseMd: body.action === "save" || !issue.selected ? issue.responseMd : "Add a **focused fixture** for empty input, then verify the existing result is unchanged.", status: "open" }));
    saved = { revision: (saved?.revision ?? 0) + 1, status: "ready", updated: new Date().toISOString(), error: null, issues,
      rounds: [...(saved?.rounds ?? []), { id: String(actions.length), action: body.action, prompt: body.prompt, created: new Date().toISOString(), issues }] };
    return route.fulfill({ json: { grill: saved } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Existing draft");
  const panel = page.getByRole("region", { name: "Grill review" });
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Grill agent", exact: true })).toHaveClass(/message-action-icon/);
  await page.getByRole("button", { name: "Grill agent", exact: true }).click();
  await expect(panel.locator(".grill-issue")).toHaveCount(2);
  await expect(page.locator(".prompt-turn-card").getByLabel("Grill: Await ack", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(1);
  await expect(panel.locator(".grill-issue textarea")).toHaveCount(0);
  await expect(panel.locator(".grill-issue").getByRole("button", { name: /Ask|follow-up/ })).toHaveCount(0);
  await panel.screenshot({ path: "/private/tmp/threadex-grill-questions.png" });
  await expect(composer).toHaveText("Existing draft");
  const first = panel.locator(".grill-issue").nth(0);
  await first.getByRole("button", { name: "Edit question 1", exact: true }).click();
  await first.getByRole("textbox", { name: "Edit question 1", exact: true }).fill("Updated **question**");
  await first.getByRole("textbox", { name: "Edit question 1", exact: true }).blur();
  await panel.getByRole("checkbox", { name: "Question 2", exact: true }).uncheck();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await expect(panel.getByRole("button", { name: /Save changes|Save question/ })).toHaveCount(0);
  await page.reload();
  await expect(first).toContainText("Updated question");
  await expect(panel.getByRole("checkbox", { name: "Question 2", exact: true })).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toHaveCount(0);
  await panel.getByRole("textbox", { name: "Continue this review" }).fill("Check empty input across the whole turn");
  await panel.getByRole("button", { name: "Ask thread", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Ask thread", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toHaveCount(0);
  releaseResponse();
  await expect(panel.locator(".grill-turn-response")).toContainText("Thread response");
  await expect(panel.locator(".grill-answer")).toHaveCount(1);
  await expect(first.locator(".grill-answer")).toContainText("focused fixture");
  await expect(panel.locator(".grill-issue").nth(1).locator(".grill-answer")).toHaveCount(0);
  await first.getByRole("checkbox").uncheck();
  await expect(first.locator(".grill-answer")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toBeEnabled();
  await first.getByRole("checkbox").check();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toBeVisible();
  expect(actions.at(-1).issueId).toBeUndefined();
  expect(actions.find((action) => action.action === "respond").prompt).toBe("Check empty input across the whole turn");
  await panel.screenshot({ path: "/private/tmp/threadex-grill-response.png" });
  await page.setViewportSize({ width: 820, height: 900 });
  await expect.poll(() => panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.screenshot({ path: "/private/tmp/threadex-grill-narrow.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await expect(panel.getByRole("button", { name: "Re-grill", exact: true })).toBeVisible();
  await panel.getByRole("textbox", { name: "Continue this review" }).fill("Check that response for remaining gaps");
  await panel.getByRole("button", { name: "Re-grill", exact: true }).click();
  await expect(first.locator(".grill-turn-response")).toHaveCount(2);
  await expect(first.locator(".grill-turn-response").nth(0)).toContainText("Thread response");
  await expect(first.locator(".grill-turn-response").nth(1)).toContainText("Re-grill");
  await page.reload();
  await expect(first.locator(".grill-turn-response")).toHaveCount(2);
  await expect(first.locator(".grill-turn-response").nth(0)).toContainText("Thread response");
  await panel.getByRole("button", { name: /^History/ }).click();
  const history = page.getByRole("dialog", { name: "Review history" });
  await expect(history).toBeVisible();
  await expect(history).toContainText("Check that response for remaining gaps");
  await expect(panel.locator(".grill-history")).toHaveCount(0);
  await history.screenshot({ path: "/private/tmp/threadex-grill-history.png" });
  await page.keyboard.press("Escape");
  await expect(history).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^History/ })).toBeFocused();
  await panel.getByRole("button", { name: /^History/ }).click();
  await history.getByRole("button", { name: "Close review history" }).click();
  await expect(history).toHaveCount(0);
  expect(actions.at(-1).issueId).toBeUndefined();
  const second = panel.locator(".grill-issue").nth(1);
  await second.getByRole("button", { name: "Drop", exact: true }).click();
  await expect(second).toHaveAttribute("data-dropped", "true");
  await expect(second.locator(".grill-question")).toHaveCSS("text-decoration-line", "line-through");
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await page.reload();
  await expect(second).toHaveAttribute("data-dropped", "true");
  await second.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(second.getByRole("checkbox")).toBeEnabled();
  await expect(second.getByRole("checkbox")).toBeChecked();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await page.reload();
  await expect(second.getByRole("checkbox")).toBeChecked();
  await second.getByRole("button", { name: "Drop", exact: true }).click();
  await panel.getByRole("textbox", { name: "Continue this review" }).fill("Keep compatibility");
  await page.route("**/api/chat", (route) => route.fulfill({ contentType: "text/event-stream", body: 'event: done\\ndata: {"ok":true}\\n\\n' }));
  const chatRequest = page.waitForRequest((req) => req.method() === "POST" && req.url().includes("/api/chat"));
  await panel.getByRole("button", { name: "Start work", exact: true }).click();
  const sent = (await chatRequest).postData() ?? "";
  expect(sent).toContain("Updated");
  expect(sent).toContain("focused fixture");
  expect(sent).toContain("Keep compatibility");
  expect(sent).not.toContain("Which permission check");
});

test("autosave serializes rapid edits and retains changes after a failed save", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  await selectSession(request, session.id);
  let saved: TurnGrill = { revision: 1, status: "ready", updated: new Date().toISOString(), error: null,
    issues: [{ id: "q1", md: "Original question", responseMd: "", status: "open", selected: true }], rounds: [] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  let fail = false;
  await page.route("**/api/sessions/*/turns/*/grill", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { grill: saved } });
    const body = route.request().postDataJSON();
    requests++;
    if (requests === 1) await gate;
    if (fail) return route.fulfill({ status: 500, json: { error: "Save unavailable" } });
    expect(body.revision).toBe(saved.revision);
    saved = { ...saved, revision: saved.revision + 1, issues: body.issues };
    return route.fulfill({ json: { grill: saved } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const panel = page.getByRole("region", { name: "Grill review" });
  const checkbox = panel.getByRole("checkbox", { name: "Question 1", exact: true });
  await checkbox.uncheck();
  await expect.poll(() => requests).toBe(1);
  await checkbox.check();
  release();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  expect(requests).toBe(2);
  await page.reload();
  await expect(checkbox).toBeChecked();
  fail = true;
  await panel.getByRole("button", { name: "Edit question 1", exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Edit question 1", exact: true });
  await editor.fill("Updated question survives failure");
  await editor.blur();
  await expect(panel.getByRole("alert")).toContainText("Save unavailable");
  await expect(panel.locator(".grill-question")).toContainText("Updated question survives failure");
  fail = false;
  await panel.getByRole("button", { name: "Retry autosave" }).click();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await page.reload();
  await expect(panel.locator(".grill-question")).toContainText("Updated question survives failure");
});

test("409 merges independent edits and pauses same-field conflicts until the user chooses", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  await selectSession(request, session.id);
  let saved: TurnGrill = { revision: 1, status: "ready", updated: new Date().toISOString(), error: null,
    issues: [{ id: "q1", md: "Original", responseMd: "Answer", status: "open", selected: true }], rounds: [] };
  let mode = "independent";
  const revisions: number[] = [];
  await page.route("**/api/sessions/*/turns/*/grill", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { grill: saved } });
    const body = route.request().postDataJSON(); revisions.push(body.revision);
    if (mode !== "save") {
      saved = { ...saved, revision: saved.revision + 1, issues: saved.issues.map((issue) => ({ ...issue,
        ...(mode === "independent" ? { selected: false } : { md: "Remote change" }) })) };
      mode = "save";
      return route.fulfill({ status: 409, json: { error: "Changed" } });
    }
    expect(body.revision).toBe(saved.revision);
    saved = { ...saved, revision: saved.revision + 1, issues: body.issues };
    return route.fulfill({ json: { grill: saved } });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const panel = page.getByRole("region", { name: "Grill review" });
  const edit = async (text: string) => {
    await panel.getByRole("button", { name: "Edit question 1", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "Edit question 1", exact: true });
    await editor.fill(text); await editor.blur();
  };
  await edit("Local change");
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  expect(revisions).toEqual([1, 2]);
  expect(saved.issues[0].md).toBe("Local change");
  expect(saved.issues[0].selected).toBe(false);
  mode = "conflict";
  await edit("Second local change");
  await expect(panel.getByRole("button", { name: "Keep local and merge" })).toBeVisible();
  const count = revisions.length;
  await panel.getByRole("checkbox", { name: "Question 1", exact: true }).check();
  expect(revisions.length).toBe(count);
  await panel.getByRole("button", { name: "Keep local and merge" }).click();
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  expect(revisions.at(-1)).toBe(4);
  expect(saved.issues[0].md).toBe("Second local change");
  mode = "conflict";
  await edit("Discard this edit");
  await panel.getByRole("button", { name: "Reload latest and discard local edits" }).click();
  await expect(panel.locator(".grill-question")).toHaveText("Remote change");
  await panel.getByRole("button", { name: "Mark response 1 satisfied" }).click();
  await expect(panel.locator(".grill-resolved")).toHaveText("Satisfied");
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
  await page.reload();
  await expect(panel.locator(".grill-resolved")).toHaveText("Satisfied");
  await edit("Reopened question");
  await expect(panel.locator(".grill-resolved")).toHaveCount(0);
  await expect(panel.locator(".grill-saved")).toHaveText("Saved");
});

test("Grill recovers an empty transport response without submitting twice", async ({ page, request }) => {
  const session = scenarioSessions.switchBeta;
  await selectSession(request, session.id);
  let saved: TurnGrill | null = null;
  let posts = 0;
  await page.route("**/api/sessions/*/turns/*/grill", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { grill: saved } });
    posts++;
    saved = { revision: 1, status: "running", updated: new Date().toISOString(), error: null, issues: [], rounds: [] };
    return route.fulfill({ status: 502, body: "" });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await page.getByRole("button", { name: "Grill agent", exact: true }).click();
  const panel = page.getByRole("region", { name: "Grill review" });
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => posts).toBe(1);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  saved = { revision: 2, status: "ready", updated: new Date().toISOString(), error: null, issues: [], rounds: [] };
  await expect(panel).toContainText("No material gaps found");
  expect(posts).toBe(1);
});

test("Grill failure preserves composer and permits retry", async ({ page, request }) => {
  const session = scenarioSessions.switchBeta;
  await selectSession(request, session.id);
  await page.route("**/api/sessions/*/turns/*/grill", (route) => route.fulfill(
    route.request().method() === "GET" ? { json: { grill: null } } : { status: 500, json: { error: "Griller unavailable" } }
  ));
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my draft");
  const button = page.getByRole("button", { name: "Grill agent", exact: true });
  await button.click();
  await expect(page.getByRole("alert").filter({ hasText: "Griller unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry Grill", exact: true })).toBeEnabled();
  await expect(composer).toHaveText("Keep my draft");
});

test("Grill rejects a turn from another session", async ({ request }) => {
  const response = await request.post(`${apiBaseUrl}/api/sessions/${scenarioSessions.switchAlpha.id}/turns/${scenarioSessions.switchBeta.id}-baseline/grill`);
  expect(response.status()).toBe(404);
});

test("only the latest completed turn offers a new Grill", async ({ page, request }) => {
  const session = scenarioSessions.switchBeta;
  await selectSession(request, session.id);
  await page.route(/\/api\/sessions\/(?:switch|[^/]+\/snapshot)$/, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (data.session?.id === session.id && data.turns?.length) {
      const previous = data.turns.at(-1);
      data.turns.push({ ...previous, id: "grill-latest-fixture", status: "done", userInput: "Latest request", agentResponse: "Latest response" });
    }
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/sessions/*/turns/*/grill", (route) => route.fulfill({ json: { grill: null } }));
  await page.route("**/api/sessions/*/grills", (route) => route.fulfill({ json: { turnIds: [`${session.id}-baseline`] } }));
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.getByRole("button", { name: "Fork from this message", exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Grill agent", exact: true })).toHaveCount(1);
  await expect(page.locator('[data-turn-id="grill-latest-fixture"]').getByRole("button", { name: "Grill agent", exact: true })).toBeVisible();
  await expect(page.locator(`.prompt-turn-card[data-turn-id="${session.id}-baseline"]`).getByLabel("Grilled", { exact: true })).toBeVisible();
  await expect(page.locator('.prompt-turn-card[data-turn-id="grill-latest-fixture"]').getByLabel("Grilled", { exact: true })).toHaveCount(0);
});
