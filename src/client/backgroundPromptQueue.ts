import type { QueuedPrompt } from "./appTypes";

// The lock covers the stream, not just the POST: result and done can both
// announce completion, and navigation must not submit the same queue twice.
export async function dispatchBackgroundPrompt(ctx: {
    sessionId: string;
    locks: Set<string>;
    getQueue: () => QueuedPrompt[];
    remove: (id: string) => void;
    readStream: (body: ReadableStream<Uint8Array>) => Promise<void>;
    onError: (error: unknown) => void;
}) {
    if (ctx.locks.has(ctx.sessionId) || !ctx.getQueue().length) return;
    ctx.locks.add(ctx.sessionId);
    try {
        const snapshotResponse = await fetch(`/api/sessions/${encodeURIComponent(ctx.sessionId)}/snapshot`, { cache: "no-store" });
        if (!snapshotResponse.ok) throw new Error(`Queue snapshot returned ${snapshotResponse.status}`);
        const snapshot = await snapshotResponse.json();
        if (snapshot.turns.some((turn: { status: string }) => turn.status === "running" || turn.status === "todo")) return;
        const prompt = ctx.getQueue()[0];
        if (!prompt) return;
        const preferences = snapshot.modelPreferences;
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: preferences?.selectedModel,
                modelReasoningEffort: preferences?.selectedEffort,
                autoModel: snapshot.autoModel?.enabled === true,
                ...prompt.requestSettings,
                sessionId: ctx.sessionId,
                workspaceId: snapshot.session.workspaceId,
                resumeThreadId: snapshot.session.threadId ?? undefined,
                turnId: prompt.id,
                message: prompt.content,
                attachments: prompt.attachments,
                skills: prompt.skills?.map(({ name, path }) => ({ name, path })),
                executionMode: prompt.executionMode ?? "default",
                contextFork: prompt.contextFork === true,
                forcePlan: prompt.forcePlan === true
            })
        });
        if (!response.ok || !response.body) throw new Error(`Queued prompt returned ${response.status}`);
        ctx.remove(prompt.id);
        await ctx.readStream(response.body);
    } catch (error) {
        ctx.onError(error);
    } finally {
        ctx.locks.delete(ctx.sessionId);
    }
}
