import type { ResponseAnnotation } from "./responseAnnotations";

const HASH_PREFIX = "#threadex-annotation=";

export type VsCodeAnnotationEnvelope = {
  version: 1;
  sessionId: string;
  annotation: ResponseAnnotation;
};

export function consumeVsCodeAnnotation(href = window.location.href): VsCodeAnnotationEnvelope | null {
  const url = new URL(href, window.location.origin);
  if (!url.hash.startsWith(HASH_PREFIX)) return null;
  try {
    const encoded = url.hash.slice(HASH_PREFIX.length);
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<VsCodeAnnotationEnvelope>;
    if (value.version !== 1 || typeof value.sessionId !== "string" || !value.sessionId || !isAnnotation(value.annotation)) return null;
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.toString());
    return value as VsCodeAnnotationEnvelope;
  } catch {
    return null;
  }
}

function isAnnotation(value: unknown): value is ResponseAnnotation {
  if (!value || typeof value !== "object") return false;
  const annotation = value as Partial<ResponseAnnotation>;
  const source = annotation.source;
  return Boolean(
    typeof annotation.text === "string" && annotation.text.trim() &&
    typeof annotation.annotation === "string" && annotation.annotation.trim() &&
    source?.type === "file" && source.path && source.selection &&
    Number.isInteger(source.selection.startLine) && Number.isInteger(source.selection.endLine)
  );
}
