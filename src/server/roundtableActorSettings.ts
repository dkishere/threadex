import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { isClaudeModel, normalizeModelEffort } from "../modelCatalog";
import { parseRoundtablePresets, type RoundtableLibrary, type RoundtablePreset } from "../roundtablePresets";

export class RoundtableActorSettings {
  constructor(private readonly path: string) {}
  read(): RoundtableLibrary {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error("Invalid actor library revision.");
      // Older dropdowns allowed Codex-only levels on saved Claude actors.
      const actors = Array.isArray(data.actors) ? data.actors.map((actor: RoundtablePreset | null) =>
        actor && typeof actor.model === "string" && isClaudeModel(actor.model) && (actor.effort === "minimal" || actor.effort === "ultra")
          ? { ...actor, effort: normalizeModelEffort(actor.model, actor.effort) } : actor) : data.actors;
      return { revision: data.revision, actors: parseRoundtablePresets(actors) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, actors: [] };
      throw error;
    }
  }
  save(actors: unknown, revision: unknown): RoundtableLibrary {
    const parsed = parseRoundtablePresets(actors);
    const current = this.read();
    if (revision !== current.revision) throw new Error("Actor library changed. Reload before saving.");
    const next = { revision: current.revision + 1, actors: parsed };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
    return next;
  }
}
export function createRoundtableActorSettingsRouter(settings: RoundtableActorSettings) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", (_req, res) => {
    try { res.json(settings.read()); }
    catch { res.status(500).json({ error: "Unable to read actor library." }); }
  });
  router.put("/", (req, res) => {
    try { parseRoundtablePresets(req.body?.actors); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    try { res.json(settings.save(req.body.actors, req.body.revision)); }
    catch (error) {
      const conflict = (error as Error).message === "Actor library changed. Reload before saving.";
      res.status(conflict ? 409 : 500).json({ error: conflict ? (error as Error).message : "Unable to save actor library." });
    }
  });
  return router;
}
