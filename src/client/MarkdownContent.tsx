import {
  createContext,
  useContext,
  isValidElement,
  Fragment,
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, ExternalLink, FileText, X } from "lucide-react";
import { isHtmlFilePath, workspaceHtmlPreviewUrl } from "./markdownUrls";
import { UrlTagIcon } from "./UrlTagIcon";
import { isJsonFilePath, isMarkdownFilePath, threadexNavigationUrl, transformMarkdownUrl, workspaceFileDownloadUrl, workspaceFilePreviewUrl, workspaceFileReferenceFromUrl, workspaceImagePreviewName, type WorkspaceFilePreviewContext } from "./markdownUrls";
import { advanceMarkdownChunks, type MarkdownChunks } from "./markdownChunks";

const MonacoTextEditor = lazy(async () => {
  const module = await import("./MonacoDiffEditor");
  return { default: module.MonacoTextEditor };
});

export const MarkdownWorkspaceContext = createContext<WorkspaceFilePreviewContext | null>(null);

// Stable component types preserve open previews and code blocks while the
// surrounding Markdown receives new streamed text.
const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  code: ({ className, children, node: _node, ...props }) => {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (language === "mermaid") return <MermaidBlock source={String(children).replace(/\n$/, "")} />;
    return <code className={className} {...props}>{children}</code>;
  },
  pre: ({ children }) => findMermaidChild(children) ?? <pre className="markdown-code-block">{children}</pre>,
  img: ({ node: _node, ...props }) => <MarkdownImage {...props} />
};
const markdownPlugins = [remarkGfm];

export const MarkdownContent = memo(function MarkdownContent({ children, className, id }: { children: string; className?: string; id?: string }) {
  const previous = useRef<MarkdownChunks | null>(null);
  const chunks = advanceMarkdownChunks(previous.current, children);
  previous.current = chunks;
  const workspaceFileContext = useContext(MarkdownWorkspaceContext) ?? workspaceFilePreviewContextFromPage();
  return (
    <div className={className ? `markdown-content ${className}` : "markdown-content"} id={id}>
      {[...chunks.frozen, chunks.tail].map((source, index) => <Fragment key={index}>{index > 0 ? "\n" : null}<MarkdownPart source={source} context={workspaceFileContext} /></Fragment>)}
    </div>
  );
});

const MarkdownPart = memo(function MarkdownPart({ source, context }: { source: string; context: WorkspaceFilePreviewContext }) {
  return <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents} urlTransform={(url) => transformMarkdownUrl(url, context)}>{source}</ReactMarkdown>;
});

function MarkdownImage({ alt, src, ...props }: ComponentPropsWithoutRef<"img">) {
  const [open, setOpen] = useState(false);
  const name = alt || "Image";
  return <>
    <img {...props} src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer"
      role={src ? "button" : undefined} tabIndex={src ? 0 : undefined}
      aria-label={src ? `Enlarge ${name}` : undefined}
      style={{ cursor: src ? "zoom-in" : undefined }}
      onClick={(event) => {
        if (!src) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }}
      onKeyDown={(event) => {
        if (!src || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }} />
    {open && src && <WorkspaceImagePopup name={name} src={src} onClose={() => setOpen(false)} />}
  </>;
}

function MarkdownLink({ href, children, onClick, ...props }: ComponentPropsWithoutRef<"a">) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
  const [isWorkspaceFileOpen, setIsWorkspaceFileOpen] = useState(false);
  const previewName = href ? workspaceImagePreviewName(href) : null;
  const workspaceFile = href ? workspaceFileReferenceFromUrl(href) : null;
  const sessionNavigationUrl = href ? threadexNavigationUrl(href) : null;
  const workspaceFileContext = useContext(MarkdownWorkspaceContext) ?? workspaceFilePreviewContextFromPage();

  if (href && previewName) {
    return (
      <>
        <a
          className="markdown-image-preview"
          href={href}
          {...props}
          onClick={(event) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            setIsImagePreviewOpen(true);
          }}
        >
          {!previewFailed && <img
            alt={previewName}
            decoding="async"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={href}
            onError={() => setPreviewFailed(true)}
          />}
          <span>{children}</span>
        </a>
        {isImagePreviewOpen && (
          <WorkspaceImagePopup
            name={previewName}
            src={href}
            onClose={() => setIsImagePreviewOpen(false)}
          />
        )}
      </>
    );
  }

  if (sessionNavigationUrl) {
    return (
      <a href={sessionNavigationUrl} {...props}>
        <UrlTagIcon url={href} />
        {children}
      </a>
    );
  }

  if (workspaceFile && href && !previewName) {
    return (
      <>
        <a
          href={href}
          data-workspace-file-link="true"
          {...props}
          onClick={(event) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            setIsWorkspaceFileOpen(true);
          }}
        >
          <UrlTagIcon url={href} />
          {children}
        </a>
        {isHtmlFilePath(workspaceFile.path) && (
          <HtmlPreviewLink path={workspaceFile.path} context={workspaceFileContext} />
        )}
        {isWorkspaceFileOpen && (
          <WorkspaceFilePopup
            line={workspaceFile.line}
            path={workspaceFile.path}
            context={workspaceFileContext}
            onClose={() => setIsWorkspaceFileOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      <UrlTagIcon url={href} />
      {children}
    </a>
  );
}

function HtmlPreviewLink({ path, context }: { path: string; context: WorkspaceFilePreviewContext }) {
  const [error, setError] = useState<string | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const entryUrl = workspaceHtmlPreviewUrl(path, context);
  return <>
    <a href={readyUrl ?? entryUrl} target="_blank" rel="noopener noreferrer" className="icon-button" aria-label="Open HTML preview in new tab" title="Open HTML preview in new tab" aria-busy={loading}
      onClick={async (event) => {
        event.preventDefault();
        if (loading) return;
        // Authenticate in the app before handing off to a PWA's external window.
        const popup = window.open("about:blank", "_blank");
        if (popup) popup.opener = null;
        setLoading(true);
        setError(null);
        try {
          const response = await fetch(`${entryUrl}?format=json`, { credentials: "same-origin" });
          const payload = await response.json() as { url?: string; error?: string };
          if (!response.ok || !payload.url?.startsWith("/api/workspaces/html-content/")) {
            throw new Error(payload.error || "Could not open HTML preview.");
          }
          if (popup && !popup.closed) popup.location.replace(payload.url);
          else setReadyUrl(payload.url);
        } catch (cause) {
          popup?.close();
          setError(cause instanceof Error ? cause.message : "Could not open HTML preview.");
        } finally {
          setLoading(false);
        }
      }}>
      <ExternalLink size={14} aria-hidden="true" />
    </a>
    {readyUrl && <a href={readyUrl} target="_blank" rel="noopener noreferrer">Open prepared preview</a>}
    {error && <span role="alert">{error}</span>}
  </>;
}

function WorkspaceImagePopup({ name, src, onClose }: { name: string; src: string; onClose: () => void }) {
  const [originalSize, setOriginalSize] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className="attachment-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="attachment-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="attachment-preview-header">
          <div>
            <strong>{name}</strong>
            <span>Image preview</span>
          </div>
          <div className="attachment-preview-actions">
            <a
              className="attachment-preview-download"
              href={workspaceFileDownloadUrl(src)}
              download={name}
              title={`Download ${name}`}
              aria-label={`Download ${name}`}
            >
              <Download aria-hidden="true" />
            </a>
            <button type="button" onClick={onClose} aria-label={`Close preview for ${name}`}>
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="attachment-preview-image-wrap" style={originalSize ? { placeItems: "start" } : undefined}>
          <img src={src} alt={name} role="button" tabIndex={0}
            aria-label={originalSize ? "Fit image to window" : "View image at original size"}
            aria-pressed={originalSize}
            style={{ cursor: originalSize ? "zoom-out" : "zoom-in", ...(originalSize ? { maxWidth: "none", maxHeight: "none", flexShrink: 0 } : {}) }}
            onClick={() => setOriginalSize((value) => !value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setOriginalSize((value) => !value);
            }} />
        </div>
      </section>
    </div>,
    document.body
  );
}

function WorkspaceFilePopup({ path, line, context, onClose }: { path: string; line?: number; context: WorkspaceFilePreviewContext; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  const isMarkdownFile = isMarkdownFilePath(path);
  const isJsonFile = isJsonFilePath(path);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);
    void fetch(workspaceFilePreviewUrl(path, context), { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { exists?: boolean; text?: string; error?: string } | null;
        if (!response.ok) throw new Error(payload?.error || "Could not load this file.");
        if (!payload?.exists) throw new Error("File not found.");
        return payload.text ?? "";
      })
      .then((text) => {
        if (!controller.signal.aborted) setContent(text);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Could not load this file.");
      });
    return () => controller.abort();
  }, [context.sessionId, context.workspaceId, path]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const downloadFile = () => {
    if (content === null) return;

    const objectUrl = URL.createObjectURL(new Blob([content], { type: workspaceFileMimeType(path) }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  return createPortal(
    <div className="file-diff-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="file-diff-popup workspace-file-popup" role="dialog" aria-modal="true" aria-label={`File preview for ${fileName}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="file-diff-header">
          <div className="file-diff-title">
            <FileText aria-hidden="true" />
            <div>
              <strong>{fileName}</strong>
              <code title={path}>{path}{line ? `:${line}` : ""}</code>
            </div>
          </div>
          <div className="workspace-file-actions">
            {isHtmlFilePath(path) && (
              <HtmlPreviewLink path={path} context={context} />
            )}
            <button className="icon-button" type="button" onClick={downloadFile} disabled={content === null} aria-label={`Download ${fileName}`} title={`Download ${fileName}`}>
              <Download aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close file preview">
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className={isMarkdownFile ? "workspace-file-content workspace-markdown-file-content" : isJsonFile ? "workspace-file-content workspace-json-file-content" : "workspace-file-content"}>
          {error ? <p className="workspace-file-state">{error}</p> : content === null ? <p className="workspace-file-state">Loading file…</p> : (
            isMarkdownFile ? <MarkdownContent className="workspace-file-markdown" children={content} /> : isJsonFile ? <JsonFileViewer content={content} /> : (
              <Suspense fallback={<p className="workspace-file-state">Loading editor…</p>}>
                <MonacoTextEditor value={content} filePath={path} line={line} />
              </Suspense>
            )
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}

function workspaceFileMimeType(path: string) {
  if (isJsonFilePath(path)) return "application/json;charset=utf-8";
  if (isMarkdownFilePath(path)) return "text/markdown;charset=utf-8";
  return "text/plain;charset=utf-8";
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function JsonFileViewer({ content }: { content: string }) {
  try {
    return <div className="workspace-file-json" aria-label="JSON file preview"><JsonTreeNode value={JSON.parse(content) as JsonValue} depth={0} /></div>;
  } catch {
    return (
      <div className="workspace-file-json workspace-file-json-invalid" role="note">
        <p>This file is not valid JSON.</p>
        <pre>{content}</pre>
      </div>
    );
  }
}

function JsonTreeNode({ value, name, depth }: { value: JsonValue; name?: string; depth: number }) {
  const expandable = typeof value === "object" && value !== null;
  const [expanded, setExpanded] = useState(depth === 0);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : expandable ? Object.entries(value) : [];
  const opening = Array.isArray(value) ? "[" : "{";
  const closing = Array.isArray(value) ? "]" : "}";
  const summary = Array.isArray(value) ? `${entries.length} items` : `${entries.length} keys`;

  if (!expandable) {
    return (
      <div className="workspace-json-row workspace-json-value" data-json-depth={depth}>
        {name !== undefined && <span className="workspace-json-key">{JSON.stringify(name)}: </span>}
        <span className={`workspace-json-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span>
      </div>
    );
  }

  return (
    <div className="workspace-json-node" data-json-depth={depth}>
      <button
        className="workspace-json-row workspace-json-toggle"
        type="button"
        data-json-depth={depth}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${name ?? "root"}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span aria-hidden="true" className="workspace-json-caret">{expanded ? "▾" : "▸"}</span>
        {name !== undefined && <span className="workspace-json-key">{JSON.stringify(name)}: </span>}
        <span>{opening}</span>
        {!expanded && <span className="workspace-json-summary">… {summary}</span>}
      </button>
      {expanded && (
        <>
          <div className="workspace-json-children">
            {entries.map(([entryName, entryValue]) => <JsonTreeNode key={entryName} value={entryValue} name={entryName} depth={depth + 1} />)}
          </div>
          <div className="workspace-json-row workspace-json-closing">{closing}</div>
        </>
      )}
    </div>
  );
}

function workspaceFilePreviewContextFromPage(): WorkspaceFilePreviewContext {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId")?.trim();
  const workspaceId = params.get("workspaceId")?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workspaceId ? { workspaceId } : {})
  };
}

function findMermaidChild(children: ReactNode): ReactNode | null {
  const candidates = Array.isArray(children) ? children : [children];
  const child = candidates.find((candidate) => isValidElement(candidate));
  if (!child) return null;
  if (child.type === MermaidBlock) return child;

  const childProps = child.props as { className?: string; children?: ReactNode };
  if (!childProps.className?.split(/\s+/).includes("language-mermaid")) return null;
  return <MermaidBlock source={String(childProps.children ?? "").replace(/\n$/, "")} />;
}

const MermaidBlock = memo(function MermaidBlock({ source }: { source: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const diagramId = `mermaid-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    let cancelled = false;
    setError(null);

    const renderDiagram = async () => {
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          primaryColor: "#dbeafe",
          primaryTextColor: "#172554",
          primaryBorderColor: "#60a5fa",
          lineColor: "#64748b"
        }
      });

      const { svg, bindFunctions } = await mermaid.render(diagramId, source);
      if (cancelled || !containerRef.current) return;
      containerRef.current.innerHTML = svg;
      bindFunctions?.(containerRef.current);
    };

    void renderDiagram().catch((renderError: unknown) => {
      if (cancelled) return;
      setError(renderError instanceof Error ? renderError.message : "Invalid Mermaid diagram.");
    });

    return () => {
      cancelled = true;
    };
  }, [diagramId, source]);

  if (error) {
    return (
      <div className="markdown-mermaid-error" role="note">
        <div>Unable to render this Mermaid diagram.</div>
        <pre>{source}</pre>
      </div>
    );
  }

  return <div aria-label="Mermaid diagram" className="markdown-mermaid" ref={containerRef} role="img" />;
});
