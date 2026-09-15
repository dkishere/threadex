import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { MAX_INLINE_ATTACHMENT_BYTES, MAX_PATH_ATTACHMENT_BYTES } from "../attachmentLimits";

export type UploadedAttachment = {
  id?: string;
  name?: string;
  type?: string;
  size?: number;
  dataUrl?: string;
  /** A previously saved attachment, used when resending a prompt. */
  path?: string;
};

export type SavedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export function saveUploadedAttachments(
  uploadDir: string,
  turnId: string,
  attachments: UploadedAttachment[] | undefined
): SavedAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const targetDir = resolve(uploadDir, safePathSegment(turnId));
  mkdirSync(targetDir, { recursive: true });

  return attachments.slice(0, 6).map((attachment, index) => {
    const name = safeFileName(attachment.name || `attachment-${index + 1}`);
    const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl : "";
    const parsed = parseDataUrl(dataUrl);
    const existingPath = parsed ? null : resolveExistingUploadedAttachment(uploadDir, attachment.path);
    if (!parsed && !existingPath) {
      throw new Error(`Invalid upload payload for ${name}.`);
    }

    const size = parsed ? parsed.buffer.byteLength : statSync(existingPath!).size;
    const maxBytes = parsed ? MAX_INLINE_ATTACHMENT_BYTES : MAX_PATH_ATTACHMENT_BYTES;
    if (size > maxBytes) {
      throw new Error(`${name} is larger than ${parsed ? "4 MB" : "512 MB"}.`);
    }

    const mimeType = normalizeMimeType(attachment.type || parsed?.mimeType || "application/octet-stream");
    const extension = extname(name) || extensionForMimeType(mimeType);
    const path = resolve(targetDir, `${String(index + 1).padStart(2, "0")}-${stripExtension(name)}${extension}`);
    if (parsed) {
      writeFileSync(path, parsed.buffer);
    } else if (path !== existingPath) {
      copyFileSync(existingPath!, path);
      if (isStagedAttachmentPath(uploadDir, existingPath!)) {
        rmSync(dirname(existingPath!), { recursive: true, force: true });
      }
    }

    return {
      id: typeof attachment.id === "string" ? attachment.id : crypto.randomUUID(),
      name,
      mimeType,
      size,
      path
    };
  });
}

export function safeFileName(value: string) {
  const cleaned = basename(value).replace(/[/\\]/g, "_").replace(/[^\w .@()+-]/g, "_").trim();
  return cleaned.slice(0, 180) || "attachment";
}

export function isPathInsideOrEqual(path: string, root: string) {
  const relativePath = relative(root, path);
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !relativePath.startsWith(sep));
}

function isStagedAttachmentPath(uploadDir: string, path: string) {
  return isPathInsideOrEqual(path, resolve(uploadDir, "staged"));
}

function resolveExistingUploadedAttachment(uploadDir: string, value: unknown) {
  const requestedPath = typeof value === "string" ? value.trim() : "";
  if (!requestedPath) {
    return null;
  }

  const filePath = resolve(requestedPath.startsWith(uploadDir) ? requestedPath : resolve(uploadDir, requestedPath));
  if (!isPathInsideOrEqual(filePath, uploadDir) || !existsSync(filePath)) {
    return null;
  }

  return statSync(filePath).isFile() ? filePath : null;
}

function parseDataUrl(value: string): { mimeType: string; buffer: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) {
    return null;
  }

  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = match[2] === ";base64";
  const payload = match[3] ?? "";
  try {
    return {
      mimeType,
      buffer: isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8")
    };
  } catch {
    return null;
  }
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "attachment";
}

function stripExtension(value: string) {
  const extension = extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function normalizeMimeType(value: string) {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(trimmed) ? trimmed : "application/octet-stream";
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "application/json") return ".json";
  if (mimeType === "text/plain") return ".txt";
  return "";
}
