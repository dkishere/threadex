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
  if (!allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}${sep}`))) {
    return null;
  }
  return filePath;
}

export function canInlineWorkspaceFile(filePath: string) {
  return SAFE_INLINE_IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}
