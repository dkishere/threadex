import { parseCodexReference } from "../codexReference";

const WORKSPACE_FILE_ENDPOINT = "/api/workspaces/file";
const APP_ROOT_PREFIXES = ["/api/", "/assets/"];
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);

export type WorkspaceFileReference = {
  path: string;
  line?: number;
};

export type WorkspaceFilePreviewContext = {
  sessionId?: string;
  workspaceId?: string;
};

/**
 * Agent replies use absolute filesystem paths for clickable workspace files.
 * Browsers otherwise treat those paths as routes on the Threadex origin.
 */
export function transformMarkdownUrl(url: string, context: WorkspaceFilePreviewContext = {}) {
  const filePath = localFilePathFromMarkdownUrl(url);
  if (!filePath) return url;
  const reference = splitWorkspaceFileReference(filePath);
  const params = new URLSearchParams();
  if (reference.line) params.set("line", String(reference.line));
  if (context.sessionId) params.set("sessionId", context.sessionId);
  if (context.workspaceId) params.set("workspaceId", context.workspaceId);
  const suffix = params.toString();
  return `${WORKSPACE_FILE_ENDPOINT}?path=${encodeURIComponent(reference.path)}${suffix ? `&${suffix}` : ""}`;
}

export function workspaceFileDownloadUrl(url: string) {
  try {
    const parsed = new URL(url, "http://threadex.local");
    if (parsed.pathname !== WORKSPACE_FILE_ENDPOINT) return url;
    parsed.searchParams.set("download", "1");
    return `${parsed.pathname}?${parsed.searchParams}`;
  } catch {
    return url;
  }
}

export function workspaceFileReferenceFromUrl(url: string): WorkspaceFileReference | null {
  try {
    const parsed = new URL(url, "http://threadex.local");
    if (parsed.pathname !== WORKSPACE_FILE_ENDPOINT) return null;

    const path = parsed.searchParams.get("path");
    if (!path) return null;

    const reference = splitWorkspaceFileReference(path);
    const requestedLine = Number(parsed.searchParams.get("line"));
    return {
      path: reference.path,
      line: Number.isSafeInteger(requestedLine) && requestedLine > 0 ? requestedLine : reference.line
    };
  } catch {
    return null;
  }
}

export function workspaceFilePreviewUrl(path: string, context: WorkspaceFilePreviewContext = {}) {
  const params = new URLSearchParams({ path });
  if (context.sessionId) params.set("sessionId", context.sessionId);
  if (context.workspaceId) params.set("workspaceId", context.workspaceId);
  return `/api/workspaces/file-preview?${params}`;
}

export function isMarkdownFilePath(path: string) {
  const normalizedPath = path.split(/[?#]/, 1)[0] ?? "";
  return /\.(?:md|markdown)$/i.test(normalizedPath);
}

export function isJsonFilePath(path: string) {
  const normalizedPath = path.split(/[?#]/, 1)[0] ?? "";
  return /\.json$/i.test(normalizedPath);
}

export function isHtmlFilePath(path: string) {
  return /\.html?$/i.test(path);
}

export function workspaceHtmlPreviewUrl(path: string, context: WorkspaceFilePreviewContext = {}) {
  const normalized = path.replaceAll("\\", "/");
  const kind = /^[a-z]:\//i.test(normalized) ? "windows" : "posix";
  const parts = normalized.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `/api/workspaces/html/${encodeURIComponent(context.workspaceId || "active")}/${encodeURIComponent(context.sessionId || "none")}/${kind}/${parts}`;
}

/**
 * Session references are normally copied in their Codex URI form. In rendered
 * Markdown, point those at this UI instead of asking the browser to open an
 * external `codex://` handler.
 */
export function threadexNavigationUrl(url: string): string | null {
  const reference = parseCodexReference(url);
  if (!reference || reference.lookupKind !== "sessionId") return null;

  const params = new URLSearchParams({ sessionId: reference.target });
  if (reference.workspaceId) {
    params.set("workspaceId", reference.workspaceId);
  }
  return `?${params}`;
}

export function workspaceImagePreviewName(url: string): string | null {
  try {
    const parsed = new URL(url, "http://threadex.local");
    if (parsed.pathname !== WORKSPACE_FILE_ENDPOINT) return null;
    const filePath = parsed.searchParams.get("path");
    if (!filePath || !isPreviewableImagePath(filePath)) return null;
    return filePath.split(/[\\/]/).at(-1) || "Image preview";
  } catch {
    return null;
  }
}

export function localFilePathFromMarkdownUrl(url: string): string | null {
  const value = url.trim();
  if (!value) return null;

  if (/^file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname && parsed.hostname !== "localhost") return null;
      return decodePath(parsed.pathname);
    } catch {
      return null;
    }
  }

  // Keep protocol-relative web links and Threadex's own root endpoints intact.
  if (value.startsWith("//") || APP_ROOT_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return null;
  }

  const pathWithoutQueryOrFragment = value.split(/[?#]/, 1)[0] ?? "";
  if (pathWithoutQueryOrFragment.startsWith("/")) {
    return decodePath(pathWithoutQueryOrFragment);
  }

  // This also handles paths copied from Windows-hosted workspaces.
  if (/^[a-zA-Z]:[\\/]/.test(pathWithoutQueryOrFragment)) {
    return decodePath(pathWithoutQueryOrFragment);
  }

  return null;
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitWorkspaceFileReference(value: string): WorkspaceFileReference {
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match || !match[1]) return { path: value };

  const line = Number(match[2]);
  return Number.isSafeInteger(line) && line > 0 ? { path: match[1], line } : { path: value };
}

function isPreviewableImagePath(filePath: string) {
  const normalizedPath = filePath.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const extensionStart = normalizedPath.lastIndexOf(".");
  return extensionStart >= 0 && PREVIEWABLE_IMAGE_EXTENSIONS.has(normalizedPath.slice(extensionStart));
}
