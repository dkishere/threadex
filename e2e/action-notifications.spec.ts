import { expect, test, type Page } from "@playwright/test";

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

for (const width of [1440, 768, 390]) test(`workspace requests stay quiet, open on click and navigate at ${width}px`, async ({ page }) => {
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
  await expect(dropdown.getByRole("button", { name: /Your input requested/ })).toHaveCount(1);
  await expect(dropdown.getByRole("button", { name: /Approval required/ })).toHaveCount(1);
  const bounds = await dropdown.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  expect(await dropdown.evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
  await dropdown.getByRole("button", { name: /Your input requested/ }).click();
  const modal = page.getByRole("dialog", { name: "Your input requested", exact: true });
  await expect(modal.getByText("Which scope?")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Close request" })).toBeFocused();
  await page.keyboard.press("Shift+Tab"); expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 10; i++) { await page.keyboard.press("Tab"); expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true); }
  await modal.getByRole("button", { name: "Go to session" }).click();
  await expect(page).toHaveURL(/workspaceId=Beta&sessionId=Beta-session/);
  await expect(page.locator(".content-header h1")).toHaveText("Beta session");
  await menu(); await beta.click(); await dropdown.getByRole("button", { name: /Your input requested/ }).click();
  await modal.getByRole("radio", { name: "UI Interface" }).check();
  state.failDecision = true;
  await modal.getByRole("button", { name: "Send answers" }).click(); await expect(modal.getByRole("alert")).toContainText("retry");
  await modal.getByRole("button", { name: "Send answers" }).click();
  await expect(modal.getByRole("status")).toContainText("no longer pending");
  expect(state.decisions).toEqual([{ id: "question", decision: { answers: { choice: { answers: ["UI"] } } } }]);
  await page.keyboard.press("Escape"); await expect(beta).toBeFocused();
  await beta.click(); await dropdown.getByRole("button", { name: /Deploy staging/ }).click();
  const intent = page.getByRole("dialog", { name: "Approval required", exact: true });
  await intent.getByRole("checkbox", { name: "Build", exact: true }).uncheck();
  await intent.getByRole("textbox", { name: "Additional restrictions" }).fill("After 6pm");
  await intent.getByRole("button", { name: "Approve selected scope" }).click();
  await expect(intent.getByRole("status")).toBeVisible();
  expect(state.decisions.at(-1)).toEqual({ id: "intent", decision: { outcome: "approved", actions: ["Deploy"], constraints: "After 6pm" } });
  await page.keyboard.press("Escape");
  await alpha.click(); await page.getByRole("dialog", { name: "Alpha actions", exact: true }).getByRole("button", { name: /Approve command/ }).click();
  await page.getByRole("dialog", { name: "Approval required", exact: true }).getByRole("button", { name: "Decline", exact: true }).click();
  await expect(alpha).toBeHidden();
  await page.keyboard.press("Escape");
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

test("dismissal, expiry, reconnect, reload, stale decisions and duplicate clicks", async ({ page }) => {
  const { state, errors, refresh, menu } = await fixture(page);
  const trigger = page.getByRole("button", { name: /^Alpha actions/ });
  state.items = [request("first", "Alpha"), request("second", "Alpha")]; await refresh();
  await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)");
  await trigger.click(); const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  await dropdown.getByRole("button", { name: /Approve first/ }).click();
  const modal = page.getByRole("dialog", { name: "Approval required", exact: true });
  await modal.getByRole("button", { name: "Close request" }).click();
  expect(state.decisions).toEqual([]); await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)");
  await trigger.click(); await dropdown.getByRole("button", { name: /Approve first/ }).click();
  state.items = [request("second", "Alpha")]; await refresh();
  await expect(modal.getByRole("status")).toContainText("no longer pending"); await expect(modal.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  state.failList = true; await refresh(); await trigger.click(); await expect(dropdown.getByRole("status")).toContainText("Retrying");
  state.failList = false; state.items.push(request("third", "Alpha")); await dropdown.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dropdown.getByRole("button", { name: /Approve third/ })).toBeVisible();
  await page.reload(); await menu(); await expect(page.locator("dialog[open]")).toHaveCount(0); await expect(trigger).toHaveAccessibleName("Alpha actions (2 pending)");
  await trigger.click(); await dropdown.getByRole("button", { name: /Approve second/ }).click();
  state.staleDecision = true; await modal.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(modal.getByRole("status")).toBeVisible();
  await page.keyboard.press("Escape"); await trigger.click(); await dropdown.getByRole("button", { name: /Approve third/ }).click();
  state.delayDecision = true;
  await modal.getByRole("button", { name: "Approve", exact: true }).dblclick({ force: true });
  await expect(modal.getByRole("status")).toBeVisible(); expect(state.decisions).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("long summaries and session names stay inside narrow notification cards", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const { state, refresh, errors } = await fixture(page);
  const longToken = "VeryLongUnbrokenRequestIdentifier".repeat(12);
  const item = request("long-content", "Alpha");
  item.sessionTitle = `Session with a long source name ${longToken}`;
  item.params = { command: "echo long-content", reason: `Please review this request before continuing. ${longToken} More context for the requested operation.`, availableDecisions: ["accept", "decline", "cancel"] };
  state.items = [item]; await refresh();
  await page.getByRole("button", { name: /^Alpha actions/ }).click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  const card = dropdown.getByRole("button", { name: /Approval required/ });
  await expect(card).toBeVisible();
  const geometry = await card.evaluate(el => {
    const panel = el.closest('[role="dialog"]')!;
    const cardBounds = el.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    return {
      panel: { left: panelBounds.left, right: panelBounds.right, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth },
      card: { left: cardBounds.left, right: cardBounds.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth },
      text: [...el.querySelectorAll(".workspace-action-summary, .workspace-action-source")].map(node => {
        const bounds = node.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      }),
    };
  });
  expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
  expect(geometry.panel.right).toBeLessThanOrEqual(390);
  expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.panel.left);
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.panel.right);
  expect(geometry.panel.scrollWidth).toBeLessThanOrEqual(geometry.panel.clientWidth + 1);
  expect(geometry.card.scrollWidth).toBeLessThanOrEqual(geometry.card.clientWidth + 1);
  expect(geometry.text).toHaveLength(2);
  for (const text of geometry.text) {
    expect(text.left).toBeGreaterThanOrEqual(geometry.card.left);
    expect(text.right).toBeLessThanOrEqual(geometry.card.right);
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
  }
  await card.click();
  const modal = page.getByRole("dialog", { name: "Approval required", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Go to session" })).toBeVisible();
  await expect(modal.getByText(item.sessionTitle, { exact: false })).toBeVisible();
  const modalGeometry = await modal.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(modalGeometry.scrollWidth).toBeLessThanOrEqual(modalGeometry.clientWidth + 1);
  const reason = modal.locator(".approval-card p").filter({ hasText: "Please review this request before continuing." });
  await expect(reason).toBeVisible();
  const reasonGeometry = await reason.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    const cardBounds = el.closest(".approval-card")!.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, cardLeft: cardBounds.left, cardRight: cardBounds.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(reasonGeometry.left).toBeGreaterThanOrEqual(reasonGeometry.cardLeft);
  expect(reasonGeometry.right).toBeLessThanOrEqual(reasonGeometry.cardRight);
  expect(reasonGeometry.scrollWidth).toBeLessThanOrEqual(reasonGeometry.clientWidth + 1);
  expect(errors).toEqual([]);
});

test("short narrow screens keep the dropdown and modal controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  const { state, refresh, errors } = await fixture(page);
  state.items = Array.from({ length: 12 }, (_, index) => request(`long-${index}`, "Alpha")); await refresh();
  await page.getByRole("button", { name: /^Alpha actions/ }).click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  const bounds = await dropdown.boundingBox(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
  await dropdown.getByRole("button", { name: /Approve long-11/ }).click();
  const modal = page.getByRole("dialog", { name: "Approval required", exact: true });
  const modalBounds = await modal.boundingBox(); expect(modalBounds!.y).toBeGreaterThanOrEqual(0); expect(modalBounds!.y + modalBounds!.height).toBeLessThanOrEqual(320);
  state.items.push(request("arrived-later", "Alpha")); await refresh();
  await expect(modal.getByText("Approve long-11", { exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: "Close request" })).toBeFocused();
  const decline = modal.getByRole("button", { name: "Decline", exact: true }); await decline.scrollIntoViewIfNeeded();
  expect(await decline.evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })).toBe(true);
  await decline.click(); await expect(modal.getByRole("status")).toBeVisible();
  expect(errors).toEqual([]);
});
