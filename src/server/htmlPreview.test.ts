import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecurity } from "./security";
import { clearHtmlPreviewGrants, createHtmlPreviewRouter, createHtmlPreviewUrl } from "./htmlPreview";

test("sandbox assets work through a tunnel without cookies using only a scoped preview grant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-preview-"));
  mkdirSync(join(dir, "report", "images"), { recursive: true });
  writeFileSync(join(dir, "report", "index.html"), '<img src="images/hair.png">');
  writeFileSync(join(dir, "report", "images", "hair.png"), "image fixture");
  writeFileSync(join(dir, "secret.txt"), "outside report");
  const app = express();
  app.use("/api", createSecurity(join(dir, "security.json")));
  app.use("/api", createHtmlPreviewRouter());
  app.get("/api/prepare-preview", (_req, res) => res.json({ url: createHtmlPreviewUrl(join(dir, "report", "index.html")) }));
  app.get("/api/private", (_req, res) => res.send("private"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { "sec-fetch-site": "cross-site", origin: "null", "x-forwarded-for": "203.0.113.5", "x-forwarded-proto": "https" };
  try {
    const setup = await fetch(base + "/api/security/password", {
      method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ password: "preview-test-password" })
    });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    // The app prepares the capability before handing off to an external PWA window.
    const prepared = await fetch(base + "/api/prepare-preview", { headers: {
      ...headers, origin: base, "sec-fetch-site": "same-origin", cookie
    } });
    assert.equal(prepared.status, 200);
    const preparedUrl = (await prepared.json()).url;
    assert.equal((await fetch(base + preparedUrl, { headers })).status, 200);
    assert.equal((await fetch(base + "/api/prepare-preview", { headers })).status, 403);
    const preview = createHtmlPreviewUrl(join(dir, "report", "index.html"));
    const page = await fetch(base + preview, { headers });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /sandbox allow-scripts;/);
    assert.doesNotMatch(page.headers.get("content-security-policy")!, /allow-same-origin/);
    const image = new URL("images/hair.png", base + preview);
    assert.equal((await fetch(image, { headers })).status, 200);
    assert.equal((await fetch(image, { headers, method: "HEAD" })).status, 200);
    assert.equal((await fetch(image, { headers, method: "POST" })).status, 403);
    const prefix = preview.slice(0, preview.lastIndexOf("/") + 1);
    assert.equal((await fetch(base + prefix + "..%2Fsecret.txt", { headers })).status, 403);
    assert.equal((await fetch(base + "/api/private", { headers })).status, 403);
    assert.equal((await fetch(base + preview.replace(/content\/[a-f0-9]+/, `content/${"0".repeat(48)}`), { headers })).status, 403);
    clearHtmlPreviewGrants();
    assert.equal((await fetch(image, { headers })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
