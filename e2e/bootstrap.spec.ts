import { expect, test } from "@playwright/test";
import { apiBaseUrl, selectSession } from "./support/mock-runner.js";
import { scenarioSessions } from "./support/scenarios.js";

test("bootstraps from a 20-session workspace snapshot and paginates explicitly", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.bootstrap.id);

  const sessionRequests: string[] = [];
  let workspaceSnapshot: Record<string, any> | null = null;
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.pathname === "/api/sessions") sessionRequests.push(url.search);
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/workspace/snapshot" && response.ok()) {
      workspaceSnapshot = await response.json();
    }
  });

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.bootstrap.title);
  await expect(page.getByText(`Snapshot response for ${scenarioSessions.bootstrap.title}`, { exact: true })).toBeVisible();
  await expect(page.locator(".session-row")).toHaveCount(20);

  expect(workspaceSnapshot).not.toBeNull();
  expect(workspaceSnapshot?.sessions).toHaveLength(20);
  expect(workspaceSnapshot?.sessionPage).toMatchObject({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
  expect(workspaceSnapshot?.activeSession?.session?.id).toBe(scenarioSessions.bootstrap.id);
  expect(sessionRequests).toEqual([]);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".session-row")).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(sessionRequests).toEqual(["?offset=20"]);
});

test("keeps workspace and session in the URL and restores them with browser history", async ({ page, request }) => {
  const alpha = scenarioSessions.switchAlpha;
  const beta = scenarioSessions.switchBeta;
  await selectSession(request, beta.id);

  await page.goto(`/?workspaceId=default&sessionId=${alpha.id}`);
  await expect(page.locator(".content-header h1")).toHaveText(alpha.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${alpha.id}`);

  await page.locator(".session-row", { hasText: beta.title }).dispatchEvent("click");
  await expect(page.locator(".content-header h1")).toHaveText(beta.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${beta.id}`);

  await page.goBack();
  await expect(page.locator(".content-header h1")).toHaveText(alpha.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${alpha.id}`);

  await page.goForward();
  await expect(page.locator(".content-header h1")).toHaveText(beta.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${beta.id}`);
});

test("restores the backend active session from a stale sessionless URL", async ({ page, request }) => {
  const active = scenarioSessions.switchAlpha;
  await selectSession(request, active.id);

  await page.goto("/?workspaceId=default");

  await expect(page.locator(".content-header h1")).toHaveText(active.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${active.id}`);
});

test("restores an unfinished new-thread composer after switching away and back", async ({ page, request }) => {
  const alpha = scenarioSessions.switchAlpha;
  const beta = scenarioSessions.switchBeta;
  const draft = "Keep this unfinished new task";
  await selectSession(request, alpha.id);

  await page.goto(`/?workspaceId=default&sessionId=${alpha.id}`);
  await expect(page.locator(".content-header h1")).toHaveText(alpha.title);

  await page.locator(".content-header-actions").getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");
  await page.getByRole("textbox", { name: "Message" }).fill(draft);

  await page.locator(".session-row", { hasText: beta.title }).dispatchEvent("click");
  await expect(page.locator(".content-header h1")).toHaveText(beta.title);

  await page.locator(".content-header-actions").getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText(draft);
});

test("reconciles the address-bar session before sending during popstate restore", async ({ page, request }) => {
  const target = scenarioSessions.switchAlpha;
  await selectSession(request, target.id);

  let chatSessionId = "";
  let releaseSnapshot: (() => void) | null = null;
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { sessionId: string; turnId: string };
    chatSessionId = body.sessionId;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        `event: session\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          message: "Mock resumed turn started"
        })}`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          elapsedMs: 10,
          reply: "Resumed existing task"
        })}`,
        "event: done\ndata: {\"ok\":true}"
      ].join("\n\n") + "\n\n"
    });
  });

  await page.goto(`/?workspaceId=default&sessionId=${target.id}`);
  await expect(page.locator(".content-header h1")).toHaveText(target.title);
  await page.locator(".content-header-actions").getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");

  let markSnapshotBlocked: (() => void) | null = null;
  const snapshotBlocked = new Promise<void>((resolveBlocked) => {
    markSnapshotBlocked = resolveBlocked;
  });
  await page.route(`**/api/sessions/${target.id}/snapshot`, async (route) => {
    markSnapshotBlocked?.();
    await new Promise<void>((resolveRelease) => {
      releaseSnapshot = resolveRelease;
    });
    await route.continue();
  });

  await page.evaluate(({ workspaceId, sessionId }) => {
    window.history.pushState(null, "", `/?workspaceId=${workspaceId}&sessionId=${sessionId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, { workspaceId: "default", sessionId: target.id });
  await snapshotBlocked;

  await page.getByRole("textbox", { name: "Message" }).fill("Continue the task selected in the URL");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => chatSessionId).toBe(target.id);
  await expect(page.locator(".content-header h1")).toHaveText(target.title);
  releaseSnapshot?.();
});

test("replaces the blank history entry and follows a server-remapped session id", async ({ page, request }) => {
  const previous = scenarioSessions.switchAlpha;
  const remappedSessionId = "local_server-remapped-session";
  await selectSession(request, previous.id);

  let startedSessionId = "";
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { sessionId: string; turnId: string };
    startedSessionId = body.sessionId;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        `event: session\ndata: ${JSON.stringify({
          sessionId: remappedSessionId,
          turnId: body.turnId,
          message: "Mock new thread started"
        })}`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: remappedSessionId,
          turnId: body.turnId,
          elapsedMs: 10,
          reply: "New thread reply"
        })}`,
        "event: done\ndata: {\"ok\":true}"
      ].join("\n\n") + "\n\n"
    });
  });

  await page.goto(`/?workspaceId=default&sessionId=${previous.id}`);
  await expect(page.locator(".content-header h1")).toHaveText(previous.title);
  await page.locator(".content-header-actions").getByRole("button", { name: "New thread" }).click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");
  await expect.poll(() => new URL(page.url()).search).toBe("?workspaceId=default");

  await page.getByRole("textbox", { name: "Message" }).fill("Start a fresh thread");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => startedSessionId).not.toBe("");
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${remappedSessionId}`);

  await page.goBack();
  await expect(page.locator(".content-header h1")).toHaveText(previous.title);
  await expect.poll(() => new URL(page.url()).search).toBe(`?workspaceId=default&sessionId=${previous.id}`);
});

test("keeps outcome tracking with its session without leaking into new threads", async ({ page, request }) => {
  const previous = scenarioSessions.switchAlpha;
  await selectSession(request, previous.id);

  const forcePlanPayloads: boolean[] = [];
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { sessionId: string; turnId: string; forcePlan?: boolean };
    forcePlanPayloads.push(body.forcePlan === true);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        `event: session\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          message: "Mock Todo plan turn started"
        })}`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          elapsedMs: 10,
          reply: "Todo plan turn complete"
        })}`,
        "event: done\ndata: {\"ok\":true}"
      ].join("\n\n") + "\n\n"
    });
  });

  await page.goto(`/?workspaceId=default&sessionId=${previous.id}`);
  await expect(page.locator(".session-row:disabled")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(previous.id);
  // Let the dev-only StrictMode bootstrap replay settle before exercising
  // per-session composer persistence.
  await page.waitForTimeout(500);
  const planMode = page.getByRole("button", { name: "Track outcomes" });
  await planMode.click();
  await expect(planMode).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("textbox", { name: "Message" }).fill("Plan the first request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => forcePlanPayloads).toEqual([true]);
  await expect(planMode).toHaveAttribute("aria-pressed", "true");

  await page.reload();
  await expect(page.locator(".session-row:disabled")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(previous.id);
  await expect(planMode).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: /^New thread/ }).first().click();
  await expect(page.locator(".content-header h1")).toHaveText("New thread");
  await expect(planMode).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("textbox", { name: "Message" }).fill("Start a normal new-thread request");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => forcePlanPayloads).toEqual([true, false]);
  await expect(planMode).toHaveAttribute("aria-pressed", "false");

  await page.goBack();
  await expect(page.locator(".session-row:disabled")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("sessionId")).toBe(previous.id);
  await expect(planMode).toHaveAttribute("aria-pressed", "true");
});

test("keeps the composer visible while the transcript scrolls", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.composerScroll.id);
  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.composerScroll.title);

  const messages = page.locator(".messages");
  const composer = page.locator(".composer");
  await expect.poll(() => messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const before = await composer.boundingBox();
  expect(before).not.toBeNull();

  await messages.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
  });
  await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const after = await composer.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("shows workspace profile analytics with account filters and model token lines", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.bootstrap.id);
  await page.route("**/api/profile-analytics?*", async (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get("workspaceId") || "e2e-workspace";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspace: {
          id: workspaceId,
          name: "E2E Workspace",
          cwd: "/tmp/e2e-workspace",
          codexHome: "/tmp/e2e-home",
          created: "2026-07-01T00:00:00Z",
          updated: "2026-07-15T00:00:00Z"
        },
        accountId: null,
        accounts: [{ id: "account-one", name: "Primary", email: "primary@example.com", externalAccountId: null }],
        summary: {
          lifetime_tokens: 1_250_000,
          total_tasks: 42,
          total_sessions: 8,
          active_days: 6,
          peak_tokens: 350_000,
          longest_task_seconds: 732,
          models_used: 2
        },
        activity: [{ date: "2026-07-15", tokens: 120_000, tasks: 3 }],
        trend: [
          { date: "2026-07-14", model: "gpt-alpha", tokens: 80_000, input_tokens: 68_000, cached_input_tokens: 40_000, output_tokens: 12_000 },
          { date: "2026-07-14", model: "gpt-beta", tokens: 20_000, input_tokens: 17_000, cached_input_tokens: 9_000, output_tokens: 3_000 },
          { date: "2026-07-15", model: "gpt-alpha", tokens: 60_000, input_tokens: 51_000, cached_input_tokens: 30_000, output_tokens: 9_000 },
          { date: "2026-07-15", model: "gpt-beta", tokens: 90_000, input_tokens: 76_000, cached_input_tokens: 45_000, output_tokens: 14_000 }
        ],
        reasoning: [{ effort: "high", uses: 10 }],
        skills: [{ name: "browser", uses: 4 }]
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tab", { name: "Profile" })).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("heading", { name: "E2E Workspace" })).toBeVisible();
  await expect(page.getByText("1.3M", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("tab", { name: "Primary", exact: true })).toBeVisible();
  await expect(page.locator(".profile-activity-grid span")).toHaveCount(365);
  await expect(page.getByRole("heading", { name: "10-day model usage" })).toBeVisible();
  await expect(page.getByText("Limit used", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Uncached input", { exact: true })).toBeVisible();
  await expect(page.getByText("Cached", { exact: true })).toBeVisible();
  await expect(page.getByText("Output", { exact: true })).toBeVisible();
  await expect(page.locator(".profile-chart-wrap polyline")).toHaveCount(6);
  await expect(page.locator(".profile-chart-wrap polyline").first()).toHaveAttribute("stroke-width", "1.6");
  const alphaModelToggle = page.getByRole("checkbox", { name: "gpt-alpha" });
  const betaModelToggle = page.getByRole("checkbox", { name: "gpt-beta" });
  await expect(alphaModelToggle).toBeChecked();
  await expect(betaModelToggle).toBeChecked();
  expect(await alphaModelToggle.evaluate((element) => getComputedStyle(element).accentColor))
    .not.toBe(await betaModelToggle.evaluate((element) => getComputedStyle(element).accentColor));
  await alphaModelToggle.uncheck();
  await expect(page.locator(".profile-chart-wrap polyline")).toHaveCount(3);
  await alphaModelToggle.check();
  await expect(page.locator(".profile-chart-wrap polyline")).toHaveCount(6);
  await expect(page.getByText("browser", { exact: true })).toBeVisible();
});

test("profile analytics records token categories and excludes deleted accounts", async ({ request }) => {
  const response = await request.get(`${apiBaseUrl}/api/profile-analytics?workspaceId=e2e-profile-analytics`);
  const responseBody = await response.text();
  expect(response.ok(), responseBody).toBe(true);

  const analytics = JSON.parse(responseBody);
  expect(analytics).not.toHaveProperty("quotaTrend");
  expect(Number(analytics.summary.lifetime_tokens)).toBe(30);
  expect(Number(analytics.summary.total_tasks)).toBe(1);
  expect(Number(analytics.summary.total_sessions)).toBe(1);
  expect(analytics.accounts.map((account: { id: string }) => account.id)).not.toContain("e2e-profile-deleted-account");
  const recordedTrend = analytics.trend.find((item: { model: string; tokens: string | number }) => (
    item.model === "gpt-profile" && Number(item.tokens) > 0
  ));
  expect(recordedTrend).toBeDefined();
  expect(Number(recordedTrend.tokens)).toBe(30);
  expect(Number(recordedTrend.input_tokens)).toBe(10);
  expect(Number(recordedTrend.cached_input_tokens)).toBe(4);
  expect(Number(recordedTrend.output_tokens)).toBe(20);
});

test("keeps every compact gear selector active and submits supported model slugs", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.bootstrap.id);

  let submittedSettings: { model?: string; modelReasoningEffort?: string } | null = null;
  await page.route("**/api/chat", async (route) => {
    submittedSettings = route.request().postDataJSON() as typeof submittedSettings;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: "event: done\ndata: {\"ok\":true}\n\n"
    });
  });

  await page.goto("/");
  const gearTabs = page.locator(".composer-gear-tab");
  const gearAnchors = page.locator(".composer-gear-anchor");
  const gearSelects = page.locator(".composer-gear-tab select");
  await expect(gearTabs).toHaveCount(3);
  await expect(gearAnchors).toHaveCount(3);
  await expect(gearSelects).toHaveCount(6);

  const defaultLayout = await page.locator(".composer-layout").evaluate((layout) => {
    const gears = layout.querySelector<HTMLElement>(".composer-gears")?.getBoundingClientRect();
    const shell = layout.querySelector<HTMLElement>(".composer-shell")?.getBoundingClientRect();
    return {
      columnGap: getComputedStyle(layout).columnGap,
      heightDifference: Math.abs((gears?.height ?? 0) - (shell?.height ?? 0)),
      rowHeights: Array.from(layout.querySelectorAll<HTMLElement>(".composer-gear-tab"))
        .map((row) => row.getBoundingClientRect().height)
    };
  });
  expect(defaultLayout.columnGap).toBe("0px");
  expect(defaultLayout.heightDifference).toBeLessThanOrEqual(1);
  expect(defaultLayout.rowHeights.every((height) => height >= 33)).toBe(true);

  await page.getByRole("tab", { name: "Gear 1", exact: true }).click();
  await expect(gearTabs.nth(0)).toHaveAttribute("data-active", "true");

  await page.getByLabel("Gear 2 effort", { exact: true }).selectOption("xhigh");
  await expect(gearTabs.nth(1)).toHaveAttribute("data-active", "true");

  const gear3Model = page.getByLabel("Gear 3 model", { exact: true });
  await gear3Model.selectOption("gpt-5.4");
  await gear3Model.selectOption("gpt-5.6-sol");
  await expect(gearTabs.nth(2)).toHaveAttribute("data-active", "true");
  await expect(gear3Model).toHaveValue("gpt-5.6-sol");

  const selectSpacing = await gearSelects.evaluateAll((selects) =>
    selects.map((select) => {
      const style = getComputedStyle(select);
      return { borderWidth: style.borderTopWidth, margin: style.margin };
    })
  );
  expect(selectSpacing).toEqual(Array.from({ length: 6 }, () => ({ borderWidth: "0px", margin: "0px" })));

  await page.getByRole("textbox", { name: "Message" }).fill("Use the selected gear");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submittedSettings).toMatchObject({
    model: "gpt-5.6-sol",
    modelReasoningEffort: "high"
  });
});

test("keeps workspace model gears shared across threads and persists the active gear", async ({ page, request }) => {
  const localSession = scenarioSessions.modelGears;
  expect(localSession.id.startsWith("local_")).toBe(true);
  await selectSession(request, localSession.id);

  await page.goto(`/?workspaceId=default&sessionId=${localSession.id}`);
  await expect(page.locator(".content-header h1")).toHaveText(localSession.title);

  await page.getByRole("button", { name: "Configure model gears" }).click();
  const gearRadios = page.locator(".composer-gear-radio");
  const gear2Model = page.getByLabel("Gear 2 model", { exact: true });
  const gear2Effort = page.getByLabel("Gear 2 effort", { exact: true });
  const gear3Model = page.getByLabel("Gear 3 model", { exact: true });
  const gear3Effort = page.getByLabel("Gear 3 effort", { exact: true });

  await expect(gear2Model).toHaveValue("gpt-5.6-luna");
  await expect(gear2Effort).toHaveValue("xhigh");
  await expect(gear3Model).toHaveValue("gpt-5.4");
  await expect(gear3Effort).toHaveValue("medium");
  await expect(gearRadios.nth(1)).toHaveAttribute("data-active", "true");

  await gear3Model.selectOption("gpt-5.6-sol");
  await gear3Effort.selectOption("high");
  await page.getByRole("button", { name: "Activate gear 3" }).click();

  await expect(gear2Model).toHaveValue("gpt-5.6-luna");
  await expect(gear2Effort).toHaveValue("xhigh");
  await expect(gear3Model).toHaveValue("gpt-5.6-sol");
  await expect(gear3Effort).toHaveValue("high");
  await expect(gearRadios.nth(2)).toHaveAttribute("data-active", "true");

  await expect.poll(async () => {
    const response = await request.get(
      `${apiBaseUrl}/api/sessions/${encodeURIComponent(localSession.id)}/snapshot`
    );
    return (await response.json()).modelPreferences;
  }).toMatchObject({
    gearProfiles: [
      { model: "gpt-5.6-terra", effort: "low" },
      { model: "gpt-5.6-luna", effort: "xhigh" },
      { model: "gpt-5.6-sol", effort: "high" }
    ],
    activeGearIndex: 2
  });

  await page.locator(".session-row", { hasText: scenarioSessions.bootstrap.title }).dispatchEvent("click");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.bootstrap.title);
  await page.locator(".session-row", { hasText: localSession.title }).dispatchEvent("click");
  await expect(page.locator(".content-header h1")).toHaveText(localSession.title);

  await expect(gear2Model).toHaveValue("gpt-5.6-luna");
  await expect(gear2Effort).toHaveValue("xhigh");
  await expect(gear3Model).toHaveValue("gpt-5.6-sol");
  await expect(gear3Effort).toHaveValue("high");
  await expect(gearRadios.nth(2)).toHaveAttribute("data-active", "true");
});

test("keeps Auto selected across sessions and submits a Luna high per-session start", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.bootstrap.id);
  let submittedSettings: { model?: string; modelReasoningEffort?: string; autoModel?: boolean } | null = null;
  await page.route("**/api/chat", async (route) => {
    submittedSettings = route.request().postDataJSON() as typeof submittedSettings;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: "event: done\ndata: {\"ok\":true}\n\n"
    });
  });

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.bootstrap.title);
  await page.getByLabel("Gear 1 model", { exact: true }).selectOption("auto");
  await expect(page.getByLabel("Gear 1 model", { exact: true })).toHaveValue("auto");
  await expect(page.getByLabel("Gear 1 model", { exact: true }).locator("option:checked")).toHaveText("Auto");
  await expect(page.getByLabel("Gear 1 effort", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Current model", { exact: true })).toHaveText("Auto · 5.6 Luna · High");
  await page.locator(".session-row", { hasText: scenarioSessions.result.title }).dispatchEvent("click");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.result.title);
  await expect(page.getByLabel("Gear 1 model", { exact: true })).toHaveValue("auto");
  await expect(page.getByLabel("Current model", { exact: true })).toHaveText("Auto · 5.6 Luna · High");
  await page.getByRole("textbox", { name: "Message" }).fill("Use Auto");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submittedSettings).toMatchObject({
    model: "gpt-5.6-luna",
    modelReasoningEffort: "high",
    autoModel: true
  });
});

test("does not open a replay stream beside a newly started chat stream", async ({ page, request }) => {
  await selectSession(request, scenarioSessions.bootstrap.id);

  let releaseChat: (() => void) | undefined;
  const chatGate = new Promise<void>((resolve) => {
    releaseChat = resolve;
  });
  let replayStreamRequests = 0;
  page.on("request", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname === "/api/runner/stream") replayStreamRequests += 1;
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { sessionId: string; turnId: string };
    await chatGate;
    const reply = "Single streamed response";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        `event: session\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          message: "Mock chat stream started"
        })}`,
        `event: item\ndata: ${JSON.stringify({
          id: `${body.turnId}:agent-message`,
          itemType: "agent_message",
          text: reply,
          eventType: "item.completed"
        })}`,
        `event: result\ndata: ${JSON.stringify({
          sessionId: body.sessionId,
          turnId: body.turnId,
          elapsedMs: 10,
          reply
        })}`,
        "event: done\ndata: {\"ok\":true}"
      ].join("\n\n") + "\n\n"
    });
  });

  await page.goto("/");
  await expect(page.locator(".content-header h1")).toHaveText(scenarioSessions.bootstrap.title);
  await page.getByRole("textbox", { name: "Message" }).fill("Start one stream");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".turn-status").filter({ hasText: "Running" })).toHaveCount(1);

  await page.waitForTimeout(300);
  expect(replayStreamRequests).toBe(0);

  releaseChat?.();
  await expect(page.getByText("Single streamed response", { exact: true })).toBeVisible();
});
