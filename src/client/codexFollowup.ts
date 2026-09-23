import type { Root, Text } from "mdast";

export const CODEX_FOLLOWUP_EVENT = "threadex:codex-followup";

// Read the original source so Markdown escaping cannot alter the prompt.
export function remarkCodexFollowup() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    function visit(node: { type: string; children?: unknown[]; position?: Text["position"]; data?: unknown }) {
      if (node.type === "paragraph") {
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        const match = /^:codex-followup\[((?:\\.|[^\]\\\n])+)\]\{prompt=("(?:\\.|[^"\\])*")\}$/.exec(raw);
        if (match) {
          try {
            const prompt: string = JSON.parse(match[2]);
            if (!prompt.trim()) return;
            node.children = [{ type: "text", value: match[1].replace(/\\([\[\]\\])/g, "$1") }];
            node.data = { hName: "button", hProperties: { type: "button", className: "codex-followup", "data-followup-prompt": prompt } };
            return;
          } catch { /* Incomplete or invalid directives remain readable text. */ }
        }
      }
      for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
    }
    visit(tree);
  };
}

export function remarkCodexFileCitation() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    function visit(node: { type: string; children?: unknown[]; position?: Text["position"]; data?: unknown }) {
      if (node.type === "paragraph") {
        const raw = source.slice(node.position?.start.offset, node.position?.end.offset);
        const match = /^:codex-file-citation\{\s*((?:[\w-]+=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))(?:\s+[\w-]+=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))*)\s*\}$/.exec(raw);
        const attributes = match ? citationAttributes(match[1]) : null;
        const path = attributes?.path;
        if (path && isAbsoluteFilePath(path)) {
          const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
          const purpose = attributes.purpose === "output" ? "Output" : "File";
          node.children = [{ type: "text", value: `${purpose}: ${name}` }];
          node.data = { hName: "a", hProperties: { className: "codex-file-citation", href: path, title: `Open ${name}` } };
          return;
        }
      }
      for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
    }
    visit(tree);
  };
}

function citationAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const expression = /(?:^|\s+)([\w-]+)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  for (const match of source.matchAll(expression)) {
    const [, name, quoted] = match;
    if (name in attributes) return null;
    try {
      attributes[name] = quoted.startsWith('"') ? JSON.parse(quoted) : JSON.parse(`"${quoted.slice(1, -1).replace(/"/g, '\\"')}"`);
    } catch {
      return null;
    }
  }
  return attributes;
}

function isAbsoluteFilePath(path: string) {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}
