import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

// Keep the summary/anchor in the DOM, but don't parse hidden Markdown or mount
// large tool outputs until opened. Retain mounted content to preserve its state.
export function DeferredDetails({ summary, children, onToggle, ...props }: Omit<ComponentPropsWithoutRef<"details">, "children"> & {
  summary: ReactNode;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(Boolean(props.open));
  return <details {...props} onToggle={(event) => {
    if (event.target !== event.currentTarget) return;
    if (event.currentTarget.open) setVisited(true);
    onToggle?.(event);
  }}>
    {summary}
    {(visited || props.open) && children}
  </details>;
}
