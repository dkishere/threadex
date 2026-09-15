import type { ChatMessage, MessageSegment } from "./appTypes";

export type TranscriptRenderEntry =
  | { kind: "message"; id: string; message: ChatMessage }
  | {
      kind: "step_group";
      id: string;
      stepNumber: number;
      title: string;
      open: boolean;
      messages: ChatMessage[];
    };

export type StepMarker = {
  stepNumber: number;
  title: string;
};

const STEP_MARKER_RE = /^\s*(?:#{1,6}\s*)?Step\s+(\d+)\b[^\n]*/i;

export function groupTranscriptByStepMarkers(messages: ChatMessage[]): TranscriptRenderEntry[] {
  const entries: TranscriptRenderEntry[] = [];
  let activeGroup: Extract<TranscriptRenderEntry, { kind: "step_group" }> | null = null;

  for (const message of messages) {
    const marker = stepMarkerFromMessage(message);

    if (marker) {
      activeGroup = {
        kind: "step_group",
        id: `step-group:${message.id}`,
        stepNumber: marker.stepNumber,
        title: marker.title,
        open: true,
        messages: [message]
      };
      entries.push(activeGroup);
      continue;
    }

    if (activeGroup && shouldAppendMessageToStepGroup(message)) {
      activeGroup.messages.push(message);
      continue;
    }

    activeGroup = null;
    entries.push({ kind: "message", id: message.id, message });
  }

  const groups = entries.filter((entry): entry is Extract<TranscriptRenderEntry, { kind: "step_group" }> =>
    entry.kind === "step_group"
  );
  groups.forEach((group, index) => {
    group.open = index === groups.length - 1;
  });

  return entries;
}

function stepMarkerFromMessage(message: ChatMessage): StepMarker | null {
  if (message.role !== "assistant") {
    return null;
  }

  return stepMarkerFromText(firstMessageText(message));
}

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

function firstMessageText(message: ChatMessage) {
  if (message.content.trim()) {
    return message.content.trimStart();
  }

  const textSegment = message.segments?.find((segment): segment is Extract<MessageSegment, { type: "text" }> =>
    segment.type === "text" && segment.text.trim().length > 0
  );
  return textSegment?.text.trimStart() ?? "";
}

function shouldAppendMessageToStepGroup(message: ChatMessage) {
  return message.role === "assistant";
}
