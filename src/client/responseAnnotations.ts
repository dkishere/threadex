export type ResponseAnnotationResponseSource = {
  type: "response";
  sessionUrl: string;
  turnId?: string;
  turnNumber?: number;
};

export type ResponseAnnotationFileSource = {
  type: "file";
  path: string;
  selection: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  side?: "original" | "modified";
  workspaceId?: string;
  sessionUrl?: string;
};

export type ResponseAnnotationSource = ResponseAnnotationResponseSource | ResponseAnnotationFileSource;

export type ResponseAnnotation = {
  text: string;
  annotation?: string;
  source?: ResponseAnnotationSource;
};

export type ParsedResponseAnnotations = {
  annotations: ResponseAnnotation[];
  content: string;
};

const RESPONSE_ANNOTATIONS_OPEN = "<response-annotations>";
const RESPONSE_ANNOTATIONS_CLOSE = "</response-annotations>";

export function formatResponseAnnotationsPrompt(annotations: ResponseAnnotation[], request = ""): string {
  const payload = annotations
    .map((annotation) => ({
      text: annotation.text.trim(),
      ...(annotation.annotation?.trim() ? { annotation: annotation.annotation.trim() } : {}),
      ...(annotation.source ? { source: annotation.source } : {})
    }))
    .filter((annotation) => annotation.text);

  if (payload.length === 0) {
    return request.trim();
  }

  return [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response or workspace file and may include a user comment. Use every selection and its source as context, and address every comment in your response.",
    RESPONSE_ANNOTATIONS_OPEN,
    JSON.stringify(payload),
    RESPONSE_ANNOTATIONS_CLOSE,
    "",
    "## My request for Codex:",
    request.trim()
  ].join("\n");
}

export function parseResponseAnnotations(value: string): ParsedResponseAnnotations | null {
  const openIndex = value.indexOf(RESPONSE_ANNOTATIONS_OPEN);
  const closeIndex = value.indexOf(RESPONSE_ANNOTATIONS_CLOSE, openIndex + RESPONSE_ANNOTATIONS_OPEN.length);
  if (openIndex < 0 || closeIndex < 0) {
    return null;
  }

  const protocolHeader = value.slice(0, openIndex);
  if (!/^\s*#\s+Response annotations:\s*/i.test(protocolHeader)) {
    return null;
  }

  const rawAnnotations = value
    .slice(openIndex + RESPONSE_ANNOTATIONS_OPEN.length, closeIndex)
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawAnnotations);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const annotations = parsed.flatMap((candidate): ResponseAnnotation[] => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }

    const record = candidate as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) {
      return [];
    }

    const annotation = typeof record.annotation === "string" ? record.annotation.trim() : "";
    const source = parseResponseAnnotationSource(record.source);
    return [{
      text,
      ...(annotation ? { annotation } : {}),
      ...(source ? { source } : {})
    }];
  });

  if (annotations.length === 0) {
    return null;
  }

  const request = value
    .slice(closeIndex + RESPONSE_ANNOTATIONS_CLOSE.length)
    .replace(/^\s*##\s+My request for Codex:\s*/i, "")
    .trim();
  const comments = annotations.flatMap((annotation) => annotation.annotation ? [annotation.annotation] : []);

  return {
    annotations,
    content: [...comments, request].filter(Boolean).join("\n\n")
  };
}

function parseResponseAnnotationSource(value: unknown): ResponseAnnotationSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (record.type === "file") {
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const selection = parseFileSelection(record.selection);
    if (!path || !selection) return null;

    const side = record.side === "original" || record.side === "modified" ? record.side : undefined;
    const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const sessionUrl = typeof record.sessionUrl === "string" ? record.sessionUrl.trim() : "";
    return {
      type: "file",
      path,
      selection,
      ...(side ? { side } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(/^(codex|threadex):\/\/[^\s]+$/i.test(sessionUrl) ? { sessionUrl } : {})
    };
  }

  // Sources written before the discriminant was introduced are response sources.
  if (record.type !== undefined && record.type !== "response") return null;
  const sessionUrl = typeof record.sessionUrl === "string" ? record.sessionUrl.trim() : "";
  if (!/^(codex|threadex):\/\/[^\s]+$/i.test(sessionUrl)) return null;

  return {
    type: "response",
    sessionUrl,
    ...(typeof record.turnId === "string" && record.turnId ? { turnId: record.turnId } : {}),
    ...(typeof record.turnNumber === "number" && Number.isInteger(record.turnNumber) && record.turnNumber > 0
      ? { turnNumber: record.turnNumber }
      : {})
  };
}

function parseFileSelection(value: unknown): ResponseAnnotationFileSource["selection"] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const startLine = positiveInteger(record.startLine);
  const startColumn = positiveInteger(record.startColumn);
  const endLine = positiveInteger(record.endLine);
  const endColumn = positiveInteger(record.endColumn);
  if (!startLine || !startColumn || !endLine || !endColumn) return null;
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) return null;
  return { startLine, startColumn, endLine, endColumn };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
