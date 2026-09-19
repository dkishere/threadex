import { Router } from "express";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Global server credential, never returned to clients or included in turn metadata. */
export class AutoModelSettings {
  constructor(private readonly path: string) {}

  apiKey(): string | undefined {
    try {
      // An explicitly cleared setting overrides an environment-provided default.
      return readFileSync(this.path, "utf8").trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to read Auto model settings.");
      return process.env.TYPESAFE_API_KEY?.trim() || undefined;
    }
  }

  status() {
    return { apiKeyConfigured: Boolean(this.apiKey()), selectorModel: "jev-latest" };
  }

  save(apiKey: string) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, apiKey.trim(), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.status();
  }
}

export function createAutoModelSettingsRouter(settings: AutoModelSettings) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", (_req, res) => {
    try { res.json(settings.status()); }
    catch { res.status(500).json({ error: "Unable to read Auto model settings." }); }
  });
  router.put("/", (req, res) => {
    const apiKey = req.body?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /\s/.test(apiKey.trim())) {
      res.status(400).json({ error: "Enter a valid TypeSafe API key." });
      return;
    }
    try { res.json(settings.save(apiKey)); }
    catch { res.status(500).json({ error: "Unable to save Auto model settings." }); }
  });
  router.delete("/", (_req, res) => {
    try { res.json(settings.save("")); }
    catch { res.status(500).json({ error: "Unable to clear Auto model settings." }); }
  });
  return router;
}
