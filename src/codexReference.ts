export type ParsedCodexReference = {
  uri: string;
  workspaceId?: string;
  target: string;
  turnId?: string;
  turnNumbers?: number[];
  lookupKind: "sessionId" | "threadId";
};

const MAX_REFERENCE_SEGMENT_LENGTH = 200;
const WORKSPACE_QUERY_KEY = "workspace";

export function isThreadexSessionId(id: string) {
  return id.startsWith("tx_") || id.startsWith("local_");
}

export function canonicalSessionId(id: string) {
  return id.startsWith("local_") ? `tx_${id.slice(6)}` : id;
}

export function sessionIdAliases(id: string) {
  const canonical = canonicalSessionId(id);
  return canonical.startsWith("tx_") ? [...new Set([id, canonical, `local_${canonical.slice(3)}`])] : [id];
}

export function buildCodexReference(workspaceId: string, target: string, turnId?: string) {
  return `threadex://${encodeURIComponent(workspaceId)}/${encodeURIComponent(canonicalSessionId(target))}`
    + (turnId ? `/${encodeURIComponent(turnId)}` : "");
}

export const buildThreadexReference = buildCodexReference;

export function buildThreadexTurnReference(workspaceId: string, target: string, turnNumbers: number[]) {
  if (!turnNumbers.length || turnNumbers.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("Invalid turn numbers");
  return `${buildCodexReference(workspaceId, target)}#${[...new Set(turnNumbers)].sort((a, b) => a - b).join("/")}`;
}

export function parseCodexReference(value: string): ParsedCodexReference | null {
  const trimmed = value.trim();
  const numbered = /^(threadex:\/\/[^\s/?#]+\/[^\s/?#]+)#([1-9]\d*(?:\/[1-9]\d*)*)$/i.exec(trimmed);
  if (numbered) {
    const base = parseCodexReference(numbered[1]);
    const turnNumbers = [...new Set(numbered[2].split("/").map(Number))].sort((a, b) => a - b);
    if (!base?.workspaceId || turnNumbers.some(n => !Number.isSafeInteger(n))) return null;
    return { ...base, uri: buildThreadexTurnReference(base.workspaceId, base.target, turnNumbers), turnNumbers };
  }
  const canonical = /^threadex:\/\/([^\s/?#]+)\/([^\s/?#]+)(?:\/([^\s/?#]+))?\/?$/i.exec(trimmed);
  if (canonical) {
    const workspaceId = decodeOpaqueSegment(canonical[1]);
    const rawTarget = decodeReferenceSegment(canonical[2]);
    const turnId = canonical[3] ? decodeOpaqueSegment(canonical[3]) : undefined;
    if (!workspaceId || !rawTarget || (canonical[3] && !turnId)) return null;
    const target = canonicalSessionId(rawTarget);
    return { uri: buildCodexReference(workspaceId, target, turnId ?? undefined), workspaceId, target,
      ...(turnId ? { turnId } : {}), lookupKind: isThreadexSessionId(target) ? "sessionId" : "threadId" };
  }
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
  const target = canonicalSessionId(second ?? first);
  return {
    uri: workspaceId
      ? buildCodexReference(workspaceId, target)
      : buildUnscopedCodexReference(target),
    ...(workspaceId ? { workspaceId } : {}),
    target,
    lookupKind: isThreadexSessionId(target) ? "sessionId" : "threadId"
  };
}

function parseStandardCodexReference(value: string): ParsedCodexReference | null {
  const match = /^codex:\/\/threads\/([^\s/?#]+)\/?(?:\?([^\s#]*))?$/i.exec(value);
  if (!match) {
    return null;
  }

  const rawTarget = decodeReferenceSegment(match[1]);
  if (!rawTarget) {
    return null;
  }
  const target = canonicalSessionId(rawTarget);

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
    lookupKind: isThreadexSessionId(target) ? "sessionId" : "threadId"
  };
}

function buildUnscopedCodexReference(target: string) {
  return buildCodexReference("default", target);
}

function decodeReferenceSegment(value: string) {
  try {
    return validateReferenceSegment(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function decodeOpaqueSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() && decoded.length <= MAX_REFERENCE_SEGMENT_LENGTH && !/[\u0000-\u001f]/.test(decoded) ? decoded : null;
  } catch { return null; }
}

function validateReferenceSegment(value: string) {
  if (
    !value ||
    value.length > MAX_REFERENCE_SEGMENT_LENGTH ||
    /[\s/?#\u0000-\u001f]/.test(value)
  ) {
    return null;
  }
  return value;
}
