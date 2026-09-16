import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
export type MarkdownChunks = { source: string; frozen: string[]; offset: number; tail: string; wholeDocument: boolean };

export function advanceMarkdownChunks(previous: MarkdownChunks | null, source: string): MarkdownChunks {
  if (previous?.source === source) return previous;
  const appending = previous !== null && source.startsWith(previous.source);
  const frozen = appending ? previous.frozen : [];
  const offset = appending ? previous.offset : 0;
  const tail = source.slice(offset);
  if (appending && previous.wholeDocument) return wholeDocument(source);

  // Only parse the unfinished suffix. A following root block proves that the
  // previous paragraph/list/table/fence has ended; blank lines alone do not.
  const tree = parser.parse(tail);
  if (hasDefinition(tree)) return wholeDocument(source);
  const last = tree.children.at(-1);
  const start = last?.position?.start.offset ?? 0;
  const boundary = start > 0 ? Math.max(tail.lastIndexOf("\n", start - 1), tail.lastIndexOf("\r", start - 1)) + 1 : 0;
  if (tree.children.length < 2 || boundary === 0) {
    return { source, frozen, offset, tail, wholeDocument: false };
  }
  return { source, frozen: [...frozen, tail.slice(0, boundary)], offset: offset + boundary, tail: tail.slice(boundary), wholeDocument: false };
}

function wholeDocument(source: string): MarkdownChunks {
  // A reference/footnote definition can change earlier text. Keep normal
  // document-wide Markdown semantics in this less common case.
  return { source, frozen: [], offset: 0, tail: source, wholeDocument: true };
}

function hasDefinition(node: { type: string; children?: readonly { type: string }[] }): boolean {
  return node.type === "definition" || node.type === "footnoteDefinition" || Boolean(node.children?.some(hasDefinition));
}
