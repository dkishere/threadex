import { CircleAlert, Download, FileText, Image as ImageIcon, Quote, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MessageAttachment } from "./appTypes";
import { MAX_ATTACHMENT_BYTES, MAX_PATH_ATTACHMENT_BYTES, PASTED_TEXT_COMPACT_LINE_THRESHOLD, PASTED_TEXT_COMPACT_THRESHOLD } from "./appConstants";
import { browserBridgeContextDetail, browserBridgeContextTitle, parseBrowserBridgeContext } from "./browserBridgeContext";
import { parseTurnIssueContext, turnIssueContextDetail, turnIssueContextTitle } from "./turnIssueCopy";

const MonacoTextEditor = lazy(async () => {
  const module = await import("./MonacoDiffEditor");
  return { default: module.MonacoTextEditor };
});

const KNOWN_TEXT_EXTENSIONS = new Set([
  "bash", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "cts", "cxx", "dart", "diff", "fish", "gql",
  "go", "graphql", "h", "hpp", "htm", "html", "hxx", "ini", "ipynb", "java", "js", "json", "jsonc",
  "jsx", "kt", "kts", "less", "log", "lua", "markdown", "md", "mdx", "mjs", "mts", "mysql", "patch",
  "php", "phtml", "pl", "plist", "pm", "properties", "proto", "ps1", "psm1", "py", "pyw", "r", "rake",
  "rb", "rs", "scss", "sh", "sql", "svelte", "svg", "swift", "tf", "tfvars", "toml", "ts", "tsv", "tsx",
  "txt", "vue", "xhtml", "xml", "yaml", "yml", "zsh", "csv"
]);

const KNOWN_TEXT_FILE_NAMES = new Set([
  ".editorconfig", ".gitattributes", ".gitignore", ".npmrc", ".prettierrc", "dockerfile", "gemfile", "makefile",
  "procfile", "rakefile"
]);

export function AttachmentList({
  attachments,
  onRemove
}: {
  attachments: MessageAttachment[];
  onRemove?: (id: string) => void;
}) {
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const [loadedTextPreview, setLoadedTextPreview] = useState<{ attachmentId: string; text: string } | null>(null);
  const [textPreviewError, setTextPreviewError] = useState<{ attachmentId: string; message: string } | null>(null);
  const previewAttachment = attachments.find((attachment) => attachment.id === previewAttachmentId);
  const previewUrl = previewAttachment ? attachmentPreviewUrl(previewAttachment) : null;
  const previewIsText = previewAttachment ? isKnownTextAttachment(previewAttachment) : false;
  const previewText = loadedTextPreview?.attachmentId === previewAttachmentId ? loadedTextPreview.text : null;
  const previewError = textPreviewError?.attachmentId === previewAttachmentId ? textPreviewError.message : null;

  useEffect(() => {
    if (!previewAttachment || !previewIsText) {
      setLoadedTextPreview(null);
      setTextPreviewError(null);
      return;
    }

    const inlineText = readTextAttachment(previewAttachment);
    if (inlineText !== null) {
      setLoadedTextPreview({ attachmentId: previewAttachment.id, text: inlineText });
      setTextPreviewError(null);
      return;
    }

    const sourceUrl = attachmentPreviewUrl(previewAttachment);
    if (!sourceUrl) {
      setLoadedTextPreview(null);
      setTextPreviewError({
        attachmentId: previewAttachment.id,
        message: "Text preview is not available for this attachment."
      });
      return;
    }

    const controller = new AbortController();
    setLoadedTextPreview(null);
    setTextPreviewError(null);
    void fetch(sourceUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Attachment request failed with ${response.status}`);
        }
        return response.text();
      })
      .then((text) => setLoadedTextPreview({ attachmentId: previewAttachment.id, text }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setTextPreviewError({ attachmentId: previewAttachment.id, message: "Could not load the text preview." });
        }
      });

    return () => controller.abort();
  }, [previewAttachment, previewIsText]);

  useEffect(() => {
    if (!previewAttachment) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewAttachmentId(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAttachment]);

  return (
    <div className="attachment-list" aria-label="Attached files">
      <div className="attachment-items">
        {attachments.map((attachment) => {
          const mimeType = attachmentMimeType(attachment);
          const browserContext = browserBridgeContextFromAttachment(attachment);
          const turnIssueContext = turnIssueContextFromAttachment(attachment);
          const previewUrl = attachmentPreviewUrl(attachment);
          const downloadUrl = attachmentDownloadUrl(attachment);
          const isImage = mimeType.startsWith("image/");
          const canPreviewImage = isImage && !!previewUrl;
          const canPreviewText = !isImage && isKnownTextAttachment(attachment) && !!previewUrl;
          const canPreview = canPreviewImage || canPreviewText;
          const extension = getAttachmentExtension(attachment.name);
          const content = browserContext ? (
            <Quote aria-hidden="true" />
          ) : turnIssueContext ? (
            <CircleAlert aria-hidden="true" />
          ) : (
            <>
              {canPreviewImage ? (
                <img src={previewUrl} alt={attachment.name} />
              ) : isImage ? (
                <ImageIcon aria-hidden="true" />
              ) : (
                <FileText aria-hidden="true" />
              )}
              {!canPreviewImage && extension && <small>{extension}</small>}
            </>
          );

          return (
            <span
              className={`attachment-card${browserContext ? " attachment-card-browser-context" : ""}${turnIssueContext ? " attachment-card-turn-issue-context" : ""}${canPreviewImage ? " attachment-card-image" : ""}${canPreview ? " attachment-card-previewable" : ""}`}
              key={attachment.id}
              title={browserContext ? `Browser page context: ${browserContext.url}` : turnIssueContext ? `Threadex issue context: ${turnIssueContext.issue}` : `${attachment.name} (${formatBytes(attachment.size)})`}
            >
              {canPreview ? (
                <button
                  className="attachment-thumb"
                  type="button"
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreviewAttachmentId(attachment.id)}
                >
                  {content}
                </button>
              ) : (
                <span
                  className="attachment-thumb"
                  aria-label={`${attachment.name}, ${formatBytes(attachment.size)}`}
                >
                  {content}
                </span>
              )}
              <span className="attachment-card-body">
                {browserContext ? (
                  <>
                    <span className="attachment-context-label">Browser page context</span>
                    <span className="attachment-card-name">{browserBridgeContextTitle(browserContext)}</span>
                    <span className="attachment-card-meta">{browserBridgeContextDetail(browserContext)}</span>
                  </>
                ) : turnIssueContext ? (
                  <>
                    <span className="attachment-context-label">Threadex issue context</span>
                    <span className="attachment-card-name">{turnIssueContextTitle(turnIssueContext)}</span>
                    <span className="attachment-card-meta">{turnIssueContextDetail(turnIssueContext)}</span>
                  </>
                ) : (
                  <>
                    <span className="attachment-card-name">{attachment.name}</span>
                    <span className="attachment-card-meta">{formatBytes(attachment.size)}</span>
                  </>
                )}
              </span>
              {downloadUrl && (
                <a
                  className="attachment-download"
                  href={downloadUrl}
                  download={attachment.name}
                  title={`Download ${attachment.name}`}
                  aria-label={`Download ${attachment.name}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download aria-hidden="true" />
                </a>
              )}
              {onRemove && (
                <button
                  className="attachment-remove"
                  type="button"
                  onClick={() => onRemove(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {previewAttachment && previewUrl && (previewIsText || attachmentMimeType(previewAttachment).startsWith("image/")) && createPortal(
        <div className="attachment-preview-backdrop" role="presentation" onMouseDown={() => setPreviewAttachmentId(null)}>
          <section
            className={`attachment-preview-modal${previewIsText ? " attachment-preview-modal-text" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${previewAttachment.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="attachment-preview-header">
              <div>
                <strong>{previewAttachment.name}</strong>
                <span>{formatBytes(previewAttachment.size)}</span>
              </div>
              <div className="attachment-preview-actions">
                <a
                  className="attachment-preview-download"
                  href={attachmentDownloadUrl(previewAttachment) ?? previewUrl}
                  download={previewAttachment.name}
                  title={`Download ${previewAttachment.name}`}
                  aria-label={`Download ${previewAttachment.name}`}
                >
                  <Download aria-hidden="true" />
                </a>
                <button type="button" onClick={() => setPreviewAttachmentId(null)} aria-label={`Close preview for ${previewAttachment.name}`}>
                  <X aria-hidden="true" />
                </button>
              </div>
            </header>
            {previewIsText ? (
              <div className="attachment-preview-text-wrap">
                {previewError ? (
                  <div className="attachment-preview-state" role="alert">{previewError}</div>
                ) : previewText === null ? (
                  <div className="attachment-preview-state">Loading text preview…</div>
                ) : (
                  <Suspense fallback={<div className="attachment-preview-state">Loading editor…</div>}>
                    <MonacoTextEditor value={previewText} filePath={previewAttachment.name} />
                  </Suspense>
                )}
              </div>
            ) : (
              <div className="attachment-preview-image-wrap">
                <img src={previewUrl} alt={previewAttachment.name} />
              </div>
            )}
          </section>
        </div>,
        document.body
      )}
    </div>
  );
}

export function isKnownTextAttachment(attachment: MessageAttachment) {
  const mimeType = attachmentMimeType(attachment).toLowerCase().split(";", 1)[0];
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/graphql"
  ) {
    return true;
  }

  const fileName = attachment.name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (KNOWN_TEXT_FILE_NAMES.has(fileName) || fileName.startsWith(".env")) {
    return true;
  }
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return KNOWN_TEXT_EXTENSIONS.has(extension);
}

export function readAttachment(file: File): Promise<MessageAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return uploadAttachmentByPath(file);
  }

  return new Promise((resolveAttachment, rejectAttachment) => {
    const reader = new FileReader();
    reader.onerror = () => rejectAttachment(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        rejectAttachment(new Error(`Could not read ${file.name}`));
        return;
      }

      resolveAttachment({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        dataUrl
      });
    };
    reader.readAsDataURL(file);
  });
}

async function uploadAttachmentByPath(file: File): Promise<MessageAttachment> {
  if (file.size > MAX_PATH_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than ${formatBytes(MAX_PATH_ATTACHMENT_BYTES)}`);
  }

  const response = await fetch("/api/attachments/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Attachment-Name": encodeURIComponent(file.name),
      "X-Attachment-Mime-Type": file.type || "application/octet-stream",
      "X-Attachment-Size": String(file.size)
    },
    body: file
  });
  const payload = await response.json().catch(() => null) as { error?: unknown; attachment?: Partial<MessageAttachment> } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `Could not upload ${file.name}`);
  }

  const attachment = payload?.attachment;
  if (
    !attachment ||
    typeof attachment.id !== "string" ||
    typeof attachment.name !== "string" ||
    typeof attachment.type !== "string" ||
    typeof attachment.size !== "number" ||
    typeof attachment.path !== "string"
  ) {
    throw new Error(`Could not upload ${file.name}`);
  }

  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    path: attachment.path
  };
}

export function shouldCompactPastedText(value: string) {
  if (value.length >= PASTED_TEXT_COMPACT_THRESHOLD) {
    return true;
  }

  return value.length >= 500 && value.split(/\r?\n/).length >= PASTED_TEXT_COMPACT_LINE_THRESHOLD;
}

export function nextPastedTextFileName(attachments: MessageAttachment[]) {
  const existingNames = new Set(attachments.map((attachment) => attachment.name.toLowerCase()));
  let index = 1;
  let name = "Pasted text.txt";
  while (existingNames.has(name.toLowerCase())) {
    index += 1;
    name = `Pasted text ${index}.txt`;
  }
  return name;
}

export function browserBridgeContextFromAttachment(attachment: MessageAttachment) {
  return parseBrowserBridgeContext(readTextAttachment(attachment) ?? "");
}

export function turnIssueContextFromAttachment(attachment: MessageAttachment) {
  return parseTurnIssueContext(readTextAttachment(attachment) ?? "");
}

export function readTextAttachment(attachment: MessageAttachment) {
  if (!attachment.dataUrl?.startsWith("data:")) {
    return null;
  }

  try {
    const commaIndex = attachment.dataUrl.indexOf(",");
    if (commaIndex < 0) {
      return null;
    }

    const metadata = attachment.dataUrl.slice(0, commaIndex);
    const encoded = attachment.dataUrl.slice(commaIndex + 1);
    if (!metadata.endsWith(";base64")) {
      return decodeURIComponent(encoded);
    }

    const binary = window.atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function getAttachmentExtension(name: string) {
  const extension = name.split(".").at(-1)?.trim();
  if (!extension || extension === name || extension.length > 5) {
    return "FILE";
  }
  return extension.toUpperCase();
}

export function attachmentMimeType(attachment: MessageAttachment) {
  return attachment.type || attachment.mimeType || "application/octet-stream";
}

export function attachmentPreviewUrl(attachment: MessageAttachment) {
  if (attachment.dataUrl?.startsWith("data:")) {
    return attachment.dataUrl;
  }
  return attachment.fileUrl ?? storedAttachmentUrl(attachment);
}

export function attachmentDownloadUrl(attachment: MessageAttachment) {
  return attachment.fileUrl ?? attachment.dataUrl ?? storedAttachmentUrl(attachment);
}

export function normalizeStoredUserInput(value: string, turnId: string) {
  const attachments = parseStoredUserInputAttachments(value, turnId);
  return {
    content: stripStoredAttachmentSummary(value),
    attachments
  };
}

export function stripStoredAttachmentSummary(value: string) {
  const section = findStoredAttachmentSection(value);
  return section ? value.slice(0, section.start).trimEnd() : value.trimEnd();
}

export function parseStoredUserInputAttachments(value: string, turnId: string): MessageAttachment[] {
  const section = findStoredAttachmentSection(value);
  if (!section) {
    return [];
  }

  return section.lines
    .split("\n")
    .map((line, index) => parseStoredAttachmentLine(line, turnId, index))
    .filter((attachment): attachment is MessageAttachment => attachment !== null);
}

function findStoredAttachmentSection(value: string) {
  const markers = [...value.matchAll(/\n\n(?:\[Attached files\]|Attached files:)\n/gu)];
  for (let markerIndex = markers.length - 1; markerIndex >= 0; markerIndex -= 1) {
    const marker = markers[markerIndex];
    const start = marker.index;
    if (start === undefined) {
      continue;
    }

    const lines: string[] = [];
    for (const line of value.slice(start + marker[0].length).split(/\r?\n/u)) {
      if (line.trim() === "") {
        continue;
      }
      if (!line.trimStart().startsWith("- ")) {
        break;
      }
      lines.push(line);
    }

    if (lines.length > 0) {
      return { start, lines: lines.join("\n") };
    }
  }
  return null;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let size = value;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function parseStoredAttachmentLine(line: string, turnId: string, index: number): MessageAttachment | null {
  // Local Codex transcripts may append an image input tag to the manifest line.
  // It is metadata for the runner, not user-visible prompt content.
  const manifestLine = line.split(/\s*<image\b/i, 1)[0].trimEnd();
  const match = /^- (.+) \(([^,\s]+\/[^,\s]+), (\d+) bytes(?:, (.+))?\)$/u.exec(manifestLine);
  if (!match) {
    return null;
  }

  const [, name, type, rawSize, rawPath] = match;
  const size = Number.parseInt(rawSize, 10);
  if (!name || !Number.isFinite(size)) {
    return null;
  }

  const path = rawPath?.trim() || storedAttachmentPath(turnId, name, type, index);
  return {
    id: `${turnId}:attachment:${index}`,
    name,
    type,
    size,
    path,
    fileUrl: storedAttachmentUrl({ path })
  };
}

function storedAttachmentUrl(attachment: Pick<MessageAttachment, "path">) {
  if (!attachment.path) {
    return undefined;
  }
  return `/api/attachments/file?path=${encodeURIComponent(attachment.path)}`;
}

function storedAttachmentPath(turnId: string, name: string, mimeType: string, index: number) {
  const safeName = safeStoredFileName(name);
  const extension = storedFileExtension(safeName) || extensionForMimeType(mimeType);
  return `${turnId}/${String(index + 1).padStart(2, "0")}-${stripAttachmentExtension(safeName)}${extension}`;
}

function stripAttachmentExtension(value: string) {
  const extension = value.split(".").at(-1);
  return extension && extension !== value ? value.slice(0, -(extension.length + 1)) : value;
}

function safeStoredFileName(value: string) {
  return value.replace(/[/\\]/g, "_").replace(/[^\w .@()+-]/g, "_").trim().slice(0, 180) || "attachment";
}

function storedFileExtension(value: string) {
  const dotIndex = value.lastIndexOf(".");
  return dotIndex > 0 ? value.slice(dotIndex) : "";
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "text/plain") return ".txt";
  if (mimeType === "text/markdown") return ".md";
  if (mimeType === "application/json") return ".json";
  return "";
}
