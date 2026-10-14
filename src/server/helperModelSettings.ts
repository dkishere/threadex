import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { DEFAULT_MODEL, MODEL_OPTIONS, REVIEW_MODEL, normalizeModelId } from "../modelCatalog";

/**
 * Models for background helpers. Each helper has a base model and a promoted
 * model used for oversized input (long turns, long session transcripts).
 */
export type HelperModels = {
  summarizerModel: string;
  summarizerLongModel: string;
  grillModel: string;
  grillLongModel: string;
};

export const HELPER_MODEL_KEYS = ["summarizerModel", "summarizerLongModel", "grillModel", "grillLongModel"] as const satisfies ReadonlyArray<keyof HelperModels>;

export function defaultHelperModels(env: NodeJS.ProcessEnv = process.env): HelperModels {
  const summarizer = normalizeModelId(env.SESSION_SUMMARIZER_MODEL?.trim() || DEFAULT_MODEL);
  return { summarizerModel: summarizer, summarizerLongModel: summarizer, grillModel: DEFAULT_MODEL, grillLongModel: REVIEW_MODEL };
}

function isHelperModel(value: unknown): value is string {
  return typeof value === "string" && MODEL_OPTIONS.includes(normalizeModelId(value));
}

export class HelperModelSettings {
  constructor(private readonly path: string, private readonly defaults: HelperModels = defaultHelperModels()) {}

  read(): HelperModels {
    let saved: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw new Error("Unable to read helper model settings.");
    }
    const models = { ...this.defaults };
    for (const key of HELPER_MODEL_KEYS) {
      const value = saved[key];
      if (isHelperModel(value)) models[key] = normalizeModelId(value);
    }
    return models;
  }

  status() {
    return { models: this.read(), defaults: this.defaults };
  }

  save(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a model for each helper.");
    const input = value as Record<string, unknown>;
    const models = { ...this.read() };
    for (const key of HELPER_MODEL_KEYS) {
      if (input[key] === undefined) continue;
      if (!isHelperModel(input[key])) throw new Error("Choose a model for each helper.");
      models[key] = normalizeModelId(input[key]);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(models, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.status();
  }
}

export function createHelperModelSettingsRouter(settings: HelperModelSettings) {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", (_req, res) => {
    try { res.json(settings.status()); }
    catch { res.status(500).json({ error: "Unable to read helper model settings." }); }
  });
  router.put("/", (req, res) => {
    try { res.json(settings.save(req.body?.models)); }
    catch (error) {
      if (error instanceof Error && error.message === "Choose a model for each helper.") res.status(400).json({ error: error.message });
      else res.status(500).json({ error: "Unable to save helper model settings." });
    }
  });
  return router;
}
