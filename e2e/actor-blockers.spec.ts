import { expect, test, type Locator, type Page } from "@playwright/test";
import { actorBlockerActive, actorBlockerPendingDecision, type ActorBlocker } from "../src/actorBlockers";
import { emptyActorRoom, type DomainActor } from "../src/domainActors";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "../src/modelCatalog";

const WS = "Alpha";
const timestamp = "2026-10-26T10:00:00.000Z";
const REAL_SESSION = "tx_2dad5cb3-4332-4365-a0e2-b7492b286103";
const APPROVAL_SESSION = "tx_synthetic-approval";
const CLEAN_SESSION = "tx_clean-session";
const REAL_ID = "blocker_d5ab93292ce378fa";
const APPROVAL_ID = "blocker_synthetic_approval";
const REAL_DESCRIPTION = "manager-session 測試檔案尚未提交，因此未修改；需要確認是否要更新測試以符合現行設計。";
const COMPOSER = "threadex-composer-ui";
const REVIEWER = "threadex-reviewer";

function actor(id: string, name: string): DomainActor {
  return { id, name, workspaceId: WS, rootActorId: id, parentActorId: null, model: DEFAULT_MODEL, effort: "medium", allowedModels: [...MODEL_OPTIONS],
    memory: { version: 0, sourceEventIds: [], rolePrompt: "Maintain this domain", roleSummary: `${name} domain`, longTerm: "Stable knowledge", rolling: "Recent work" }, created: timestamp, updated: timestamp };
}
function blocker(partial: Partial<ActorBlocker> & Pick<ActorBlocker, "id" | "taskSessionId" | "ownerActorId" | "description" | "status">): ActorBlocker {
  return { workspaceId: WS, workItemId: `work-${partial.id}`, roundId: "round-0", executorActorId: partial.ownerActorId, kind: "other", source: "agent",
    dedupeKey: `${partial.taskSessionId}:other:${partial.id}`, selfClearing: false, created: timestamp, updated: timestamp, proposals: [], history: [], ...partial };
}
const realBlocker = () => blocker({ id: REAL_ID, taskSessionId: REAL_SESSION, ownerActorId: COMPOSER, executorActorId: COMPOSER, status: "escalated", description: REAL_DESCRIPTION,
  escalation: { reason: "unresolvable", at: "2026-10-26T10:35:27.758Z" }, updated: "2026-10-26T10:35:27.758Z" });
const approvalBlocker = () => blocker({ id: APPROVAL_ID, taskSessionId: APPROVAL_SESSION, ownerActorId: REVIEWER, executorActorId: REVIEWER, status: "solution_proposed",
  description: "Reviewer needs permission to rewrite the release notes.", updated: "2026-10-26T09:00:00.000Z",
  proposals: [{ id: "proposal-1", actorId: REVIEWER, text: "Rewrite the release notes from the merged pull requests.", requiresApproval: true, created: "2026-10-26T09:00:00.000Z" }] });

type Decision = { path: string; body: { action: string; proposalId: string; note?: string } };

async function fixture(page: Page, options: { blockers?: ActorBlocker[]; url?: string } = {}) {
  const workspaces = ["Alpha", "Beta"].map(id => ({ id, name: id, cwd: "/tmp/blockers", codexHome: "/tmp/blockers", accountIds: [] }));
  const activeWorkspace = workspaces[0];
  const titles: Record<string, string> = { [REAL_SESSION]: "Composer UI cleanup", [APPROVAL_SESSION]: "Release notes", [CLEAN_SESSION]: "Quiet session" };
  const sessions = Object.entries(titles).map(([id, title]) => ({ id, workspaceId: WS, title, cwd: "/tmp/blockers", created: timestamp, updated: timestamp, threadId: `${id}-thread` }));
  const state = { blockers: options.blockers ?? [realBlocker(), approvalBlocker()], decisions: [] as Decision[], selectedId: null as string | null };
  const errors: string[] = [];
  page.on("pageerror", err => errors.push(err.message));
  const room = emptyActorRoom(WS);
  room.actors = [actor(COMPOSER, "Composer UI"), actor(REVIEWER, "Reviewer")];
  const active = () => state.blockers.filter(item => actorBlockerActive(item) && !item.selfClearing);
  const snapshot = (id: string) => ({ session: sessions.find(s => s.id === id), turns: [], modelPreferences: null });
  await page.route("**/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/api/security/status") return json({ configured: true, authenticated: true });
    if (path === "/api/approvals") return json({ approvals: [] });
    if (path === "/api/domain-actors/blockers/pending") {
      return json({ blockers: state.blockers.filter(item => actorBlockerPendingDecision(item)).map(item => ({ ...item,
        ownerActorName: room.actors.find(a => a.id === item.ownerActorId)?.name, taskSessionTitle: titles[item.taskSessionId] })) });
    }
    const action = path.match(/^\/api\/domain-actors\/([^/]+)\/blockers\/([^/]+)\/action$/);
    if (action && req.method() === "POST") {
      const body = req.postDataJSON() as Decision["body"];
      state.decisions.push({ path, body });
      const item = state.blockers.find(entry => entry.id === decodeURIComponent(action[2]));
      const proposal = item?.proposals.find(entry => entry.id === body.proposalId);
      if (!item || !proposal) return json({ error: "No such proposal" }, 404);
      const at = new Date().toISOString();
      if (body.action === "approve") { proposal.approval = { by: "user", at }; item.status = "attempting"; }
      else { proposal.outcome = "rejected"; proposal.decidedAt = at; if (body.note) proposal.outcomeNote = body.note; item.status = "escalated"; item.escalation = { at, reason: "proposal_rejected", ...(body.note ? { note: body.note } : {}) }; }
      item.updated = at; room.revision++;
      return json(item);
    }
    if (path === `/api/domain-actors/${WS}/actors/summary`) {
      return json({ workspaceId: WS, revision: room.revision, blockers: active().map(item => ({ ...item, taskSessionTitle: titles[item.taskSessionId] })),
        actors: room.actors.map(a => ({ id: a.id, name: a.name, rootActorId: a.rootActorId, parentActorId: null, model: a.model, counts: { open: 1, attention: 0 }, running: 0 })) });
    }
    if (path === `/api/domain-actors/${WS}/room`) return json({ ...room, blockers: state.blockers });
    if (path === "/api/workspaces/switch") return json({ activeWorkspace, workspaces });
    if (path === "/api/workspace/snapshot") return json({ activeWorkspace, workspaces, activeSessionId: state.selectedId, activeSession: state.selectedId ? snapshot(state.selectedId) : null,
      sessions, accounts: [], workspaceAccounts: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [], approvals: [], processMonitors: [], statusMonitor: [], waitEvents: [], waitSubscriptions: [], eventCursor: 0 });
    if (path === "/api/sessions/switch") { state.selectedId = req.postDataJSON().sessionId; return json(snapshot(state.selectedId!)); }
    if (/\/api\/sessions\/[^/]+\/snapshot/.test(path)) return json(snapshot(path.split("/")[3]));
    if (path === "/api/sessions") return json({ sessions, hasMore: false, projects: [] });
    if (path === "/api/events") return json({ events: [], nextPos: 0, statusMonitor: [], processMonitors: [], waitEvents: [], waitSubscriptions: [] });
    if (path === "/api/workspace-manager/conversation") return json({ manager: null, approvals: [] });
    if (path === "/api/workspace-manager") return json({ manager: null, tasks: [] });
    return json({ sideChats: [], accounts: [], presets: [], skills: [], projects: [], suggestions: [], groups: [], rounds: [], entries: [], sessionExecutionStatuses: {}, pendingApprovalSessionIds: [] });
  });
  await page.goto(options.url ?? `/?workspaceId=${WS}`);
  const menu = async () => {
    await expect(page.getByRole("tab", { name: WS, exact: true, includeHidden: true })).toBeAttached();
    if (!await page.getByRole("tab", { name: WS, exact: true }).isVisible()) await page.getByRole("button", { name: /^Toggle workspace menu/ }).click();
  };
  const chip = page.getByRole("button", { name: /^Task blockers:/ });
  const bell = page.getByRole("button", { name: /^Alpha actions/ });
  return { state, errors, menu, chip, bell, titles, room };
}

/** Presses Tab until the focused element matches, so the keyboard path is proven rather than assumed. */
async function tabTo(page: Page, matches: (el: Element) => boolean, limit = 12) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(`(${matches.toString()})(document.activeElement)`)) return;
  }
  throw new Error("Focus never reached the expected control");
}
async function inViewport(page: Page, target: Locator, width: number) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 0.5);
}

for (const width of [1440, 390]) test(`task: header chip lists the session's escalated blocker at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  const { chip, errors } = await fixture(page, { url: `/?workspaceId=${WS}&sessionId=${REAL_SESSION}` });
  await expect(page.locator(".content-header h1")).toHaveText("Composer UI cleanup");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Escalated"); await expect(chip.locator(".task-blockers-count")).toHaveText("1");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  const panel = page.getByRole("region", { name: "Task blockers", exact: true });
  await expect(panel).toHaveCount(0);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  const card = panel.locator(`article.actor-blocker-card[data-blocker-id="${REAL_ID}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".actor-blocker-description")).toHaveText(REAL_DESCRIPTION);
  await expect(card.locator(".actor-blocker-status")).toHaveText("Escalated");
  await expect(card.locator(".actor-blocker-meta").getByText("Owner", { exact: true })).toBeVisible();
  await expect(card.locator(".actor-blocker-meta div").filter({ has: page.locator("dt", { hasText: /^Owner$/ }) }).locator("dd")).toHaveText("Composer UI");
  await expect(card.locator(".actor-blocker-meta div").filter({ has: page.locator("dt", { hasText: /^Escalated$/ }) }).locator("dd")).toHaveText("Because its owner declared it unresolvable");
  await expect(card.getByText("No solution proposed yet.")).toBeVisible();
  await expect(card.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0);
  // The other session's blocker never leaks into this task.
  await expect(panel.locator("article.actor-blocker-card")).toHaveCount(1);
  if (width === 390) await inViewport(page, panel, width);
  // Escape closes the panel without leaving the chip and puts focus back on it.
  await chip.evaluate(el => (el as HTMLElement).blur());
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(chip).toBeFocused(); await expect(chip).toHaveAttribute("aria-expanded", "false");
  // Keyboard reopen.
  await page.keyboard.press("Enter"); await expect(panel).toBeVisible();
  expect(errors).toEqual([]);
});

test("task: a session without blockers shows no chip, and a pending proposal is decidable from its chip", async ({ page }) => {
  const clean = await fixture(page, { url: `/?workspaceId=${WS}&sessionId=${CLEAN_SESSION}` });
  await expect(page.locator(".content-header h1")).toHaveText("Quiet session");
  await expect(clean.chip).toHaveCount(0);
  await page.goto(`/?workspaceId=${WS}&sessionId=${APPROVAL_SESSION}`);
  await expect(page.locator(".content-header h1")).toHaveText("Release notes");
  await expect(clean.chip).toContainText("Blocked"); await expect(clean.chip).not.toContainText("Escalated");
  await expect(clean.chip).toHaveAccessibleName("Task blockers: 1 active blocker, 1 awaiting your decision, 1 new");
  await clean.chip.click();
  const panel = page.getByRole("region", { name: "Task blockers", exact: true });
  await expect(panel.getByText("Awaiting your approval")).toBeVisible();
  await panel.getByRole("button", { name: "Approve this proposal" }).click();
  expect(clean.state.decisions.map(d => d.body)).toEqual([{ action: "approve", proposalId: "proposal-1" }]);
  expect(clean.errors).toEqual([]);
});

test("actor: sidebar row badge and actor view blockers section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { errors } = await fixture(page);
  const row = (id: string) => page.locator(`nav#sidebar-panel-actors button.actor-list-row[data-actor-id="${id}"]`);
  const blockerBadge = (id: string) => page.locator(`nav#sidebar-panel-actors button.actor-list-badge[data-kind="blocker"][data-actor-id="${id}"]`);
  const badge = blockerBadge(COMPOSER);
  await expect(badge).toHaveText("Blocked 1");
  await expect(badge).toHaveAttribute("data-escalated", "true");
  await expect(badge).toHaveAttribute("title", new RegExp(REAL_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The reviewer's blocker is not escalated.
  const reviewerBadge = blockerBadge(REVIEWER);
  await expect(reviewerBadge).toHaveText("Blocked 1");
  await expect(reviewerBadge).not.toHaveAttribute("data-escalated", /.*/);
  // Selecting the actor keeps the Sessions tab; the Blockers tab shows the unseen count.
  await row(COMPOSER).click();
  const blockersTab = page.getByRole("tab", { name: /^Blockers/ });
  await expect(page.locator("#session-tab-actor-sessions")).toHaveAttribute("aria-selected", "true");
  await expect(blockersTab.locator(".actor-blockers-tab-count")).toHaveText("1");
  await expect(page.locator(".actor-room-messages .actor-blocker-card")).toHaveCount(0);
  await blockersTab.click();
  const list = page.getByRole("tabpanel", { name: /^Blockers/ });
  await expect(list.locator("tbody tr[data-blocker-id]")).toHaveCount(1);
  await expect(list.locator(".project-blockers-description > span")).toHaveText(REAL_DESCRIPTION);
  // Viewing acknowledges: the tab count and the sidebar row badge disappear.
  await expect(blockersTab.locator(".actor-blockers-tab-count")).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(reviewerBadge).toHaveText("Blocked 1");
  await list.getByRole("button", { name: "Go to session" }).click();
  await expect(page).toHaveURL(new RegExp(`sessionId=${REAL_SESSION}`));
  await expect(page.locator(".content-header h1")).toHaveText("Composer UI cleanup");
  // The task chip stays as an entry point but no longer carries a count.
  const taskChip = page.getByRole("button", { name: /^Task blockers:/ });
  await expect(taskChip).toContainText("Escalated");
  await expect(taskChip.locator(".task-blockers-count")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("actor: the sidebar badge opens the actor view's Blockers tab, and acknowledgement survives a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { errors } = await fixture(page);
  const badge = page.locator(`nav#sidebar-panel-actors button.actor-list-badge[data-kind="blocker"][data-actor-id="${COMPOSER}"]`);
  await badge.click();
  const blockersTab = page.getByRole("tab", { name: /^Blockers/ });
  await expect(blockersTab).toHaveAttribute("aria-selected", "true");
  const list = page.getByRole("tabpanel", { name: /^Blockers/ });
  await inViewport(page, list.locator(`tr[data-blocker-id="${REAL_ID}"]`), 1440);  await expect(badge).toHaveCount(0);
  // Keyboard: arrows move between the two tabs.
  await blockersTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#session-tab-actor-sessions")).toBeFocused();
  await expect(page.locator("#session-tab-actor-sessions")).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.locator(`nav#sidebar-panel-actors button.actor-list-row[data-actor-id="${COMPOSER}"]`)).toBeVisible();
  await expect(badge).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`project: toolbar button opens a workspace blockers table dialog at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  const escalatedApproval = { ...approvalBlocker(), status: "escalated" as const, escalation: { reason: "no_proposal_timeout" as const, at: timestamp } };
  const { state, errors } = await fixture(page, { blockers: [realBlocker(), escalatedApproval] });
  if (width < 700) await page.getByRole("button", { name: "Toggle middle panel" }).click();
  const trigger = page.getByRole("button", { name: /^Workspace blockers:/ });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger.locator(".pending-waits-badge")).toHaveText("2");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Workspace blockers" });
  await inViewport(page, dialog, width);
  await expect(dialog.locator("tbody tr[data-blocker-id]")).toHaveCount(2);
  const row = dialog.locator(`tr[data-blocker-id="${APPROVAL_ID}"]`);
  await expect(row).toContainText("Awaiting your decision");
  await expect(row).toContainText("Reviewer");
  await row.getByRole("button", { name: "Review" }).click();
  await dialog.getByRole("button", { name: "Approve this proposal" }).click();
  await expect.poll(() => state.decisions.map(d => d.body)).toEqual([{ action: "approve", proposalId: "proposal-1" }]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Viewed: the entry stays (blockers are still active) but the count badge is acknowledged away.
  await expect(trigger.locator(".pending-waits-badge")).toHaveCount(0);
  await trigger.click();
  await dialog.locator(`tr[data-blocker-id="${REAL_ID}"]`).getByRole("button", { name: "Go to session" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`sessionId=${REAL_SESSION}`));
  expect(errors).toEqual([]);
});

test("project: the toolbar button is hidden when no active blocker is escalated", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { errors } = await fixture(page, { blockers: [approvalBlocker()] });
  await expect(page.getByRole("tab", { name: /Sessions/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Workspace blockers:/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("project: group chat shows escalated workspace blockers only when there are some", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { errors } = await fixture(page);
  await page.locator("nav#sidebar-panel-actors .actor-list-room").click();
  const section = page.locator('section[aria-label="Escalated workspace blockers"]');
  await expect(section).toBeVisible();
  await expect(section.locator("article.actor-blocker-card")).toHaveCount(1);
  await expect(section.locator(`article[data-blocker-id="${REAL_ID}"]`)).toBeVisible();
  await expect(section.getByRole("button", { name: "Go to session" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("project: group chat hides the section when no active blocker is escalated", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Only a non-escalated blocker and a resolved escalated one remain.
  const resolved = { ...realBlocker(), status: "resolved" as const, closedAt: timestamp };
  const { errors } = await fixture(page, { blockers: [approvalBlocker(), resolved] });
  await page.locator("nav#sidebar-panel-actors .actor-list-room").click();
  await expect(page.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page.locator('section[aria-label="Escalated workspace blockers"]')).toHaveCount(0);
  await expect(page.locator("article.actor-blocker-card")).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`notifications: bell counts blockers, stays closed, approves and navigates at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  const { state, errors, menu, bell } = await fixture(page);
  await menu();
  await expect(bell).toHaveAccessibleName("Alpha actions (1 pending)");
  // Nothing opens by itself, even after the poll has had time to run again.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(400);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await bell.click();
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  const item = dropdown.locator('button[data-kind="blocker"]');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("Blocker solution needs approval");
  await expect(item).toContainText(approvalBlocker().description);
  await expect(item).toContainText("Release notes");
  if (width === 390) await inViewport(page, dropdown, width);
  await item.click();
  const modal = page.getByRole("dialog", { name: "Blocker solution needs approval", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.locator(`article[data-blocker-id="${APPROVAL_ID}"]`)).toBeVisible();
  await expect(modal.getByText("Rewrite the release notes from the merged pull requests.")).toBeVisible();
  await expect(modal.locator("dd").filter({ hasText: "Reviewer" })).toBeVisible();
  if (width === 390) await inViewport(page, modal, width);
  // Go to session navigates and closes the dialog without deciding.
  await modal.getByRole("button", { name: "Go to session", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`workspaceId=${WS}&sessionId=${APPROVAL_SESSION}`));
  await expect(page.locator(".content-header h1")).toHaveText("Release notes");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(state.decisions).toEqual([]);
  await menu(); await expect(bell).toHaveAccessibleName("Alpha actions (1 pending)");
  await bell.click(); await item.click();
  await modal.getByRole("button", { name: "Approve this proposal" }).click();
  await expect(modal.getByRole("status")).toContainText("recorded or is no longer pending");
  await expect(modal.locator("article.actor-blocker-card")).toHaveCount(0);
  expect(state.decisions).toEqual([{ path: `/api/domain-actors/${WS}/blockers/${APPROVAL_ID}/action`, body: { action: "approve", proposalId: "proposal-1" } }]);
  await expect(bell).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("notifications: rejecting with a reason sends the note and drops the item", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { state, errors, bell, menu } = await fixture(page);
  await menu();
  await expect(bell).toHaveAccessibleName("Alpha actions (1 pending)");
  await bell.click();
  await page.getByRole("dialog", { name: "Alpha actions", exact: true }).locator('button[data-kind="blocker"]').click();
  const modal = page.getByRole("dialog", { name: "Blocker solution needs approval", exact: true });
  await modal.getByRole("button", { name: "Reject this proposal" }).click();
  const reason = modal.getByRole("textbox", { name: "Reason for rejecting (optional)" });
  await expect(reason).toBeFocused();
  await reason.fill("  Too broad for this release.  ");
  await modal.getByRole("button", { name: "Confirm rejecting this proposal" }).click();
  await expect(modal.getByRole("status")).toContainText("recorded or is no longer pending");
  expect(state.decisions.map(d => d.body)).toEqual([{ action: "reject", proposalId: "proposal-1", note: "Too broad for this release." }]);
  const stored = state.blockers.find(item => item.id === APPROVAL_ID)!;
  expect(stored.proposals[0].outcome).toBe("rejected"); expect(stored.status).toBe("escalated");
  await expect(bell).toBeHidden();
  expect(errors).toEqual([]);
});

test("notifications: reject without a reason omits the note, and Cancel returns to the choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { state, errors, bell, menu } = await fixture(page);
  await menu();
  await bell.click();
  await page.getByRole("dialog", { name: "Alpha actions", exact: true }).locator('button[data-kind="blocker"]').click();
  const modal = page.getByRole("dialog", { name: "Blocker solution needs approval", exact: true });
  await modal.getByRole("button", { name: "Reject this proposal" }).click();
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal.getByRole("button", { name: "Approve this proposal" })).toBeVisible();
  await expect(modal.getByRole("textbox")).toHaveCount(0);
  await modal.getByRole("button", { name: "Reject this proposal" }).click();
  await modal.getByRole("button", { name: "Confirm rejecting this proposal" }).click();
  await expect(modal.getByRole("status")).toBeVisible();
  expect(state.decisions.map(d => d.body)).toEqual([{ action: "reject", proposalId: "proposal-1" }]);
  expect(errors).toEqual([]);
});

test("notifications: keyboard-only approve", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { state, errors, bell, menu } = await fixture(page);
  await menu();
  await expect(bell).toHaveAccessibleName("Alpha actions (1 pending)");
  await bell.focus(); await page.keyboard.press("Enter");
  const dropdown = page.getByRole("dialog", { name: "Alpha actions", exact: true });
  await expect(dropdown).toBeFocused();
  await tabTo(page, el => (el as HTMLElement).dataset.kind === "blocker");
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Blocker solution needs approval", exact: true });
  await expect(modal).toBeVisible();
  await tabTo(page, el => el.getAttribute("aria-label") === "Approve this proposal");
  expect(await modal.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(modal.getByRole("status")).toContainText("recorded or is no longer pending");
  expect(state.decisions.map(d => d.body)).toEqual([{ action: "approve", proposalId: "proposal-1" }]);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(bell).toBeHidden();
  expect(errors).toEqual([]);
});
