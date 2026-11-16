import { realpathSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const SAFE_INLINE_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);

export function resolveWorkspaceFilePath(workspaceCwd: string, requestedPath: string, additionalRoots: string[] = []) {
  const workspaceRoot = resolve(workspaceCwd);
  const normalizedPath = process.platform === "win32" ? requestedPath.replace(/^\/([a-zA-Z]:[\\/])/, "$1") : requestedPath;
  const filePath = resolve(workspaceRoot, normalizedPath);
  const allowedRoots = [workspaceRoot, ...additionalRoots.map((root) => resolve(root))];
  if (isInsideAnyRoot(filePath, allowedRoots)) return filePath;
  // Agents often cite aliases of an allowed root, such as macOS /tmp for the
  // /private/tmp runner root. Accept them only when the existing file's
  // canonical location is inside a canonical allowed root.
  const canonicalFilePath = canonicalExistingPath(filePath);
  if (!canonicalFilePath) return null;
  const canonicalRoots = allowedRoots.map((root) => canonicalExistingPath(root) ?? root);
  return isInsideAnyRoot(canonicalFilePath, canonicalRoots) ? canonicalFilePath : null;
}

function isInsideAnyRoot(filePath: string, roots: string[]) {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}${sep}`));
}

function canonicalExistingPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function canInlineWorkspaceFile(filePath: string) {
  return SAFE_INLINE_IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}
