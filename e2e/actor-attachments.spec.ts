import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyActorRoom, type ActorRoom, type SubmitActorRequest } from "../src/domainActors";
import { DEFAULT_MODEL } from "../src/modelCatalog";
import { DomainActorStore, type ActorPersistence } from "../src/server/domainActorStore";
import { DomainActorService } from "../src/server/domainActorService";
import { saveActorAttachments } from "../src/server/domainActorAttachments";

async function fixture(page: Page) {
  const directory = mkdtempSync(join(tmpdir(), "actor-attachment-ui-"));
  let room: ActorRoom = emptyActorRoom("attachment-test");
  const store = new DomainActorStore({ getWorkspace: async () => ({ id: room.workspaceId }),
    getDomainActorRoom: async () => structuredClone(room),
    changeDomainActorRoom: async (_id: string, mutate: (draft: ActorRoom) => unknown) => {
      const draft = structuredClone(room); const result = mutate(draft); draft.revision++; room = draft; return result;
    }, captureActorCostBaseline: async () => ({ capturedAt: "now", usage: [] }), getDomainActorRunningSessions: async () => []
  } as unknown as ActorPersistence);
  const received: string[] = [], calls: SubmitActorRequest[] = [];
  let fail = false;
  const service = new DomainActorService(store, {
    saveAttachments: (ws, id, files) => saveActorAttachments(directory, ws, id, files),
    policy: () => ({ order: ["fake"], threshold: {} }), decide: async () => { throw new Error("Explicit recipients bypass routing"); },
    respond: async ({ round }) => {
      const contents = round.attachments!.map(file => readFileSync(file.path!, "utf8")); received.push(...contents);
      return { text: `Received: ${contents.map(text => text.length > 200 ? `${text.length} bytes` : text).join(" | ")}`, claim: false };
    }, startTask: async () => { throw new Error("Discussion only"); }, maintain: async ({ actor }) => actor.memory
  });
  for (const [id, name] of [["files", "Files"], ["ui", "UI"]]) await service.createActor(room.workspaceId, {
    id, name, model: DEFAULT_MODEL, memory: { rolePrompt: "Read files", roleSummary: name, longTerm: "", rolling: "" }
  });
  await page.route("**/api/composer-suggestion-keywords?**", route => route.fulfill({ json: { keywords: [] } }));
  await page.route("**/api/composer-suggestions?**", route => route.fulfill({ json: { entries: [] } }));
  await page.route("**/api/skills?**", route => route.fulfill({ json: { skills: [] } }));
  await page.route("**/api/domain-actors/attachment-test/**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/room")) return route.fulfill({ json: room });
    const input = route.request().postDataJSON(); calls.push(input);
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: "Temporary delivery failure" } }); }
    try { return route.fulfill({ json: await service.submit({ ...input, workspaceId: room.workspaceId }) }); }
    catch (error) { return route.fulfill({ status: 400, json: { error: String(error) } }); }
  });
  await page.goto("/e2e/support/actor-attachments.html");
  await expect(page.getByRole("textbox", { name: "Message actors" })).toBeVisible();
  await expect(page.getByLabel("Message audience")).toHaveCount(0);
  return { received, calls, directory, failNext: () => { fail = true; }, clean: () => rmSync(directory, { recursive: true, force: true }) };
}
const textFile = (name: string, contents: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(contents) });

test("individual files reach the production receiver without adding mentioned actors; removal and pure-file sends work", async ({ page }) => {
  const state = await fixture(page);
  try {
    const input = page.getByLabel("Attach files to actor message");
    await input.setInputFiles([textFile("keep.txt", "individual bytes"), textFile("remove.txt", "must never arrive")]);
    await page.getByRole("button", { name: "Remove remove.txt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove remove.txt", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Preview keep.txt", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Preview keep.txt", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close preview for keep.txt", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Received: individual bytes", { exact: true })).toBeVisible();
    expect(state.received).toEqual(["individual bytes"]);
    expect(state.calls[0].userPrompt).toBe("");
    await expect(page.locator(".side-chat-question .attachment-card-name")).toHaveText("keep.txt");
    await page.getByRole("textbox", { name: "Message actors" }).fill("@UI read this file");
    await input.setInputFiles(textFile("group.txt", "group bytes"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Received: group bytes", { exact: true })).toHaveCount(1);
    expect(state.calls[1].namedActorIds).toEqual(["files"]);
    expect(state.received).toEqual(["individual bytes", "group bytes"]);
  } finally { state.clean(); }
});

test("delivery failure keeps attachment bytes for the same-request retry", async ({ page }) => {
  const state = await fixture(page);
  try {
    state.failNext();
    await page.getByLabel("Attach files to actor message").setInputFiles(textFile("retry.txt", "retry bytes"));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Temporary delivery failure");
    await page.getByRole("button", { name: "Retry same request" }).click();
    await expect(page.getByText("Received: retry bytes", { exact: true })).toBeVisible();
    expect(state.calls[0]).toEqual(state.calls[1]); expect(state.received).toEqual(["retry bytes"]);
  } finally { state.clean(); }
});

test("file read errors are visible and do not submit an empty message", async ({ page }) => {
  const state = await fixture(page);
  try {
    await page.evaluate(() => { FileReader.prototype.readAsDataURL = function () { this.dispatchEvent(new ProgressEvent("error")); }; });
    await page.getByLabel("Attach files to actor message").setInputFiles(textFile("broken.txt", "unreadable"));
    await expect(page.getByRole("alert")).toContainText("Could not read broken.txt");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(state.calls).toHaveLength(0);
  } finally { state.clean(); }
});

test("large files use the existing upload endpoint and reach the receiver by path", async ({ page }) => {
  const state = await fixture(page);
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, "x");
    await page.route("**/api/attachments/upload", async route => {
      const path = join(state.directory, "large.txt");
      const uploaded = route.request().postDataBuffer()!;
      expect(uploaded).toEqual(bytes);
      expect(route.request().headers()["x-attachment-name"]).toBe("large.txt");
      writeFileSync(path, uploaded);
      return route.fulfill({ json: { attachment: { id: "large", name: "large.txt", type: "text/plain", size: bytes.length, path } } });
    });
    await page.getByLabel("Attach files to actor message").setInputFiles({ name: "large.txt", mimeType: "text/plain", buffer: bytes });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText(`Received: ${bytes.length} bytes`, { exact: true })).toBeVisible();
    expect(state.calls[0].attachments?.[0].dataUrl).toBeUndefined();
    expect(state.received[0]).toBe(bytes.toString());
  } finally { state.clean(); }
});

test("upload failure reports the error and preserves the text for another attempt", async ({ page }) => {
  const state = await fixture(page);
  try {
    await page.route("**/api/attachments/upload", route => route.fulfill({ status: 503, json: { error: "Upload unavailable" } }));
    await page.getByRole("textbox", { name: "Message actors" }).fill("Keep my message");
    await page.getByLabel("Attach files to actor message").setInputFiles({ name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(page.getByRole("alert")).toContainText("Upload unavailable");
    await expect(page.getByRole("textbox", { name: "Message actors" })).toHaveText("Keep my message");
    expect(state.calls).toHaveLength(0);
  } finally { state.clean(); }
});
