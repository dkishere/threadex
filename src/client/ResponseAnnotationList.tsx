import { ChevronRight, Quote } from "lucide-react";
import type { ResponseAnnotation } from "./responseAnnotations";

export function ResponseAnnotationList({ annotations }: { annotations: ResponseAnnotation[] }) {
  return (
    <div className="response-annotation-list" aria-label="Referenced excerpts">
      {annotations.map((annotation, index) => (
        <details className="response-annotation-attachment" key={`${index}:${annotation.text}`}>
          <summary>
            <span className="response-annotation-icon" aria-hidden="true">
              <Quote />
            </span>
            <span className="response-annotation-summary">
              <span className="response-annotation-label">{annotationLabel(annotation)}</span>
              <span className="response-annotation-preview">{annotation.text}</span>
            </span>
            <ChevronRight className="response-annotation-chevron" aria-hidden="true" />
          </summary>
          <blockquote>{annotation.text}</blockquote>
        </details>
      ))}
    </div>
  );
}

export function annotationLabel(annotation: ResponseAnnotation | undefined) {
  const source = annotation?.source;
  if (source?.type === "file") {
    const start = source.selection.startLine;
    const end = source.selection.endLine;
    const lineRange = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
    return `File annotation · Source: ${source.path} · ${lineRange}${source.side ? ` · ${capitalize(source.side)}` : ""}`;
  }
  return `Quoted response${source?.type === "response" && source.turnNumber ? ` · Turn ${source.turnNumber}` : ""}`;
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
