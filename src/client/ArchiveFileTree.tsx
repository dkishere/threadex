import { useMemo, useState } from "react";
import type { ArchivePreview } from "../archivePreview";
import "./ArchiveFileTree.css";

type TreeNode = { name: string; size?: number; children: Map<string, TreeNode>; directory: boolean };

export function ArchiveFileTree({ archive }: { archive: ArchivePreview }) {
  const roots = useMemo(() => {
    const roots = new Map<string, TreeNode>();
    for (const entry of archive.entries) {
      const parts = entry.path.split(/[\\/]/).filter(Boolean);
      let siblings = roots;
      parts.forEach((name, index) => {
        let node = siblings.get(name);
        if (!node) {
          node = { name, directory: false, children: new Map() };
          siblings.set(name, node);
        }
        node.directory ||= index < parts.length - 1 || entry.directory;
        if (index === parts.length - 1 && !entry.directory) node.size = entry.size;
        siblings = node.children;
      });
    }
    return roots;
  }, [archive]);
  const files = archive.entries.filter((entry) => !entry.directory);
  return <div className="archive-preview" aria-label="ZIP file contents">
    <p>{files.length.toLocaleString()} files · {formatSize(files.reduce((total, entry) => total + entry.size, 0))} uncompressed</p>
    {archive.entries.length ? <TreeNodes nodes={roots} /> : <p>This archive is empty.</p>}
  </div>;
}

function TreeNodes({ nodes }: { nodes: Map<string, TreeNode> }) {
  return <ul>{[...nodes.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map((node) => <ArchiveNode key={node.name} node={node} />)}</ul>;
}

function ArchiveNode({ node }: { node: TreeNode }) {
  const [open, setOpen] = useState(false);
  return <li>{node.directory ? <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{node.name}/</summary>
    {open && <TreeNodes nodes={node.children} />}
  </details> : <div className="archive-file"><span>{node.name}</span><small>{formatSize(node.size ?? 0)}</small></div>}</li>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
