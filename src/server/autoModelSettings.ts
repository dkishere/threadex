import { MODEL_CATALOG, supportsAutoLowEffort } from "../modelCatalog";
import { Router } from "express";
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AUTO_MODEL_CHOICES, isAutoEffort, type AutoCustomRules, type AutoModel } from "../autoModelCatalog";

/** Global server credential, never returned to clients or included in turn metadata. */
export class AutoModelSettings {
  constructor(private readonly path: string) {}

  private customRulesPath(): string {
    return `${this.path}.custom-rules.json`;
  }

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
    return {
      apiKeyConfigured: Boolean(this.apiKey()),
      selectorModel: "jev-latest",
      ...this.customRules()
    };
  }

  save(apiKey: string) {
    this.writePrivateSetting(this.path, apiKey.trim());
    return this.status();
  }

  customRules(): { customRulesEnabled: boolean; customRules: AutoCustomRules } {
    try {
      const parsed = JSON.parse(readFileSync(this.customRulesPath(), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { customRulesEnabled: false, customRules: {} };
      const source = parsed as Record<string, unknown>;
      const savedRules = source.customRules;
      const customRules: AutoCustomRules = {};
      if (!savedRules || typeof savedRules !== "object" || Array.isArray(savedRules)) {
        return { customRulesEnabled: false, customRules };
      }
      for (const model of Object.keys(AUTO_MODEL_CHOICES) as AutoModel[]) {
        const saved = savedRules as Record<string, unknown>;
        const aliases = Object.values(MODEL_CATALOG).find(entry => entry.id === model)?.aliases ?? [];
        const rule = saved[model] ?? aliases.map(alias => saved[alias]).find(value => value !== undefined);
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
        const record = rule as Record<string, unknown>;
        const efforts = Array.isArray(record.efforts) ? record.efforts.filter(isAutoEffort) : isAutoEffort(record.effort) ? [record.effort] : [];
        const allowed = [...new Set(efforts)].filter(effort => supportsAutoLowEffort(model) || !["low", "medium"].includes(effort));
        if (typeof record.enabled !== "boolean" || typeof record.condition !== "string") continue;
        customRules[model] = { enabled: record.enabled, efforts: allowed.length ? allowed : ["high"], condition: record.condition.trim() };
      }
      return { customRulesEnabled: source.customRulesEnabled === true, customRules };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw new Error("Unable to read Auto model settings.");
      return { customRulesEnabled: false, customRules: {} };
    }
  }

  saveCustomRules(customRulesEnabled: boolean, rules: AutoCustomRules) {
    const customRules: AutoCustomRules = {};
    for (const model of Object.keys(AUTO_MODEL_CHOICES) as AutoModel[]) {
      const rule = rules[model];
      if (rule) customRules[model] = { ...rule, condition: rule.condition.trim() };
    }
    this.writePrivateSetting(this.customRulesPath(), JSON.stringify({ customRulesEnabled, customRules }, null, 2));
    return this.status();
  }

  private writePrivateSetting(path: string, value: string) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
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
    const hasApiKey = Object.hasOwn(req.body ?? {}, "apiKey");
    const hasCustomRules = Object.hasOwn(req.body ?? {}, "customRulesEnabled") || Object.hasOwn(req.body ?? {}, "customRules");
    const apiKey = req.body?.apiKey;
    const customRulesEnabled = req.body?.customRulesEnabled;
    const customRules = req.body?.customRules;
    if (!hasApiKey && !hasCustomRules) {
      res.status(400).json({ error: "Provide an API key or custom rules." });
      return;
    }
    if (hasApiKey && (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 512 || /\s/.test(apiKey.trim()))) {
      res.status(400).json({ error: "Enter a valid TypeSafe API key." });
      return;
    }
    if (hasCustomRules) {
      if (typeof customRulesEnabled !== "boolean" || !customRules || typeof customRules !== "object" || Array.isArray(customRules)) {
        res.status(400).json({ error: "Custom rules must include an enabled flag and rule object." });
        return;
      }
      const allowedModels = new Set(Object.keys(AUTO_MODEL_CHOICES));
      const entries = Object.entries(customRules as Record<string, unknown>);
      const invalid = entries.some(([model, value]) => {
        if (!allowedModels.has(model) || !value || typeof value !== "object" || Array.isArray(value)) return true;
        const rule = value as Record<string, unknown>;
        return typeof rule.enabled !== "boolean" || !Array.isArray(rule.efforts) || !rule.efforts.length
          || rule.efforts.some(effort => !isAutoEffort(effort) || (!supportsAutoLowEffort(model) && ["low", "medium"].includes(effort)))
          || typeof rule.condition !== "string" || rule.condition.length > 10_000;
      });
      const totalChars = entries.reduce((total, [, value]) => total + String((value as Record<string, unknown>)?.condition ?? "").length, 0);
      const enabledCount = entries.filter(([, value]) => (value as Record<string, unknown>)?.enabled === true).length;
      if (invalid || totalChars > 20_000 || (customRulesEnabled && enabledCount === 0)) {
        res.status(400).json({ error: "Use valid model rules, enable at least one model, and keep conditions within 20,000 characters total." });
        return;
      }
    }
    try {
      if (hasApiKey) settings.save(apiKey);
      if (hasCustomRules) settings.saveCustomRules(customRulesEnabled, customRules as AutoCustomRules);
      res.json(settings.status());
    }
    catch { res.status(500).json({ error: "Unable to save Auto model settings." }); }
  });
  router.delete("/", (_req, res) => {
    try { res.json(settings.save("")); }
    catch { res.status(500).json({ error: "Unable to clear Auto model settings." }); }
  });
  return router;
}
