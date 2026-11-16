import { expect, test, type Locator, type Page } from "@playwright/test";

const timestamp = "2026-10-23T12:00:00Z";
function request(id: string, workspaceId: string, method = "item/commandExecution/requestApproval") {
  return { approvalId: id, sessionId: `${workspaceId}-session`, workspaceId, sessionTitle: `${workspaceId} session`,
    turnId: `${id}-turn`, requestId: id, method, createdAt: timestamp,
    params: method === "item/tool/requestUserInput" ? { questions: [{ id: "choice", header: "Choice", question: "Which scope?", isOther: true,
      options: [{ label: "UI", description: "Interface" }, { label: "Both", description: "All" }] }] }
      : method === "threadex/intent/requestApproval" ? { title: "Deploy staging", scope: "Staging only", actions: ["Build", "Deploy"], exclusions: "Production", consequences: "Brief downtime" }
      : { command: `echo ${id}`, reason: `Approve ${id}`, availableDecisions: ["accept", "decline", "cancel"] } };
}
async function fixture(page: Page) {
  const workspaces = ["Alpha", "Beta"].map(id => ({ id, name: id, cwd: "/tmp/actions", codexHome: "/tmp/actions", accountIds: [] }));
  let activeWorkspace = workspaces[0];
  let selectedId: string | null = null;
  const sessions = workspaces.map(w => ({ id: `${w.id}-session`, workspaceId: w.id, title: `${w.id} session`, cwd: w.cwd, created: timestamp, updated: timestamp, threadId: `${w.id}-thread` }));
  const state = { items: [] as ReturnType<typeof request>[], decisions: [] as { id: string; decision: unknown }[], failList: false, failDecision: false, staleDecision: false, delayDecision: false };
  const errors: string[] = [];
  page.on("pageerror", err => errors.push(err.message));
  const snapshot = (id: string) => ({ session: sessions.find(s => s.id === id), turns: [], modelPreferences: null });
  await page.route("**/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/api/security/status") return json({ configured: true, authenticated: true });
    if (path === "/api/approvals") return state.failList ? json({ error: "offline" }, 503) : json({ approvals: [...state.items, ...state.items] });
    if (path.endsWith("/decision")) {
      const id = decodeURIComponent(path.split("/").at(-2)!);
      if (state.failDecision) { state.failDecision = false; return json({ error: "Please retry" }, 503); }
      if (state.staleDecision) { state.staleDecision = false; state.items = state.items.filter(item => item.approvalId !== id); return json({ stale: true, error: "No longer pending" }, 409); }
      state.decisions.push({ id, decision: req.postDataJSON().decision });
      if (state.delayDecision) await new Promise(resolve => setTimeout(resolve, 400));
      state.items = state.items.filter(item => item.approvalId !== id);
      return json({ ok: true });
    }
    if (path === "/api/workspaces/switch") { activeWorkspace = workspaces.find(w => w.id === req.postDataJSON().workspaceId)!; return json({ activeWorkspace, workspaces }); }
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace, workspaces, activeSessionId: selectedId, activeSession: selectedId ? snapshot(selectedId) : null,
      sessions: sessions.filter(s => s.workspaceId === activeWorkspace.id), accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [], approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/sessions/switch") { selectedId = req.postDataJSON().sessionId; return json(snapshot(selectedId!)); }
    if (/\/api\/sessions\/[^/]+\/snapshot/.test(path)) return json(snapshot(path.split("/")[3]));
    if (path === "/api/sessions") return json({ sessions: sessions.filter(s => s.workspaceId === activeWorkspace.id), hasMore: false, projects: [] });
    if (path === "/api/events") return json({ events: [], nextPos: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, tasks: [] });
    if (path.endsWith("/room")) return json({ workspaceId: activeWorkspace.id, revision: 0, actors: [], rounds: [], workItems: [] });
    if (path.endsWith("/actors/summary")) return json({ workspaceId: activeWorkspace.id, revision: 0, actors: [] });
    return json({ sideChats: [], accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.goto("/?workspaceId=Alpha");
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const menu = async () => {
    await expect(page.getByRole("tab", { name: "Alpha", exact: true, includeHidden: true })).toBeAttached();
    if (!await page.getByRole("tab", { name: "Alpha", exact: true }).isVisible()) await page.getByRole("button", { name: /^Toggle workspace menu/ }).click();
  };
  await menu();
  await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeVisible();
  return { state, errors, refresh, menu };
}
const card = (dropdown: Locator, approvalId: string) => dropdown.locator(`article[data-approval-id="${approvalId}"]`);
const containsFocus = (target: Locator) => target.evaluate(el => el.contains(document.activeElement));
const hitTestable = (target: Locator) => target.evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); });

for (const width of [1440, 768, 390]) test(`workspace requests stay quiet, open on click and are answered in place at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1100 : 900 });
  const { state, errors, refresh, menu } = await fixture(page);
  const alpha = page.getByRole("button", { name: /^Alpha actions/ });
  const beta = page.getByRole("button", { name: /^Beta actions/ });
  await expect(alpha).toBeHidden(); await expect(beta).toBeHidden();
  state.items = [request("command", "Alpha"), request("question", "Beta", "item/tool/requestUserInput"), request("intent", "Beta", "threadex/intent/requestApproval")];
  await refresh();
  await expect(alpha).toHaveAccessibleName("Alpha actions (1 pending)"); await expect(beta).toHaveAccessibleName("Beta actions (2 pending)");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await alpha.click(); await page.keyboard.press("Escape"); await expect(alpha).toBeFocused();
  await beta.focus(); await page.keyboard.press("Enter");
  const dropdown = page.getByRole("dialog", { name: "Beta actions", exact: true });
  await expect(dropdown).toBeFocused();
  // The enlarged popover fits the viewport and shows each request's own controls without a second dialog.
  const bounds = (await dropdown.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width); expect(bounds.y + bounds.height).toBeLessThanOrEqual(width === 1440 ? 1100 : 900);
  expect(bounds.width).toBeGreaterThanOrEqual(Math.min(600, width - 16));
  expect(await hitTestable(dropdown)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const question = card(dropdown, "question"); const intent = card(dropdown, "intent");
  await expect(dropdown.getByRole("article", { name: "Your input requested" })).toHaveCount(1);
  await expect(question.getByText("Which scope?")).toBeVisible();
  await expect(intent.getByRole("button", { name: "Approve selected scope" })).toBeVisible();
  // Go to session stays available for each request.
  await question.getByRole("button", { name: "Go to session Beta session" }).click();
  await expect(page).toHaveURL(/workspaceId=Beta&sessionId=Beta-session/);
  await expect(page.locator(".content-header h1")).toHaveText("Beta session");
  await expect(dropdown).toHaveCount(0);
  await menu(); await beta.click();
  // Drafts belong to their own card; a failed answer shows its error in place and keeps the popover open.
  await intent.getByRole("textbox", { name: "Additional restrictions" }).fill("After 6pm");
  await question.getByRole("radio", { name: "UI Interface" }).check();
  state.failDecision = true;
  await question.getByRole("button", { name: "Send answers" }).click(); await expect(question.getByRole("alert")).toContainText("retry");
  await expect(intent.getByRole("alert")).toHaveCount(0);
  await expect(dropdown).toBeVisible(); await expect(beta).toHaveAccessibleName("Beta actions (2 pending)");
  await question.getByRole("button", { name: "Send answers" }).click();
  await expect(question).toHaveCount(0);
  await expect(dropdown.getByRole("status")).toContainText("Handled: Which scope?");
  await expect(beta).toHaveAccessibleName("Beta actions (1 pending)");
  await expect(dropdown.locator(".workspace-actions-pending-count")).toHaveText("1 pending");
  expect(await containsFocus(dropdown)).toBe(true);
  expect(state.decisions).toEqual([{ id: "question", decision: { answers: { choice: { answers: ["UI"] } } } }]);
  await expect(intent.getByRole("textbox", { name: "Additional restrictions" })).toHaveValue("After 6pm");
  await intent.getByRole("checkbox", { name: "Build", exact: true }).uncheck();
  await intent.getByRole("button", { name: "Approve selected scope" }).click();
  // The last request closes the popover and returns focus to the workspace tab.
  await expect(dropdown).toHaveCount(0); await expect(beta).toBeHidden();
  expect(state.decisions.at(-1)).toEqual({ id: "intent", decision: { outcome: "approved", actions: ["Deploy"], constraints: "After 6pm" } });
  await alpha.click();
  await card(page.getByRole("dialog", { name: "Alpha actions", exact: true }), "command").getByRole("button", { name: "Decline", exact: true }).click();
  await expect(alpha).toBeHidden();
  await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeFocused();
  expect(state.decisions.at(-1)).toEqual({ id: "command", decision: "decline" });
  expect(errors).toEqual([]);
});

test("empty workspaces hide actions and close an open dropdown when its last request expires", async ({ page }) => {
  const { state, refresh, errors } = await fixture(page);
  const alpha = page.getByRole("button", { name: /^Alpha actions/ });
  const beta = page.getByRole("button", { name: /^Beta actions/ });
  const alphaTab = page.getByRole("tab", { name: "Alpha", exact: true });
  const betaTab = page.getByRole("tab", { name: "Beta", exact: true });
  await expect(alpha).toBeHidden(); await expect(beta).toBeHidden();
  await expect(alphaTab).toBeVisible(); await expect(betaTab).toBeVisible();
  state.items = [request("alpha-only", "Alpha")]; await refresh();
  await expect(alpha).toBeVisible(); await expect(beta).toBeHidden();
  await alpha.click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  await expect(dropdown).toBeFocused();
  state.items.push(request("beta-only", "Beta")); await refresh();
  await expect(beta).toBeVisible(); await expect(dropdown).toBeVisible();
  state.items = state.items.filter(item => item.workspaceId === "Beta"); await refresh();
  await expect(alpha).toBeHidden(); await expect(dropdown).toHaveCount(0);
  await expect(alphaTab).toBeFocused();
  await expect(beta).toHaveAccessibleName("Beta actions (1 pending)");
  await beta.click(); await page.keyboard.press("Escape"); await expect(beta).toBeFocused();
  state.items.push(request("alpha-returned", "Alpha")); await refresh();
  await expect(alpha).toBeVisible(); await expect(dropdown).toHaveCount(0);
  await expect(beta).toBeFocused();
  state.items = []; await refresh();
  await expect(alpha).toBeHidden(); await expect(beta).toBeHidden();
  await expect(alphaTab).toBeVisible(); await expect(betaTab).toBeVisible();
  expect(errors).toEqual([]);
});

test("dismissal, expiry, reconnect, reload, stale decisions, isolated cards and duplicate clicks", async ({ page }) => {
  const { state, errors, refresh, menu } = await fixture(page);
  const trigger = page.getByRole("button", { name: /^Alpha actions/ });
  state.items = [request("first", "Alpha"), request("second", "Alpha")]; await refresh();
  await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)");
  await trigger.click(); const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  await dropdown.getByRole("button", { name: "Close actions" }).click();
  expect(state.decisions).toEqual([]); await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)"); await expect(trigger).toBeFocused();
  await trigger.click(); await expect(card(dropdown, "first")).toBeVisible();
  // Handled elsewhere: the card leaves the open popover and the count follows.
  state.items = [request("second", "Alpha")]; await refresh();
  await expect(card(dropdown, "first")).toHaveCount(0); await expect(trigger).toHaveAccessibleName("Alpha actions (1 pending)");
  await page.keyboard.press("Escape");
  state.failList = true; await refresh(); await trigger.click(); await expect(dropdown.getByRole("status").filter({ hasText: "Retrying" })).toBeVisible();
  state.failList = false; state.items.push(request("third", "Alpha")); await dropdown.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(card(dropdown, "third").getByText("Approve third")).toBeVisible();
  await page.reload(); await menu(); await expect(page.locator("dialog[open]")).toHaveCount(0); await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)");
  await trigger.click();
  // One card's failure and in-flight state stay inside that card.
  state.failDecision = true; await card(dropdown, "second").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card(dropdown, "second").getByRole("alert")).toContainText("retry");
  await expect(card(dropdown, "third").getByRole("alert")).toHaveCount(0);
  await expect(card(dropdown, "third").getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  state.staleDecision = true; await card(dropdown, "second").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card(dropdown, "second")).toHaveCount(0); await expect(trigger).toHaveAccessibleName("Alpha actions (1 pending)");
  state.decisions = [];
  state.delayDecision = true;
  await card(dropdown, "third").getByRole("button", { name: "Approve", exact: true }).dblclick({ force: true });
  await expect(dropdown).toHaveCount(0); await expect(trigger).toBeHidden(); expect(state.decisions).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("long summaries and session names stay inside narrow notification cards", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { state, refresh, errors } = await fixture(page);
  const longToken = "VeryLongUnbrokenRequestIdentifier".repeat(12);
  const item = request("long-content", "Alpha");
  item.sessionTitle = `Session with a long source name ${longToken}`;
  item.params = { command: `echo long-content ${longToken}`, reason: `Please review this request before continuing. ${longToken} More context for the requested operation.`, availableDecisions: ["accept", "decline", "cancel"] };
  state.items = [item]; await refresh();
  await page.getByRole("button", { name: /^Alpha actions/ }).click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  const article = card(dropdown, "long-content");
  await expect(article).toBeVisible();
  await expect(article.getByRole("button", { name: /^Go to session/ })).toBeVisible();
  const geometry = await article.evaluate(el => {
    const panel = el.closest('[role="dialog"]')!;
    const box = (node: Element) => { const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; };
    return { panel: box(panel), card: box(el), text: [...el.querySelectorAll(".workspace-action-source, .approval-card p, .approval-command, .approval-actions")].map(box) };
  });
  expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
  expect(geometry.panel.right).toBeLessThanOrEqual(390);
  expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.panel.left);
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.panel.right);
  expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth + 1);
  expect(geometry.card.scrollWidth).toBeLessThanOrEqual(geometry.card.clientWidth + 1);
  expect(geometry.text).toHaveLength(4);
  for (const text of geometry.text) {
    expect(text.left).toBeGreaterThanOrEqual(geometry.card.left);
    expect(text.right).toBeLessThanOrEqual(geometry.card.right);
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
  }
  expect(errors).toEqual([]);
});

test("short narrow screens keep the popover and every card's controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  const { state, refresh, errors } = await fixture(page);
  state.items = Array.from({ length: 12 }, (_, index) => request(`long-${index}`, "Alpha")); await refresh();
  const trigger = page.getByRole("button", { name: /^Alpha actions/ });
  await trigger.click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  const bounds = (await dropdown.boundingBox())!; expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(320);
  const decline = card(dropdown, "long-11").getByRole("button", { name: "Decline", exact: true }); await decline.scrollIntoViewIfNeeded();
  state.items.push(request("arrived-later", "Alpha")); await refresh();
  await expect(trigger).toHaveAccessibleName("Alpha actions (13 pending)");
  await decline.scrollIntoViewIfNeeded();
  expect(await hitTestable(decline)).toBe(true);
  await decline.click(); await expect(card(dropdown, "long-11")).toHaveCount(0);
  await expect(trigger).toHaveAccessibleName("Alpha actions (12 pending)");
  expect(state.decisions).toEqual([{ id: "long-11", decision: "decline" }]);
  expect(errors).toEqual([]);
});
