import { expect, test } from "./support/authenticated-test";
import { selectSession } from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";
import { grillAwaitingAck, type TurnGrill } from "../src/turnGrill.js";

test("Await ack highlights follow server summaries, actions acknowledge the visible version, and background updates reload", async ({ page, request }) => {
  const session = scenarioSessions.switchAlpha;
  const snapshot = await selectSession(request, session.id);
  const turnId = snapshot.turns.at(-1).id;
  const issue = { id: "q1", md: "Check the public result", responseMd: "Add a fixture", status: "open" as const, selected: true };
  let saved: TurnGrill = { revision: 2, contentVersion: 1, acknowledgedVersion: 0, status: "ready", updated: new Date().toISOString(), error: null,
    issues: [issue], rounds: [{ id: "initial", action: "respond", created: new Date().toISOString(), prompt: "", issues: [issue] }] };
  const actions: any[] = [];
  const summaries = () => [{ sessionId: session.id, turnId, revision: saved.revision, pending: grillAwaitingAck(saved) }];
  await page.route("**/api/events?**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), grillSummaries: summaries() } });
  });
  await page.route("**/api/sessions/*/grills", (route) => route.fulfill({ json: { turnIds: [turnId], summaries: summaries() } }));
  await page.route("**/api/sessions/*/turns/*/grill", async (route) => {
    if (!route.request().url().includes(`/turns/${turnId}/`)) return route.fulfill({ json: { grill: null } });
    if (route.request().method() === "GET") return route.fulfill({ json: { grill: saved } });
    const body = route.request().postDataJSON(); actions.push(body);
    saved = { ...saved, revision: saved.revision + 1, acknowledgedVersion: body.observedVersion };
    if (body.action !== "ack") saved = { ...saved, contentVersion: saved.contentVersion! + 1,
      rounds: [...saved.rounds, { id: String(saved.revision), created: new Date().toISOString(), action: body.action, prompt: body.prompt, issues: saved.issues }] };
    await route.fulfill({ json: { grill: saved } });
  });
  let workOrigin: unknown;
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON(); workOrigin = body.grillOrigin;
    saved = { ...saved, revision: saved.revision + 1, acknowledgedVersion: body.grillOrigin.observedVersion };
    await route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"ok":true}\n\n' });
  });
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  const panel = page.getByRole("region", { name: "Grill review" });
  const row = page.locator(`.session-row[data-session-id="${session.id}"]`);
  const turnTag = page.locator(".prompt-turn-grill-tag").first();
  await expect(panel.getByText("Await ack", { exact: true })).toBeVisible();
  await expect(panel.locator(".grill-header").getByRole("button", { name: "Ack", exact: true })).toHaveCount(0);
  await expect(panel.locator(".grill-compose-actions > div > button").first()).toHaveText("Ack");
  await expect(panel.getByRole("button", { name: "Ack", exact: true }).locator("svg.lucide-eye")).toBeVisible();
  await expect(row).toHaveAttribute("data-grill-await-ack", "true");
  await expect(turnTag).toHaveAttribute("data-await-ack", "true");
  await panel.getByRole("button", { name: "Ack", exact: true }).click();
  expect(actions.map((action) => action.action)).toEqual(["ack"]);
  await expect(panel.getByText("Await ack", { exact: true })).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-grill-await-ack");
  await expect(turnTag).not.toHaveAttribute("data-await-ack");
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Ack", exact: true })).toHaveCount(0);
  for (const name of ["Ask thread", "Re-grill"]) {
    const observed = saved.contentVersion;
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(panel.getByText("Await ack", { exact: true })).toBeVisible();
    expect(actions.at(-1).observedVersion).toBe(observed);
    await expect(row).toHaveAttribute("data-grill-await-ack", "true");
  }
  const observed = saved.contentVersion;
  await panel.getByRole("button", { name: "Start work", exact: true }).click();
  await expect.poll(() => workOrigin).toEqual({ turnId, observedVersion: observed });
  await expect(row).not.toHaveAttribute("data-grill-await-ack");
  await expect(panel.getByText("Await ack", { exact: true })).toHaveCount(0);
  // Simulate a persisted linked work completion while a different session is open.
  await page.goto(`/?workspaceId=default&sessionId=${scenarioSessions.switchBeta.id}`);
  saved = { ...saved, revision: saved.revision + 1, contentVersion: saved.contentVersion! + 1 };
  await expect(row).toHaveAttribute("data-grill-await-ack", "true");
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(panel.getByText("Await ack", { exact: true })).toBeVisible();
  await expect(turnTag).toHaveAttribute("data-await-ack", "true");
  saved = { ...saved, revision: saved.revision + 1, contentVersion: saved.contentVersion! + 1, issues: [] };
  await expect(panel.getByText("No material gaps found", { exact: true })).toBeVisible();
  await expect(panel.getByText("Await ack", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Ack", exact: true })).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-grill-await-ack");
  await expect(turnTag).not.toHaveAttribute("data-await-ack");
  await page.unrouteAll({ behavior: "wait" });
});
