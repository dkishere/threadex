import { BaseEditor, createEditor, Editor, Element as SlateElement, Transforms } from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { Editable, ReactEditor, Slate, withReact } from "slate-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { UrlTagIcon } from "./UrlTagIcon";

export type ComposerInlineLink = {
  id: string;
  uri: string;
  title: string;
  status: "loading" | "ready";
  session?: { url?: string };
};

export type InlineLinkComposerHandle = {
  focus: () => void;
  setCaret: (offset: number) => void;
};

type LinkElement = { type: "composer-link"; id: string; children: [{ text: "" }] };
type ParagraphElement = { type: "paragraph"; children: ComposerNode[] };
type ComposerNode = { text: string } | LinkElement | ParagraphElement;

declare module "slate" {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: LinkElement | ParagraphElement;
    Text: { text: string };
  }
}

const tokenPattern = /\uFFFC([^\uFFFC]+)\uFFFC/g;

function linkToken(id: string) {
  return `\uFFFC${id}\uFFFC`;
}

function withInlineLinks(editor: Editor) {
  const { isInline, isVoid } = editor;
  editor.isInline = (element: SlateElement) => element.type === "composer-link" || isInline(element);
  editor.isVoid = (element: SlateElement) => element.type === "composer-link" || isVoid(element);
  return editor;
}

function deserialize(value: string, links: ComposerInlineLink[]): ComposerNode[] {
  const linkIds = new Set(links.map((link) => link.id));
  const children: ComposerNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(tokenPattern)) {
    if (match.index! > offset) children.push({ text: value.slice(offset, match.index) });
    const id = match[1];
    if (linkIds.has(id)) children.push({ type: "composer-link", id, children: [{ text: "" }] });
    else children.push({ text: match[0] });
    offset = match.index! + match[0].length;
  }
  if (offset < value.length || children.length === 0) children.push({ text: value.slice(offset) });
  return [{ type: "paragraph", children }];
}

function serialize(nodes: ComposerNode[]) {
  const walk = (node: ComposerNode): string => {
    if ("text" in node) return node.text;
    if (node.type === "composer-link") return linkToken(node.id);
    return node.children.map(walk).join("\n");
  };
  return nodes.map(walk).join("\n");
}

function insertInlineLink(editor: Editor, id: string) {
  if (!editor.selection) {
    Transforms.select(editor, Editor.end(editor, []));
  }
  Transforms.insertNodes(editor, { type: "composer-link", id, children: [{ text: "" }] });
  Transforms.insertText(editor, " ");
  Transforms.select(editor, Editor.end(editor, []));
  ReactEditor.focus(editor);
}

function keepFocusAtEnd(editor: Editor) {
  window.requestAnimationFrame(() => {
    Transforms.select(editor, Editor.end(editor, []));
    ReactEditor.focus(editor);
  });
}

type Props = {
  value: string;
  links: ComposerInlineLink[];
  placeholder: string;
  onChange: (value: string, caret?: number | null) => void;
  onPasteLink: (text: string) => string | null;
  onRemoveLink: (id: string) => void;
  onOpenLink: (link: ComposerInlineLink) => void;
  onUnhandledPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onBlur: () => void;
};

function serializedLength(node: ComposerNode): number {
  if ("text" in node) return node.text.length;
  if (node.type === "composer-link") return linkToken(node.id).length;
  return node.children.reduce((length, child, index) => length + (index > 0 ? 1 : 0) + serializedLength(child), 0);
}

function serializedCaretOffset(nodes: ComposerNode[], path: number[], offset: number): number | null {
  if (path.length === 0 || path[0] >= nodes.length) return null;
  let result = 0;
  for (let index = 0; index < path[0]; index += 1) {
    result += (index > 0 ? 1 : 0) + serializedLength(nodes[index]);
  }
  if (path[0] > 0) result += 1;

  let node = nodes[path[0]];
  for (let depth = 1; depth < path.length; depth += 1) {
    if ("text" in node || node.type === "composer-link") return result;
    const childIndex = path[depth];
    if (childIndex >= node.children.length) return null;
    for (let index = 0; index < childIndex; index += 1) {
      result += (index > 0 ? 1 : 0) + serializedLength(node.children[index]);
    }
    if (childIndex > 0) result += 1;
    node = node.children[childIndex];
  }

  return "text" in node ? result + Math.min(offset, node.text.length) : result;
}

export const InlineLinkComposer = forwardRef<InlineLinkComposerHandle, Props>(function InlineLinkComposer({ value, links, placeholder, onChange, onPasteLink, onRemoveLink, onOpenLink, onUnhandledPaste, onKeyDown, onBlur }, ref) {
  const editableRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const pasteLinkRef = useRef(onPasteLink);
  onChangeRef.current = onChange;
  pasteLinkRef.current = onPasteLink;
  const [editor] = useState(() => {
    const nextEditor = withHistory(withInlineLinks(withReact(createEditor())));
    const { insertData } = nextEditor;
    nextEditor.insertData = (data) => {
      const id = pasteLinkRef.current(data.getData("text/plain"));
      if (id) {
        insertInlineLink(nextEditor, id);
        onChangeRef.current(serialize(nextEditor.children as ComposerNode[]));
        keepFocusAtEnd(nextEditor);
        return;
      }
      insertData(data);
    };
    return nextEditor;
  });
  const linksById = useMemo(() => new Map(links.map((link) => [link.id, link])), [links]);

  useEffect(() => {
    if (serialize(editor.children as ComposerNode[]) === value) return;
    editor.children = deserialize(value, links) as never;
    editor.onChange();
  }, [editor, links, value]);

  useEffect(() => {
    let element = editableRef.current;
    if (!element) {
      try {
        element = ReactEditor.toDOMNode(editor, editor) as HTMLDivElement;
      } catch {
        element = null;
      }
    }
    if (!element) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const id = pasteLinkRef.current(text);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      ReactEditor.focus(editor);
      insertInlineLink(editor, id);
      onChangeRef.current(serialize(editor.children as ComposerNode[]));
      keepFocusAtEnd(editor);
    };
    document.addEventListener("paste", handlePaste, { capture: true });
    return () => document.removeEventListener("paste", handlePaste, { capture: true });
  }, [editor]);

  useImperativeHandle(ref, () => ({
    focus: () => ReactEditor.focus(editor),
    setCaret: (offset: number) => {
      let remaining = offset;
      for (const [node, path] of Editor.nodes(editor, { at: [], match: (item) => "text" in item })) {
        const text = (node as { text: string }).text;
        if (remaining <= text.length) {
          Transforms.select(editor, { anchor: { path, offset: remaining }, focus: { path, offset: remaining } });
          ReactEditor.focus(editor);
          return;
        }
        remaining -= text.length;
      }
      Transforms.select(editor, Editor.end(editor, []));
      ReactEditor.focus(editor);
    }
  }), [editor]);

  const renderElement = useCallback(({ attributes, children, element }: { attributes: Record<string, unknown>; children: React.ReactNode; element: SlateElement }) => {
    if (element.type !== "composer-link") return <p {...attributes}>{children}</p>;
    const link = linksById.get((element as LinkElement).id);
    if (!link) return <span {...attributes}>{children}</span>;
    return <span {...attributes} contentEditable={false} className="composer-inline-link" title={link.uri}>
      <UrlTagIcon url={link.uri} />
      <button type="button" className="composer-inline-link-title" onMouseDown={(event) => event.preventDefault()} onClick={() => onOpenLink(link)}>{link.status === "loading" ? "Loading link…" : link.title}</button>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
        const path = ReactEditor.findPath(editor, element);
        Transforms.removeNodes(editor, { at: path });
        onRemoveLink(link.id);
      }} aria-label={`Remove ${link.title}`}>×</button>
      {children}
    </span>;
  }, [editor, linksById, onOpenLink, onRemoveLink]);

  return <Slate editor={editor} initialValue={deserialize(value, links) as never} onValueChange={(nextValue) => {
    const nodes = nextValue as ComposerNode[];
    const caret = editor.selection
      ? serializedCaretOffset(nodes, editor.selection.focus.path, editor.selection.focus.offset)
      : null;
    onChange(serialize(nodes), caret);
  }}>
    <Editable
      className="composer-editor composer-inline-editor"
      ref={editableRef}
      style={{ minHeight: 42 }}
      aria-label="Message"
      data-placeholder={placeholder}
      placeholder={placeholder}
      renderElement={renderElement}
      onPasteCapture={(event) => {
        const id = onPasteLink(event.clipboardData.getData("text/plain"));
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        insertInlineLink(editor, id);
        onChange(serialize(editor.children as ComposerNode[]));
        keepFocusAtEnd(editor);
      }}
      onPaste={(event) => {
        onUnhandledPaste(event);
        if (!event.defaultPrevented) {
          window.requestAnimationFrame(() => onChange(serialize(editor.children as ComposerNode[])));
        }
      }}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  </Slate>;
});
