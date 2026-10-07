import { Router } from "express";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function readWebVsCodeAnnotations(dataDir: string, sessionId: string) {
  const directory = resolve(dataDir, "code-server", "annotations");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).flatMap(name => {
    try {
      const file = resolve(directory, name);
      if (statSync(file).size > 100_000) return [];
      const value = JSON.parse(readFileSync(file, "utf8"));
      const annotation = value.annotation;
      const selection = annotation?.source?.selection;
      if (value.version !== 1 || value.sessionId !== sessionId || `${value.id}.json` !== name
        || typeof annotation?.text !== "string" || !annotation.text.trim() || annotation.text.length > 12_000
        || typeof annotation.annotation !== "string" || !annotation.annotation.trim() || annotation.annotation.length > 4_000
        || annotation.source?.type !== "file" || typeof annotation.source.path !== "string"
        || !selection || ![selection.startLine, selection.endLine, selection.startColumn, selection.endColumn].every(n => Number.isInteger(n) && n > 0)) return [];
      return [value];
    } catch { return []; }
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function createWebVsCodeAnnotationsRouter(dataDir: string, store: {
  getSession(id: string): Promise<{ workspaceId: string } | null>;
  getActiveWorkspace(): Promise<{ id: string }>;
}) {
  const router = Router();
  router.use("/:sessionId/vscode-annotations", async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      const workspace = await store.getActiveWorkspace();
      if (!session || session.workspaceId !== workspace.id) { res.sendStatus(404); return; }
      next();
    } catch (error) { next(error); }
  });
  router.get("/:sessionId/vscode-annotations", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ annotations: readWebVsCodeAnnotations(dataDir, req.params.sessionId) });
  });
  router.delete("/:sessionId/vscode-annotations/:id", (req, res) => {
    const value = readWebVsCodeAnnotations(dataDir, req.params.sessionId).find(item => item.id === req.params.id);
    if (value) rmSync(resolve(dataDir, "code-server", "annotations", `${value.id}.json`), { force: true });
    res.sendStatus(204);
  });
  return router;
}
