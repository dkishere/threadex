import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecurity } from "./security";

test("password gate, proxy isolation, rotation, CSRF, logout and persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadex-security-"));
  const file = join(dir, "security.json");
  const app = express();
  app.use("/api", createSecurity(file));
  app.get("/api/private", (_req, res) => res.json({ secret: true }));
  app.get("/api/stream", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write("data: connected\n\n"); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, body?: object, headers: Record<string, string> = {}) {
    return fetch(`${base}/api/${path}`, { method: body ? "POST" : "GET", headers: { "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  }
  const remote = { "x-forwarded-for": "203.0.113.5", "x-forwarded-proto": "https" };
  const password = "test-password-long-enough";
  try {
    assert.equal((await request("private")).status, 401);
    assert.equal((await request("security/status", undefined, remote).then(r => r.json())).canSetup, false);
    assert.equal((await request("security/password", { password }, remote)).status, 403);
    assert.equal((await request("security/password", { password }, { origin: "https://evil.example" })).status, 403);
    const setup = await request("security/password", { password });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const savedToken = (await setup.json()).token;
    assert.equal(savedToken, cookie.slice("threadex_session=".length));
    const restored = await request("security/restore", { token: savedToken }, remote);
    assert.equal(restored.status, 200);
    assert.equal(restored.headers.get("set-cookie")!.split(";")[0], cookie);
    app.use("/restarted/api", createSecurity(file));
    app.get("/restarted/api/private", (_req, res) => res.json({ ok: true }));
    assert.equal((await fetch(`${base}/restarted/api/private`, { headers: { ...remote, cookie } })).status, 200);
    assert.equal((await request("security/restore", { token: "invalid" })).status, 401);
    assert.match(cookie, /^threadex_session=\d{13}\.[a-f0-9]{64}$/);
    const [expiryPart, signature] = cookie.split(".");
    const tampered = `${expiryPart}.${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
    assert.equal((await request("private", undefined, { cookie: tampered })).status, 401);
    assert.equal((await request("private", undefined, { cookie: `threadex_session=1000000000000.${signature}` })).status, 401);
    assert.equal((await request("private", undefined, { cookie: "threadex_session=broken" })).status, 401);
    assert.match(setup.headers.get("set-cookie")!, /HttpOnly/);
    assert.match(setup.headers.get("set-cookie")!, /SameSite=Strict/);
    assert.equal(readFileSync(file, "utf8").includes(password), false);
    assert.equal((await request("private", undefined, { ...remote, cookie })).status, 200);
    assert.equal((await request("security/login", { password: "wrong" }, remote)).status, 401);
    const login = await request("security/login", { password }, remote);
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie")!, /Secure/);
    const other = login.headers.get("set-cookie")!.split(";")[0];
    const stream = await request("stream", undefined, { cookie: other });
    const reader = stream.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const changed = await request("security/password", { currentPassword: password, password: password + "-new" }, { cookie });
    assert.equal(changed.status, 200);
    assert.equal((await reader.read()).done, true);
    assert.equal((await request("private", undefined, { cookie: other })).status, 401);
    assert.equal((await request("security/restore", { token: savedToken })).status, 401);
    assert.equal((await request("private", undefined, { cookie })).status, 401);
    const fresh = changed.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await request("private", undefined, { cookie: fresh, "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await request("security/logout", {}, { cookie: fresh })).status, 200);
    assert.equal((await request("private", undefined, { cookie: fresh })).status, 401);
    assert.equal((await request("security/restore", { token: fresh.slice("threadex_session=".length) })).status, 401);
    for (let i = 0; i < 12; i++) await request("security/login", { password: "wrong" });
    assert.equal((await request("security/login", { password: password + "-new" })).status, 429);
    assert.doesNotThrow(() => createSecurity(file));
    // Proxy traffic cannot impersonate local automation, even without browser headers.
    assert.equal((await fetch(`${base}/api/private`, { headers: remote })).status, 401);
    assert.equal((await fetch(`${base}/api/private`)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
