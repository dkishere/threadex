import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";

const MAX_INSTRUCTIONS_BYTES = 32 * 1024;

export class GlobalAgentInstructions {
  constructor(private readonly path: string) {}

  read(): string {
    return existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
  }

  save(value: unknown): string {
    if (typeof value !== "string") {
      throw new Error("Instructions must be text.");
    }
    if (Buffer.byteLength(value, "utf8") > MAX_INSTRUCTIONS_BYTES) {
      throw new Error("Instructions must be 32 KiB or less.");
    }
    if (!value.trim()) {
      rmSync(this.path, { force: true });
      return "";
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return value;
  }
}

export function createGlobalAgentInstructionsRouter(settings: GlobalAgentInstructions) {
  const router = Router();
  router.get("/", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ instructions: settings.read() });
    } catch {
      res.status(500).json({ error: "Unable to load global instructions." });
    }
  });
  router.put("/", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ instructions: settings.save(req.body?.instructions) });
    } catch (error) {
      if (error instanceof Error && (error.message === "Instructions must be text." || error.message === "Instructions must be 32 KiB or less.")) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: "Unable to save global instructions." });
      }
    }
  });
  return router;
}
