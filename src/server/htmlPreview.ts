import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import express, { type Request } from "express";
import { canInlineWorkspaceFile, resolveWorkspaceFilePath } from "./workspaceFiles";

const grants = new Map<string, { root: string; pageRoot: string; expires: number }>();
const prefix = "/workspaces/html-content/";

export function clearHtmlPreviewGrants() {
  grants.clear();
}

export function createHtmlPreviewUrl(filePath: string, assetRoot = dirname(filePath)) {
  const root = realpathSync(assetRoot);
  const realFile = realpathSync(filePath);
  if (!resolveWorkspaceFilePath(root, realFile)) throw new Error("Preview must be inside its asset root.");
  const now = Date.now();
  for (const [key, grant] of grants) if (grant.expires <= now) grants.delete(key);
  if (grants.size >= 500) grants.delete(grants.keys().next().value!);
  const token = randomBytes(24).toString("hex");
  grants.set(token, { root, pageRoot: dirname(realFile), expires: now + 12 * 60 * 60 * 1000 });
  const urlPath = relative(root, realFile).split(sep).map(encodeURIComponent).join("/");
  return `/api${prefix}${token}/${urlPath}`;
}

function grantFor(token: string) {
  const grant = grants.get(token);
  return grant && grant.expires > Date.now() ? grant : null;
}

// Called with the /api mount removed. A capability never authorizes other APIs.
export function isHtmlPreviewRequest(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const match = /^\/workspaces\/html-content\/([a-f0-9]{48})\/.+/.exec(req.path);
  return !!match && !!grantFor(match[1]);
}

export function createHtmlPreviewRouter() {
  const router = express.Router();
  router.get(`${prefix}:token/*filePath`, (req, res) => {
    const grant = grantFor(req.params.token);
    if (!grant) { res.status(403).send("Preview expired. Reopen it from Threadex."); return; }
    const segments = req.params.filePath as unknown as string[];
    const filePath = resolveWorkspaceFilePath(grant.root, segments.join("/"));
    if (!filePath) { res.status(403).send("Path is outside the preview directory."); return; }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) { res.status(404).send("File not found."); return; }
    const realPath = realpathSync(filePath);
    if (!resolveWorkspaceFilePath(grant.root, realPath)) { res.status(403).send("Path is outside the preview directory."); return; }
    // Sibling images can be constructed dynamically by page scripts. Keep other
    // project files outside the cookie-free preview capability.
    if ((!resolveWorkspaceFilePath(grant.pageRoot, filePath) || !resolveWorkspaceFilePath(grant.pageRoot, realPath))
      && !(canInlineWorkspaceFile(filePath) && canInlineWorkspaceFile(realPath))) {
      res.status(403).send("Only images outside the preview directory are allowed."); return;
    }
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.sendFile(realPath);
  });
  return router;
}
