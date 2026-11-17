import { expect, type Page, type Route } from "@playwright/test";
import { test } from "./support/authenticated-test";
import { scenarioSessions } from "./support/scenarios.js";

const alpha = scenarioSessions.switchAlpha;
const beta = scenarioSessions.switchBeta;
const missing = scenarioSessions.result;
const fixtures: Record<string, { model: string; reasoningEffort: string; requestedServiceTier: string }> = {
  [alpha.id]: { model: "claude-opus-5-5", reasoningEffort: "high", requestedServiceTier: "fast" },
  [beta.id]: { model: "gpt-6-sol", reasoningEffort: "high", requestedServiceTier: "default" }
};

async function setup(page: Page) {
  const sends: Array<Record<string, unknown>> = [];
  // No test in this file can start a real runner, even if an assertion fails.
  await page.route("**/api/chat", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: done\ndata: {"ok":true}\n\n' });
  });
  await page.route("**/api/pending-turns", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { error: "Unexpected queued prompt in test" } })
    : route.continue());
  await page.route("**/api/workspace-model-preferences/**", route => route.fulfill({ status: 200, json: {} }));
  const inject = (snapshot: any) => {
    const id = snapshot?.session?.id;
    if (!id || !Array.isArray(snapshot.turns)) return;
    const turn = snapshot.turns.at(-1);
    if (!turn) return;
    delete turn.model;
    delete turn.reasoningEffort;
    delete turn.requestedServiceTier;
    if (fixtures[id]) Object.assign(turn, fixtures[id]);
  };
  let delayAlpha: Promise<void> | undefined;
  let failAlpha = false;
  let releaseAlpha: (() => void) | undefined;
  let alphaStarted: (() => void) | undefined;
  let alphaRequest = new Promise<void>(resolve => { alphaStarted = resolve; });
  const patchResponse = async (route: Route) => {
    if (new URL(route.request().url()).pathname === "/api/sessions/switch" &&
        route.request().postDataJSON()?.sessionId === alpha.id && failAlpha) {
      failAlpha = false;
      await route.fulfill({ status: 503, json: { error: "Test switch failure" } });
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    inject(body);
    inject(body.activeSession);
    if (new URL(route.request().url()).pathname === "/api/sessions/switch" &&
        route.request().postDataJSON()?.sessionId === alpha.id && delayAlpha) {
      alphaStarted?.();
      await delayAlpha;
    }
    await route.fulfill({ response, json: body });
  };
  await page.route("**/api/workspace/snapshot**", patchResponse);
  await page.route("**/api/sessions/*/snapshot**", patchResponse);
  await page.route("**/api/sessions/switch", patchResponse);
  return {
    sends,
    delayNextAlpha() {
      delayAlpha = new Promise<void>(resolve => { releaseAlpha = resolve; });
      alphaRequest = new Promise<void>(resolve => { alphaStarted = resolve; });
      return alphaRequest;
    },
    releaseAlpha() { releaseAlpha?.(); delayAlpha = undefined; },
    failNextAlpha() { failAlpha = true; }
  };
}

async function open(page: Page, session: { id: string; title: string } = alpha) {
  await page.goto(`/?workspaceId=default&sessionId=${session.id}`);
  await expect(page.locator(`.session-row[data-session-id="${session.id}"]`)).toHaveAttribute("data-active", "true");
}

async function switchTo(page: Page, session: { id: string; title: string }) {
  await page.locator(`.session-row[data-session-id="${session.id}"]`).dispatchEvent("click");
  await expect(page.locator(`.session-row[data-session-id="${session.id}"]`)).toHaveAttribute("data-active", "true");
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const send = (page: Page) => page.getByRole("button", { name: "Send", exact: true }).click();

test("inherited last turn sends its model, effort and fast mode without an override", async ({ page }) => {
  const { sends } = await setup(page);
  await open(page);
  const inherited = page.getByRole("button", { name: "Override session model settings" });
  await expect(inherited).toContainText("Opus 5.5");
  await expect(inherited).toContainText("High");
  await expect(inherited).toContainText("Fast");
  await expect(inherited).toContainText("Inherited");
  await expect(page.locator('aside[aria-label="Model gears"]')).toHaveAttribute("data-state", "inherited");
  expect(Number(await inherited.evaluate(element => getComputedStyle(element).opacity))).toBeLessThan(1);
  await editor(page).fill("Use inherited settings");
  await send(page);
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ model: "claude-opus-5-5", modelReasoningEffort: "high", fastMode: true });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

for (const [from, to, destination] of [
  [alpha, "gpt-6-sol", "Codex"],
  [beta, "claude-opus-5-5", "Claude Code"]
] as const) {
  test(`switching from ${from.title} to ${destination} asks before sending and cancel preserves the draft`, async ({ page }) => {
    const { sends } = await setup(page);
    await open(page, from);
    await page.getByRole("button", { name: "Override session model settings" }).click();
    await page.getByRole("button", { name: "Configure model gears" }).click();
    await page.getByLabel("Gear 1 model", { exact: true }).selectOption(to);
    await page.getByRole("button", { name: "Activate gear 1", exact: true }).click();
    await editor(page).fill("Keep this draft");
    await send(page);
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`to ${destination}`);
    if (destination === "Codex") {
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        const colors = await dialog.evaluate(element => {
          const style = getComputedStyle(element);
          const luminance = (color: string) => {
            const channels = color.match(/\d+/g)!.slice(0, 3).map(Number).map(value => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
          };
          const values = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
          return { color: style.color, background: style.backgroundColor, contrast: (values[1] + 0.05) / (values[0] + 0.05) };
        });
        console.log(`dialog ${theme}: ${JSON.stringify(colors)}`);
        expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
      }
    }
    if (destination === "Codex") await dialog.press("Escape");
    else await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(editor(page)).toHaveText("Keep this draft");
    await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText(
      destination === "Codex" ? "Opus 5.5" : "6 Sol"
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();
    expect(sends).toHaveLength(0);
    await page.getByRole("button", { name: "Override session model settings" }).click();
    await page.getByRole("button", { name: "Configure model gears" }).click();
    await page.getByLabel("Gear 1 model", { exact: true }).selectOption(to);
    await page.getByRole("button", { name: "Activate gear 1", exact: true }).click();
    await send(page);
    if (destination === "Codex") await page.getByRole("alertdialog").getByRole("button", { name: "Switch and send" }).press("Enter");
    else await page.getByRole("alertdialog").getByRole("button", { name: "Switch and send" }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0]).toMatchObject({ model: to });
  });
}

test("late switch response cannot replace the selected session settings", async ({ page }) => {
  const fixture = await setup(page);
  await open(page, missing);
  await editor(page).fill("Do not send during switching");
  const started = fixture.delayNextAlpha();
  await page.locator(`.session-row[data-session-id="${alpha.id}"]`).dispatchEvent("click");
  await started;
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(fixture.sends).toHaveLength(0);
  await switchTo(page, beta);
  fixture.releaseAlpha();
  await expect(page.locator(`.session-row[data-session-id="${beta.id}"]`)).toHaveAttribute("data-active", "true");
  await editor(page).fill("Use beta settings");
  await send(page);
  await expect.poll(() => fixture.sends.length).toBe(1);
  expect(fixture.sends[0]).toMatchObject({ sessionId: beta.id, model: "gpt-6-sol", modelReasoningEffort: "high", fastMode: false });
});

test("failed session switch restores the previous inherited settings and draft", async ({ page }) => {
  const fixture = await setup(page);
  await open(page, beta);
  await editor(page).fill("Keep beta draft after failure");
  fixture.failNextAlpha();
  const failedSwitch = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sessions/switch" && response.status() === 503);
  await page.locator(`.session-row[data-session-id="${alpha.id}"]`).dispatchEvent("click");
  await failedSwitch;
  await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("6 Sol");
  await expect(editor(page)).toHaveText("Keep beta draft after failure");
  await send(page);
  await expect.poll(() => fixture.sends.length).toBe(1);
  expect(fixture.sends[0]).toMatchObject({ sessionId: beta.id, model: "gpt-6-sol", modelReasoningEffort: "high" });
});

for (const method of ["click", "keyboard"] as const) {
  test(`${method} enables override and switching sessions restores inheritance`, async ({ page }) => {
    await setup(page);
    await open(page);
    const button = page.getByRole("button", { name: "Override session model settings" });
    if (method === "click") await button.click();
    else { await button.focus(); await button.press("Enter"); }
    await expect(button).toHaveCount(0);
    const gears = page.getByRole("button", { name: "Configure model gears" });
    await expect(gears).toBeVisible();
    // Releasing inheritance seeds the user's own active gear, not the last turn's Opus.
    const activeGear = page.locator('input[name="main-composer-gear-active"]:checked');
    await expect(activeGear).toHaveAttribute("aria-label", /6 (Luna|Sol)/);
    await expect(activeGear).not.toHaveAttribute("aria-label", /Opus/);
    await switchTo(page, beta);
    await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("6 Sol");
    await switchTo(page, alpha);
    await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("Opus 5.5");
  });
}

test("same provider override sends without confirmation", async ({ page }) => {
  const { sends } = await setup(page);
  await open(page, beta);
  await page.getByRole("button", { name: "Override session model settings" }).click();
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await page.getByLabel("Gear 1 model", { exact: true }).selectOption("gpt-6-luna");
  await page.getByRole("button", { name: "Activate gear 1", exact: true }).click();
  await editor(page).fill("Same provider");
  await send(page);
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ model: "gpt-6-luna" });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("task gear edits persist 6.2 presets in localStorage across switches and reloads after server acknowledgment", async ({ page }) => {
  await setup(page);
  const savedRequests: Array<Record<string, any>> = [];
  await page.route("**/api/workspace-model-preferences/**", async route => {
    savedRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: {} });
  });
  await open(page, beta);
  await page.getByRole("button", { name: "Override session model settings" }).click();
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await page.getByLabel("Gear 5 model", { exact: true }).selectOption("gpt-6.2-astra");
  await page.getByLabel("Gear 6 model", { exact: true }).selectOption("gpt-6.2-sol");
  await page.getByLabel("Gear 6 effort", { exact: true }).selectOption("ultra");
  await page.getByRole("switch", { name: "Gear 6 fast mode", exact: true }).click();
  await page.getByRole("button", { name: "Activate gear 6", exact: true }).click();
  await expect.poll(() => savedRequests.at(-1)).toMatchObject({ activeGearIndex: 5,
    gearProfiles: [expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ model: "gpt-6.2-astra" }), { model: "gpt-6.2-sol", effort: "ultra", fastMode: true }] });
  await expect.poll(() => page.evaluate(() => {
    const outbox = JSON.parse(localStorage.getItem("threadex.model-selector") ?? "null");
    return outbox?.selectors?.default ?? null;
  })).toBeNull();
  // Refresh the manually configured task itself, not only a different task
  // whose last-turn inheritance hides the saved presets.
  await page.reload();
  await expect(page.getByRole("button", { name: "Override session model settings" })).toHaveCount(0);
  await expect(page.locator('input[name="main-composer-gear-active"]:checked')).toHaveAttribute("id", "main-composer-gear-6");
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.getByLabel("Gear 6 model", { exact: true })).toHaveValue("gpt-6.2-sol");
  await expect(page.getByLabel("Gear 6 effort", { exact: true })).toHaveValue("ultra");
  await expect(page.getByRole("switch", { name: "Gear 6 fast mode", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await switchTo(page, alpha);
  // Last-turn inheritance remains independent of the edited presets.
  await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("Opus 5.5");
  await page.reload();
  await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("Opus 5.5");
  await page.getByRole("button", { name: "Override session model settings" }).click();
  await expect(page.locator('input[name="main-composer-gear-active"]:checked')).toHaveAttribute("id", "main-composer-gear-6");
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await expect(page.getByLabel("Gear 5 model", { exact: true })).toHaveValue("gpt-6.2-astra");
  await expect(page.getByLabel("Gear 6 model", { exact: true })).toHaveValue("gpt-6.2-sol");
  await expect(page.getByLabel("Gear 6 effort", { exact: true })).toHaveValue("ultra");
  await expect(page.getByRole("switch", { name: "Gear 6 fast mode", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("manual 6.2 selection survives group chat task preview bootstrap and refresh", async ({ page }) => {
  await setup(page);
  await page.goto(`/?workspaceId=default&sessionId=${beta.id}#view=workspace-chat&chat=unassigned`);
  await page.getByRole("button", { name: "Override session model settings" }).click();
  await page.locator('button[aria-controls="main-composer-gear-menu"]').click();
  const menu = page.locator("#main-composer-gear-menu");
  await menu.getByLabel("Gear 6 model", { exact: true }).selectOption("gpt-6.2-sol");
  await menu.getByRole("button", { name: "Activate gear 6", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("threadex.session-gear-override") ?? "null")))
    .toEqual({ sessionId: beta.id, activeGearIndex: 5 });
  await page.reload();
  await expect(page.locator('input[name="main-composer-gear-active"]:checked')).toHaveAttribute("aria-label", /6\.2 Sol/);
  await expect(page.getByRole("button", { name: "Override session model settings" })).toHaveCount(0);
  // A second refresh also exercises initialization from an already-restored override.
  await page.reload();
  await expect(page.locator('input[name="main-composer-gear-active"]:checked')).toHaveAttribute("aria-label", /6\.2 Sol/);
});

test("Claude to Auto asks for confirmation and Escape restores inherited settings", async ({ page }) => {
  const { sends } = await setup(page);
  await open(page);
  await page.getByRole("button", { name: "Override session model settings" }).click();
  await page.getByRole("button", { name: "Configure model gears" }).click();
  await page.getByLabel("Gear 1 model", { exact: true }).selectOption("auto");
  await page.getByRole("button", { name: "Activate gear 1", exact: true }).click();
  await editor(page).fill("Keep Auto draft");
  await send(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("to Codex");
  await dialog.press("Escape");
  await expect(page.getByRole("button", { name: "Override session model settings" })).toContainText("Opus 5.5");
  await expect(editor(page)).toHaveText("Keep Auto draft");
  expect(sends).toHaveLength(0);
});

test("missing turn settings and a new session retain workspace gear fallback", async ({ page }) => {
  await setup(page);
  await open(page, missing);
  await expect(page.getByRole("button", { name: "Configure model gears" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Override session model settings" })).toHaveCount(0);
  await switchTo(page, alpha);
  await expect(page.getByRole("button", { name: "Override session model settings" })).toBeVisible();
  await page.getByRole("button", { name: /^New thread/ }).first().click();
  await expect(page.getByRole("button", { name: "Configure model gears" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Override session model settings" })).toHaveCount(0);
});

for (const [width, method] of [[1280, "click"], [390, "Enter"], [320, "Space"]] as const) {
  test(`inherited gear layout and ${method} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page);
    await open(page);
    const button = page.getByRole("button", { name: "Override session model settings" });
    await expect(button).toBeVisible();
    // Exercise truncation with an unusually long label without changing production model definitions.
    await button.locator(".composer-gear-inherited-model").evaluate(element => {
      element.textContent = "An exceptionally long inherited model name for layout verification";
    });
    await page.screenshot({ path: `/private/tmp/threadex-inherited-gear-${width}.png` });
    const geometry = await button.evaluate(element => {
      const details = element.querySelector(".composer-gear-inherited-details")!;
      const text = details.lastElementChild!.firstChild!;
      const range = document.createRange();
      const content = text.textContent!;
      range.setStart(text, content.indexOf("Inherited"));
      range.setEnd(text, content.length);
      const textRect = range.getBoundingClientRect();
      const detailsRect = details.getBoundingClientRect();
      const buttonRect = element.getBoundingClientRect();
      const layoutRect = element.closest(".composer-layout")!.getBoundingClientRect();
      const overlap = Array.from(element.closest(".composer-layout")!.querySelectorAll("button"))
        .filter(other => !element.contains(other) && other !== element)
        .map(other => ({ name: other.getAttribute("aria-label") || other.textContent, rect: other.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.left < buttonRect.right - 1 && rect.right > buttonRect.left + 1 && rect.top < buttonRect.bottom - 1 && rect.bottom > buttonRect.top + 1)
        .map(({ name }) => name);
      return { textRight: textRect.right, detailsRight: detailsRect.right, buttonRight: buttonRect.right, layoutRight: layoutRect.right, layoutLeft: layoutRect.left, overlap };
    });
    expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.layoutRight + 1);
    expect(geometry.layoutLeft).toBeGreaterThanOrEqual(-1);
    expect(geometry.layoutRight).toBeLessThanOrEqual(width + 1);
    expect(geometry.overlap).toEqual([]);
    if (method === "click") await button.click();
    else { await button.focus(); await button.press(method); }
    await expect(page.getByRole("button", { name: "Configure model gears" })).toBeVisible();
    await page.screenshot({ path: `/private/tmp/threadex-override-gear-${width}.png` });
    expect(geometry.textRight, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.detailsRight);
  });
}
