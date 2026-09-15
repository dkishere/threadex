export type ParsedCodexReference = {
  uri: string;
  workspaceId?: string;
  target: string;
  lookupKind: "sessionId" | "threadId";
};

const MAX_REFERENCE_SEGMENT_LENGTH = 200;
const STANDARD_REFERENCE_HOST = "threads";
const WORKSPACE_QUERY_KEY = "workspace";

export function buildCodexReference(workspaceId: string, target: string) {
  const params = new URLSearchParams({ [WORKSPACE_QUERY_KEY]: workspaceId });
  return `codex://${STANDARD_REFERENCE_HOST}/${encodeURIComponent(target)}?${params}`;
}

export function parseCodexReference(value: string): ParsedCodexReference | null {
  const trimmed = value.trim();
  const standardReference = parseStandardCodexReference(trimmed);
  if (standardReference) {
    return standardReference;
  }

  const match = /^codex:\/\/([^\s/?#]+)(?:\/([^\s/?#]+))?\/?$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const first = decodeReferenceSegment(match[1]);
  const second = match[2] ? decodeReferenceSegment(match[2]) : null;
  if (!first || (match[2] && !second)) {
    return null;
  }

  const workspaceId = second ? first : undefined;
  const target = second ?? first;
  return {
    uri: workspaceId
      ? buildCodexReference(workspaceId, target)
      : buildUnscopedCodexReference(target),
    ...(workspaceId ? { workspaceId } : {}),
    target,
    lookupKind: target.startsWith("local_") ? "sessionId" : "threadId"
  };
}

function parseStandardCodexReference(value: string): ParsedCodexReference | null {
  const match = /^codex:\/\/threads\/([^\s/?#]+)\/?(?:\?([^\s#]*))?$/i.exec(value);
  if (!match) {
    return null;
  }

  const target = decodeReferenceSegment(match[1]);
  if (!target) {
    return null;
  }

  const params = new URLSearchParams(match[2] ?? "");
  const workspaceValues = params.getAll(WORKSPACE_QUERY_KEY);
  if ([...params.keys()].some((key) => key !== WORKSPACE_QUERY_KEY) || workspaceValues.length > 1) {
    return null;
  }

  const workspaceId = workspaceValues.length > 0
    ? validateReferenceSegment(workspaceValues[0] ?? "")
    : undefined;
  if (workspaceValues.length > 0 && !workspaceId) {
    return null;
  }

  return {
    uri: workspaceId
      ? buildCodexReference(workspaceId, target)
      : buildUnscopedCodexReference(target),
    ...(workspaceId ? { workspaceId } : {}),
    target,
    lookupKind: target.startsWith("local_") ? "sessionId" : "threadId"
  };
}

function buildUnscopedCodexReference(target: string) {
  return `codex://${STANDARD_REFERENCE_HOST}/${encodeURIComponent(target)}`;
}

function decodeReferenceSegment(value: string) {
  try {
    return validateReferenceSegment(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function validateReferenceSegment(value: string) {
  if (
    !value ||
    value.length > MAX_REFERENCE_SEGMENT_LENGTH ||
    /[\s/?#]/.test(value)
  ) {
    return null;
  }
  return value;
}
