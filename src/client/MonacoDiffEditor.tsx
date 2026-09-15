import { useEffect, useRef, useState, type MutableRefObject } from "react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import type * as Monaco from "monaco-editor";
import type { ResponseAnnotation, ResponseAnnotationFileSource } from "./responseAnnotations";

type MonacoDiffEditorProps = {
  before: string;
  after: string;
  filePath: string;
  activeAnnotation?: ResponseAnnotation | null;
  workspaceId?: string;
  sessionUrl?: string;
  onAsk?: (annotation: ResponseAnnotation) => void;
  onRemoveAnnotation?: () => void;
};

type MonacoTextEditorProps = {
  value: string;
  filePath: string;
  line?: number;
};

type DiffSide = "original" | "modified";
type MonacoApi = typeof import("monaco-editor/esm/vs/editor/editor.api.js");
type MonacoAnnotationZone = {
  editor: Monaco.editor.IStandaloneCodeEditor;
  id: string;
  domNode: HTMLElement;
  overlayWidget: Monaco.editor.IOverlayWidget;
  sourcePath?: string;
};

type MonacoEditorState = {
  monaco: MonacoApi;
  diffEditor: Monaco.editor.IStandaloneDiffEditor;
  editors: Record<DiffSide, Monaco.editor.IStandaloneCodeEditor>;
  selectionWidget?: { editor: Monaco.editor.IStandaloneCodeEditor; widget: Monaco.editor.IContentWidget };
  annotationZone?: MonacoAnnotationZone;
  draftAnnotationZone?: MonacoAnnotationZone;
  annotationDecorations: Partial<Record<DiffSide, string[]>>;
};

type MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

const monacoGlobal = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment };

monacoGlobal.MonacoEnvironment = {
  getWorker: (_moduleId, label) => (label === "json" ? new JsonWorker() : new EditorWorker())
};

const languageLoads = new Map<string, Promise<unknown>>();

export function MonacoDiffEditor({
  before,
  after,
  filePath,
  activeAnnotation,
  workspaceId,
  sessionUrl,
  onAsk,
  onRemoveAnnotation
}: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorStateRef = useRef<MonacoEditorState | null>(null);
  const latestPropsRef = useRef({ activeAnnotation, workspaceId, sessionUrl, onAsk, onRemoveAnnotation });
  const [loadError, setLoadError] = useState(false);
  const [ready, setReady] = useState(false);
  const language = languageForPath(filePath);
  latestPropsRef.current = { activeAnnotation, workspaceId, sessionUrl, onAsk, onRemoveAnnotation };

  useEffect(() => {
    const state = editorStateRef.current;
    if (state) {
      syncAnnotationWidget(state, filePath, activeAnnotation, latestPropsRef.current.onRemoveAnnotation, latestPropsRef);
    }
  }, [activeAnnotation, filePath]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let diffEditor: Monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: Monaco.editor.ITextModel | undefined;
    let modifiedModel: Monaco.editor.ITextModel | undefined;

    setLoadError(false);
    setReady(false);
    void Promise.all([import("monaco-editor/esm/vs/editor/editor.api.js"), loadLanguage(language)])
      .then(([monaco]) => {
        if (disposed) {
          return;
        }

        const modelId = crypto.randomUUID();
        const original = monaco.editor.createModel(
          before,
          language,
          monaco.Uri.from({ scheme: "file-compare", path: `/${modelId}/before/${filePath}` })
        );
        const modified = monaco.editor.createModel(
          after,
          language,
          monaco.Uri.from({ scheme: "file-compare", path: `/${modelId}/after/${filePath}` })
        );
        const editor = monaco.editor.createDiffEditor(container, {
          automaticLayout: true,
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: true,
          enableSplitViewResizing: true,
          ignoreTrimWhitespace: false,
          diffAlgorithm: "advanced",
          renderOverviewRuler: false,
          renderMarginRevertIcon: false,
          minimap: { enabled: false },
          folding: false,
          glyphMargin: false,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          fontSize: 12,
          lineHeight: 20,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          wordWrap: "off",
          diffWordWrap: "off",
          renderWhitespace: "selection",
          originalAriaLabel: `Before ${filePath}`,
          modifiedAriaLabel: `After ${filePath}`
        });
        editor.setModel({ original, modified });
        originalModel = original;
        modifiedModel = modified;
        diffEditor = editor;
        const editorState: MonacoEditorState = {
          monaco,
          diffEditor: editor,
          editors: {
            original: editor.getOriginalEditor(),
            modified: editor.getModifiedEditor()
          },
          annotationDecorations: {}
        };
        editorStateRef.current = editorState;

        const selectionDisposables = (Object.entries(editorState.editors) as Array<[
          DiffSide,
          Monaco.editor.IStandaloneCodeEditor
        ]>).map(([side, codeEditor]) => codeEditor.onDidChangeCursorSelection(({ selection }) => {
          showSelectionWidget(editorState, codeEditor, side, filePath, selection, latestPropsRef);
        }));
        const scrollDisposables = Object.values(editorState.editors).map((codeEditor) =>
          codeEditor.onDidScrollChange(() => {
            if (editorState.selectionWidget) {
              editorState.selectionWidget.editor.layoutContentWidget(editorState.selectionWidget.widget);
            }
            layoutAnnotationZones(editorState, codeEditor);
          })
        );
        const layoutDisposables = Object.values(editorState.editors).map((codeEditor) =>
          codeEditor.onDidLayoutChange(() => layoutAnnotationZones(editorState, codeEditor))
        );
        syncAnnotationWidget(
          editorState,
          filePath,
          latestPropsRef.current.activeAnnotation,
          latestPropsRef.current.onRemoveAnnotation,
          latestPropsRef
        );
        setReady(true);

        editor.onDidDispose(() => {
          selectionDisposables.forEach((disposable) => disposable.dispose());
          scrollDisposables.forEach((disposable) => disposable.dispose());
          layoutDisposables.forEach((disposable) => disposable.dispose());
        });
      })
      .catch(() => {
        if (!disposed) {
          setLoadError(true);
        }
      });

    return () => {
      disposed = true;
      const editorState = editorStateRef.current;
      if (editorState && editorState.diffEditor === diffEditor) {
        clearSelectionWidget(editorState);
        clearDraftAnnotationZone(editorState);
        clearAnnotationWidget(editorState);
        editorStateRef.current = null;
      }
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [after, before, filePath, language]);

  if (loadError) {
    return <div className="file-diff-state">Monaco Editor could not be loaded.</div>;
  }

  return (
    <div className="file-diff-editor-shell">
      {!ready && <div className="file-diff-loading">Loading editor…</div>}
      <div className="file-diff-editor" ref={containerRef} />
    </div>
  );
}

export function MonacoTextEditor({ value, filePath, line }: MonacoTextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState(false);
  const [ready, setReady] = useState(false);
  const language = languageForPath(filePath);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
    let model: Monaco.editor.ITextModel | undefined;

    setLoadError(false);
    setReady(false);
    void Promise.all([import("monaco-editor/esm/vs/editor/editor.api.js"), loadLanguage(language)])
      .then(([monaco]) => {
        if (disposed) {
          return;
        }

        const modelId = crypto.randomUUID();
        model = monaco.editor.createModel(
          value,
          language,
          monaco.Uri.from({ scheme: "attachment-preview", path: `/${modelId}/${filePath}` })
        );
        editor = monaco.editor.create(container, {
          model,
          automaticLayout: true,
          readOnly: true,
          domReadOnly: true,
          ariaLabel: `Text preview for ${filePath}`,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          minimap: { enabled: false },
          glyphMargin: false,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          fontSize: 12,
          lineHeight: 20,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
          wordWrap: "off",
          renderWhitespace: "selection",
          stickyScroll: { enabled: false },
          padding: { top: 8, bottom: 8 }
        });
        if (line) {
          const lineNumber = Math.min(Math.max(1, line), model.getLineCount());
          editor.setPosition({ lineNumber, column: 1 });
          editor.revealLineInCenterIfOutsideViewport(lineNumber);
        }
        setReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setLoadError(true);
        }
      });

    return () => {
      disposed = true;
      editor?.dispose();
      model?.dispose();
    };
  }, [filePath, language, line, value]);

  if (loadError) {
    return <div className="file-diff-state">Monaco Editor could not be loaded.</div>;
  }

  return (
    <div className="attachment-monaco-editor-shell">
      {!ready && <div className="file-diff-loading">Loading editor…</div>}
      <div className="attachment-monaco-editor" ref={containerRef} />
    </div>
  );
}

function showSelectionWidget(
  state: MonacoEditorState,
  editor: Monaco.editor.IStandaloneCodeEditor,
  side: DiffSide,
  filePath: string,
  selection: Monaco.Selection,
  latestPropsRef: MutableRefObject<{
    activeAnnotation?: ResponseAnnotation | null;
    workspaceId?: string;
    sessionUrl?: string;
    onAsk?: (annotation: ResponseAnnotation) => void;
    onRemoveAnnotation?: () => void;
  }>
) {
  clearSelectionWidget(state);
  if (selection.isEmpty()) return;

  const model = editor.getModel();
  const text = model?.getValueInRange(selection).trim().slice(0, 4_000) ?? "";
  if (!text) return;

  const source: ResponseAnnotationFileSource = {
    type: "file",
    path: filePath,
    selection: {
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn
    },
    side,
    ...(latestPropsRef.current.workspaceId ? { workspaceId: latestPropsRef.current.workspaceId } : {}),
    ...(latestPropsRef.current.sessionUrl ? { sessionUrl: latestPropsRef.current.sessionUrl } : {})
  };
  const annotation: ResponseAnnotation = { text, source };
  const domNode = document.createElement("div");
  domNode.className = "monaco-file-quote-popover";
  domNode.setAttribute("role", "dialog");
  domNode.setAttribute("aria-label", "Annotate selected file text");

  const icon = document.createElement("span");
  icon.className = "monaco-file-quote-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "“";
  const preview = document.createElement("span");
  preview.className = "monaco-file-quote-preview";
  preview.textContent = text;
  const askButton = document.createElement("button");
  askButton.type = "button";
  askButton.textContent = "Annotate";
  askButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearSelectionWidget(state);
    showDraftAnnotationZone(state, editor, annotation, latestPropsRef);
  });
  domNode.append(icon, preview, askButton);

  const widget: Monaco.editor.IContentWidget = {
    getId: () => `file-quote-selection-${side}`,
    getDomNode: () => domNode,
    getPosition: () => ({
      position: { lineNumber: selection.endLineNumber, column: selection.endColumn },
      preference: [
        state.monaco.editor.ContentWidgetPositionPreference.ABOVE,
        state.monaco.editor.ContentWidgetPositionPreference.BELOW
      ]
    })
  };
  state.selectionWidget = { editor, widget };
  editor.addContentWidget(widget);
}

function showDraftAnnotationZone(
  state: MonacoEditorState,
  editor: Monaco.editor.IStandaloneCodeEditor,
  annotation: ResponseAnnotation,
  latestPropsRef: MutableRefObject<{
    activeAnnotation?: ResponseAnnotation | null;
    workspaceId?: string;
    sessionUrl?: string;
    onAsk?: (annotation: ResponseAnnotation) => void;
    onRemoveAnnotation?: () => void;
  }>
) {
  const source = annotation.source;
  if (source?.type !== "file") return;
  clearAnnotationWidget(state);
  clearDraftAnnotationZone(state);

  const domNode = document.createElement("div");
  domNode.className = "monaco-file-annotation-draft-zone";
  domNode.setAttribute("role", "group");
  domNode.setAttribute("aria-label", "Add an inline file annotation");

  const card = document.createElement("div");
  card.className = "monaco-file-annotation-draft-card";
  const header = document.createElement("div");
  header.className = "monaco-file-annotation-draft-header";
  const lineLabel = source.selection.startLine === source.selection.endLine
    ? `line ${source.selection.startLine}`
    : `lines ${source.selection.startLine}–${source.selection.endLine}`;
  header.textContent = `${annotation.annotation ? "Edit" : "Add"} an annotation on ${lineLabel}`;
  const textarea = document.createElement("textarea");
  textarea.className = "monaco-file-annotation-draft-input";
  textarea.placeholder = "Add an annotation";
  textarea.rows = 4;
  textarea.value = annotation.annotation ?? "";
  textarea.setAttribute("aria-label", `Annotation on ${lineLabel}`);
  const actions = document.createElement("div");
  actions.className = "monaco-file-annotation-draft-actions";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "primary";
  addButton.textContent = annotation.annotation ? "Save annotation" : "Add annotation";
  addButton.disabled = !textarea.value.trim();

  const closeAndRestoreSavedAnnotation = () => {
    clearDraftAnnotationZone(state);
    const activeAnnotation = latestPropsRef.current.activeAnnotation;
    if (activeAnnotation?.source?.type === "file" && activeAnnotation.source.path === source.path) {
      syncAnnotationWidget(
        state,
        activeAnnotation.source.path,
        activeAnnotation,
        latestPropsRef.current.onRemoveAnnotation,
        latestPropsRef
      );
    }
    editor.focus();
  };

  const stopEditorPointer = (event: Event) => event.stopPropagation();
  card.addEventListener("pointerdown", stopEditorPointer);
  card.addEventListener("mousedown", stopEditorPointer);
  card.addEventListener("click", stopEditorPointer);
  textarea.addEventListener("input", () => {
    addButton.disabled = !textarea.value.trim();
  });
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && textarea.value.trim()) {
      event.preventDefault();
      addButton.click();
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAndRestoreSavedAnnotation();
    }
  });
  cancelButton.addEventListener("click", closeAndRestoreSavedAnnotation);
  addButton.addEventListener("click", () => {
    const annotationText = textarea.value.trim();
    if (!annotationText) return;
    clearDraftAnnotationZone(state);
    latestPropsRef.current.onAsk?.({ ...annotation, annotation: annotationText });
  });
  actions.append(cancelButton, addButton);
  card.append(header, textarea, actions);
  domNode.append(card);

  state.draftAnnotationZone = addInteractiveAnnotationZone(
    editor,
    source.selection.endLine,
    190,
    domNode,
    source.path
  );
  layoutAnnotationZones(state, editor);
  window.requestAnimationFrame(() => textarea.focus());
}

function syncAnnotationWidget(
  state: MonacoEditorState,
  filePath: string,
  annotation: ResponseAnnotation | null | undefined,
  onRemoveAnnotation?: () => void,
  latestPropsRef?: MutableRefObject<{
    activeAnnotation?: ResponseAnnotation | null;
    workspaceId?: string;
    sessionUrl?: string;
    onAsk?: (annotation: ResponseAnnotation) => void;
    onRemoveAnnotation?: () => void;
  }>
) {
  if (annotation && state.draftAnnotationZone?.sourcePath === filePath) {
    return;
  }
  clearAnnotationWidget(state);
  clearDraftAnnotationZone(state);
  const source = annotation?.source;
  if (!annotation || source?.type !== "file" || source.path !== filePath) return;

  const side = source.side ?? "modified";
  const editor = state.editors[side];
  const model = editor.getModel();
  if (!model) return;
  if (!annotation.annotation?.trim()) {
    if (latestPropsRef) {
      showDraftAnnotationZone(state, editor, annotation, latestPropsRef);
    }
    return;
  }
  const requestedRange = new state.monaco.Range(
    source.selection.startLine,
    source.selection.startColumn,
    source.selection.endLine,
    source.selection.endColumn
  );
  const range = model.validateRange(requestedRange);
  state.annotationDecorations[side] = editor.deltaDecorations([], [{
    range,
    options: {
      className: "monaco-file-annotation-range",
      stickiness: state.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    }
  }]);

  const domNode = document.createElement("div");
  domNode.className = "monaco-file-annotation-zone";
  domNode.setAttribute("role", "group");
  domNode.setAttribute("aria-label", "Saved file annotation");
  const card = document.createElement("div");
  card.className = "monaco-file-annotation-attachment";
  const icon = document.createElement("span");
  icon.className = "monaco-file-annotation-attachment-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "“";
  const body = document.createElement("div");
  body.className = "monaco-file-annotation-attachment-body";
  const label = document.createElement("strong");
  label.textContent = "File annotation";
  const sourceLabel = document.createElement("code");
  const startLine = source.selection.startLine;
  const endLine = source.selection.endLine;
  const lineRange = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
  sourceLabel.textContent = `Source · ${source.path} · ${lineRange} · ${side}`;
  const annotationPreview = document.createElement("span");
  annotationPreview.className = "monaco-file-annotation-attachment-text";
  annotationPreview.textContent = annotation.annotation || "Referenced file selection";
  const sourcePreview = document.createElement("span");
  sourcePreview.className = "monaco-file-annotation-attachment-source-preview";
  sourcePreview.textContent = annotation.text;
  body.append(label, sourceLabel, annotationPreview, sourcePreview);
  const actions = document.createElement("div");
  actions.className = "monaco-file-annotation-attachment-actions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.title = "Edit file annotation";
  editButton.setAttribute("aria-label", "Edit file annotation");
  editButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (latestPropsRef) {
      showDraftAnnotationZone(state, editor, annotation, latestPropsRef);
    }
  });
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "×";
  removeButton.title = "Remove file annotation";
  removeButton.setAttribute("aria-label", "Remove file annotation");
  removeButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  removeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    clearAnnotationWidget(state);
    onRemoveAnnotation?.();
  });
  actions.append(editButton, removeButton);
  const stopEditorPointer = (event: Event) => event.stopPropagation();
  card.addEventListener("pointerdown", stopEditorPointer);
  card.addEventListener("mousedown", stopEditorPointer);
  card.addEventListener("click", stopEditorPointer);
  card.append(icon, body, actions);
  domNode.append(card);

  state.annotationZone = addInteractiveAnnotationZone(editor, range.endLineNumber, 112, domNode);
  layoutAnnotationZones(state, editor);
}

function clearSelectionWidget(state: MonacoEditorState) {
  if (!state.selectionWidget) return;
  state.selectionWidget.editor.removeContentWidget(state.selectionWidget.widget);
  state.selectionWidget = undefined;
}

function layoutAnnotationZones(state: MonacoEditorState, editor: Monaco.editor.IStandaloneCodeEditor) {
  const layout = editor.getLayoutInfo();
  const width = Math.max(240, layout.width - layout.minimap.minimapWidth - layout.verticalScrollbarWidth);
  const left = layout.minimap.minimapWidth > 0 && layout.minimap.minimapLeft === 0
    ? layout.minimap.minimapWidth
    : 0;
  [state.draftAnnotationZone, state.annotationZone].forEach((zone) => {
    if (!zone || zone.editor !== editor) return;
    zone.domNode.style.width = `${width}px`;
    zone.domNode.style.left = `${left}px`;
  });
}

function addInteractiveAnnotationZone(
  editor: Monaco.editor.IStandaloneCodeEditor,
  afterLineNumber: number,
  heightInPx: number,
  domNode: HTMLElement,
  sourcePath?: string
): MonacoAnnotationZone {
  const placeholder = document.createElement("div");
  const overlayWidgetId = `file-annotation-zone-${crypto.randomUUID()}`;
  const overlayWidget: Monaco.editor.IOverlayWidget = {
    getId: () => overlayWidgetId,
    getDomNode: () => domNode,
    getPosition: () => null
  };
  domNode.style.position = "absolute";
  domNode.style.top = "-1000px";
  domNode.style.height = `${heightInPx}px`;
  editor.addOverlayWidget(overlayWidget);

  let zoneId = "";
  editor.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber,
      heightInPx,
      domNode: placeholder,
      onDomNodeTop: (top) => {
        domNode.style.top = `${top}px`;
      },
      onComputedHeight: (height) => {
        domNode.style.height = `${height}px`;
      }
    });
  });
  return { editor, id: zoneId, domNode, overlayWidget, ...(sourcePath ? { sourcePath } : {}) };
}

function clearDraftAnnotationZone(state: MonacoEditorState) {
  if (!state.draftAnnotationZone) return;
  const { editor, id, overlayWidget } = state.draftAnnotationZone;
  state.draftAnnotationZone = undefined;
  editor.removeOverlayWidget(overlayWidget);
  editor.changeViewZones((accessor) => accessor.removeZone(id));
}

function clearAnnotationWidget(state: MonacoEditorState) {
  if (state.annotationZone) {
    const { editor, id, overlayWidget } = state.annotationZone;
    state.annotationZone = undefined;
    editor.removeOverlayWidget(overlayWidget);
    editor.changeViewZones((accessor) => accessor.removeZone(id));
  }
  (Object.entries(state.annotationDecorations) as Array<[DiffSide, string[] | undefined]>).forEach(([side, ids]) => {
    if (ids?.length) state.editors[side].deltaDecorations(ids, []);
  });
  state.annotationDecorations = {};
}

function loadLanguage(language: string) {
  const existing = languageLoads.get(language);
  if (existing) {
    return existing;
  }

  const load = languageImport(language).catch((error) => {
    languageLoads.delete(language);
    throw error;
  });
  languageLoads.set(language, load);
  return load;
}

function languageImport(language: string): Promise<unknown> {
  switch (language) {
    case "typescript":
      return import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js");
    case "javascript":
      return import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js");
    case "json":
      return import("monaco-editor/esm/vs/language/json/monaco.contribution.js").then((module) => {
        const jsonModule = module as unknown as {
          jsonDefaults: { setDiagnosticsOptions(options: { validate: boolean }): void };
        };
        jsonModule.jsonDefaults.setDiagnosticsOptions({ validate: false });
      });
    case "css":
      return import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js");
    case "scss":
      return import("monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js");
    case "less":
      return import("monaco-editor/esm/vs/basic-languages/less/less.contribution.js");
    case "html":
      return import("monaco-editor/esm/vs/basic-languages/html/html.contribution.js");
    case "markdown":
      return import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js");
    case "mdx":
      return import("monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js");
    case "python":
      return import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js");
    case "shell":
      return import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js");
    case "yaml":
      return import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js");
    case "xml":
      return import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js");
    case "sql":
      return import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js");
    case "mysql":
      return import("monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js");
    case "pgsql":
      return import("monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution.js");
    case "java":
      return import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js");
    case "csharp":
      return import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js");
    case "cpp":
      return import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js");
    case "go":
      return import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js");
    case "rust":
      return import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js");
    case "php":
      return import("monaco-editor/esm/vs/basic-languages/php/php.contribution.js");
    case "ruby":
      return import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js");
    case "kotlin":
      return import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js");
    case "swift":
      return import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js");
    case "dart":
      return import("monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js");
    case "lua":
      return import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js");
    case "r":
      return import("monaco-editor/esm/vs/basic-languages/r/r.contribution.js");
    case "perl":
      return import("monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js");
    case "powershell":
      return import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js");
    case "dockerfile":
      return import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js");
    case "graphql":
      return import("monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js");
    case "protobuf":
      return import("monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js");
    case "hcl":
      return import("monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js");
    case "ini":
      return import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js");
    default:
      return Promise.resolve();
  }
}

function languageForPath(filePath: string) {
  const fileName = filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.")) return "dockerfile";
  if (fileName.startsWith(".env") || fileName === ".editorconfig") return "ini";

  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    ipynb: "json",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xhtml: "html",
    vue: "html",
    svelte: "html",
    md: "markdown",
    markdown: "markdown",
    mdx: "mdx",
    py: "python",
    pyw: "python",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    svg: "xml",
    plist: "xml",
    sql: "sql",
    mysql: "mysql",
    pgsql: "pgsql",
    java: "java",
    cs: "csharp",
    c: "cpp",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    h: "cpp",
    hpp: "cpp",
    hxx: "cpp",
    go: "go",
    rs: "rust",
    php: "php",
    phtml: "php",
    rb: "ruby",
    rake: "ruby",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    dart: "dart",
    lua: "lua",
    r: "r",
    pl: "perl",
    pm: "perl",
    ps1: "powershell",
    psm1: "powershell",
    gql: "graphql",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    tfvars: "hcl",
    ini: "ini",
    cfg: "ini",
    conf: "ini",
    properties: "ini"
  };

  return languages[extension] ?? "plaintext";
}
