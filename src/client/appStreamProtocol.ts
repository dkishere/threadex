// @ts-nocheck
// Stream parsing is isolated from the React shell so it can be typed and tested independently.
export async function readEventStream(stream, onEvent) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
            const parsed = parseEvent(chunk);
            if (parsed) {
                sawDone ||= parsed.type === "done";
                onEvent(parsed);
            }
        }
    }
    buffer += decoder.decode();
    const parsed = parseEvent(buffer);
    if (parsed) {
        sawDone ||= parsed.type === "done";
        onEvent(parsed);
    }
    return sawDone;
}

export function parseEvent(chunk) {
    const lines = chunk.replace(/\r\n/g, "\n").split("\n");
    const eventLine = lines.find((line) => line.startsWith("event:"));
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (!eventLine || dataLines.length === 0) {
        return undefined;
    }
    try {
        return {
            type: eventLine.slice("event:".length).trim(),
            data: JSON.parse(dataLines.map((line) => line.slice("data:".length).trimStart()).join("\n"))
        };
    }
    catch {
        return undefined;
    }
}

export function isStreamItem(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const item = value;
    return ((item.itemType === "agent_message" &&
        typeof item.id === "string" &&
        (item.eventType === "item.started" || item.eventType === "item.updated" || item.eventType === "item.completed") &&
        typeof item.text === "string") ||
        isLiveItem(value));
}

export function isLiveItem(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const item = value;
    return (typeof item.id === "string" &&
        (item.eventType === "item.started" || item.eventType === "item.updated" || item.eventType === "item.completed") &&
        (item.itemType === "agent_message" ||
            item.itemType === "reasoning" ||
            item.itemType === "command_execution" ||
            item.itemType === "file_change" ||
            item.itemType === "web_search" ||
            item.itemType === "todo_list" ||
            item.itemType === "context_compaction" ||
            item.itemType === "subagent" ||
            item.itemType === "approval" ||
            item.itemType === "error"));
}

export function getCodexEventName(event) {
    return event.method || event.type;
}

export function isCodexTurnCompletedEvent(event) {
    if (getCodexEventName(event) !== "turn/completed" && getCodexEventName(event) !== "turn.completed") {
        return false;
    }
    const params = readRecord(event.params);
    const turn = readRecord(params?.turn);
    return turn?.status === "completed" && !turn.error;
}

export async function readApiError(response) {
    try {
        const payload = (await response.json());
        return typeof payload.error === "string" ? payload.error : `API returned ${response.status}`;
    }
    catch {
        return `API returned ${response.status}`;
    }
}

export function readRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
