import express, { type Request, type Response } from "express";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const COOKIE = "threadex_session";
const TTL = 30 * 24 * 60 * 60 * 1000;

// Local automation is trusted only on a direct loopback connection, never via a proxy.
export function directLocal(req: Request) {
  const address = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "")) return false;
  if (Object.keys(req.headers).some(key => key.startsWith("x-forwarded-") || key.startsWith("cf-") || key === "forwarded")) return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${req.headers.host}`).hostname); }
  catch { return false; }
}

export function createSecurity(file: string) {
  let password: { salt: string; hash: string; signingKey?: string } | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (password && (!/^[a-f0-9]{32}$/.test(password.salt) || !/^[a-f0-9]{128}$/.test(password.hash))) throw new Error("Invalid Threadex security configuration");
  if (password?.signingKey && !/^[a-f0-9]{64}$/.test(password.signingKey)) throw new Error("Invalid Threadex signing key");
  let signingKey = password?.signingKey ? Buffer.from(password.signingKey, "hex") : randomBytes(32);
  const persist = () => {
    if (!password) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...password, signingKey: signingKey.toString("hex") }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  if (password && !password.signingKey) persist();
  const active = new Set<Response>();
  const revoke = () => {
    signingKey = randomBytes(32);
    persist();
    for (const response of active) response.end();
    active.clear();
  };
  let attempts = 0;
  let windowEnd = 0;
  const router = express.Router();
  const token = (req: Request) => req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
  const signature = (expiry: string) => createHmac("sha256", signingKey).update(expiry).digest();
  const validToken = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    if (!/^\d{13}\.[a-f0-9]{64}$/.test(value)) return false;
    const [expiry, hash] = value.split(".");
    return Number(expiry) > Date.now() && timingSafeEqual(signature(expiry), Buffer.from(hash, "hex"));
  };
  const authenticated = (req: Request) => validToken(token(req));
  const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: "strict" as const, secure: !directLocal(req), path: "/" });
  const issue = (req: Request, res: Response) => {
    const expiry = String(Date.now() + TTL);
    const value = `${expiry}.${signature(expiry).toString("hex")}`;
    res.cookie(COOKIE, value, { ...cookieOptions(req), maxAge: TTL });
    return value;
  };
  const verify = (value: unknown) => typeof value === "string" && value.length <= 1024 && !!password && timingSafeEqual(scryptSync(value, password.salt, 64), Buffer.from(password.hash, "hex"));
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers["sec-fetch-site"] === "cross-site") { res.status(403).json({ error: "Cross-site requests are blocked." }); return; }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw new Error(); }
      catch { res.status(403).json({ error: "Origin does not match." }); return; }
    }
    next();
  });
  router.get("/security/status", (req, res) => res.json({ configured: !!password, authenticated: authenticated(req), canSetup: !password && directLocal(req) }));
  router.use("/security", express.json({ limit: "4kb" }));
  router.post("/security/restore", (req, res) => {
    const value = req.body?.token;
    if (!validToken(value)) { res.status(401).json({ error: "Please sign in again." }); return; }
    res.cookie(COOKIE, value, { ...cookieOptions(req), maxAge: Number(value.split(".")[0]) - Date.now() });
    res.json({ ok: true });
  });
  router.post(["/security/login", "/security/password"], (req, res) => {
    const setting = req.path === "/security/password";
    if (setting && (password ? !authenticated(req) : !directLocal(req))) { res.status(403).json({ error: "Sign in first, or set the initial password from localhost." }); return; }
    if (Date.now() > windowEnd) { attempts = 0; windowEnd = Date.now() + 60_000; }
    if (++attempts > 10) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "Too many attempts. Try again in a minute." }); return; }
    if ((!setting || password) && !verify(setting ? req.body?.currentPassword : req.body?.password)) { res.status(401).json({ error: "Incorrect password." }); return; }
    if (setting) {
      const value = req.body?.password;
      if (typeof value !== "string" || value.length < 12 || value.length > 1024) { res.status(400).json({ error: "Use a password with 12–1024 characters." }); return; }
      const salt = randomBytes(16).toString("hex");
      const nextPassword = { salt, hash: scryptSync(value, salt, 64).toString("hex") };
      password = nextPassword;
      revoke();
    }
    res.json({ ok: true, token: issue(req, res) });
  });
  router.post("/security/logout", (req, res) => {
    if (authenticated(req)) revoke();
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });
  router.use((req, res, next) => {
    if (authenticated(req)) {
      active.add(res);
      const timer = setTimeout(() => res.end(), Math.min(2_147_483_647, Number(token(req).split(".")[0]) - Date.now()));
      timer.unref();
      res.on("close", () => { clearTimeout(timer); active.delete(res); });
      next(); return;
    }
    if (directLocal(req) && !req.headers.origin && !req.headers["sec-fetch-site"] && req.headers["sec-fetch-mode"] !== "navigate") { next(); return; }
    res.status(401).json({ error: "Sign in to Threadex.", code: "AUTH_REQUIRED" });
  });
  return router;
}
