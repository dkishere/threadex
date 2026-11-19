export type StepMarker = {
  stepNumber: number;
  title: string;
};

const STEP_MARKER_RE = /^\s*(?:#{1,6}\s*)?Step\s+(\d+)\b[^\n]*/i;

export function stepMarkerFromText(text: string): StepMarker | null {
  const match = STEP_MARKER_RE.exec(text);
  if (!match) {
    return null;
  }

  const stepNumber = Number(match[1]);
  if (!Number.isFinite(stepNumber)) {
    return null;
  }

  const title = match[0].trim().replace(/\s+/g, " ");
  return { stepNumber, title };
}
