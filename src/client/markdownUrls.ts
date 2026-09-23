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

/** Resolve links in a rendered workspace Markdown file from that file's directory. */
export function resolveWorkspaceMarkdownUrl(url: string, sourcePath: string) {
  const value = url.trim();
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("/") ||
      /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("\\\\")) return url;

  const relativePath = value.split(/[?#]/, 1)[0] ?? "";
  const normalizedSource = sourcePath.replaceAll("\\", "/");
  const directory = normalizedSource.slice(0, normalizedSource.lastIndexOf("/") + 1);
  const segments = [...directory.split("/"), ...decodePath(relativePath).replaceAll("\\", "/").split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length > 0 && !/^[a-z]:$/i.test(resolved[resolved.length - 1])) resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return `${normalizedSource.startsWith("/") ? "/" : ""}${resolved.join("/")}`;
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
 * Session references are copied in their Threadex URI form. In rendered
 * Markdown, point those at this UI instead of asking the browser to open an
 * external protocol handler. Legacy Codex references use the same route.
 */
export function threadexNavigationUrl(url: string): string | null {
  const reference = parseCodexReference(url);
  if (!reference) return null;

  const params = new URLSearchParams({ [reference.lookupKind]: reference.target });
  if (reference.workspaceId) {
    params.set("workspaceId", reference.workspaceId);
  }
  if (reference.turnId) params.set("turnId", reference.turnId);
  if (reference.turnNumbers) params.set("turnNumbers", reference.turnNumbers.join("/"));
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
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep malformed percent escapes as literal filename characters.
  }
  return decoded.replace(/^\/([a-zA-Z]:[\\/])/, "$1");
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
