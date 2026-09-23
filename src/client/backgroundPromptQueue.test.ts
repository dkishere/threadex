import assert from "node:assert/strict";
import test from "node:test";
import { dispatchBackgroundPrompt } from "./backgroundPromptQueue";
import type { QueuedPrompt } from "./appTypes";

function setup(t: import("node:test").TestContext, status = "done", postStatus = 200) {
    const requests: Record<string, unknown>[] = [];
    let queue: QueuedPrompt[] = [{ id: "prompt-1", kind: "queue", content: "continue", attachments: [], requestSettings: { model: "queued-model", approvalPolicy: "never" } }];
    const errors: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, options?: RequestInit) => {
        if (options?.method === "POST") {
            requests.push(JSON.parse(String(options.body)));
            return new Response("", { status: postStatus });
        }
        return Response.json({ session: { id: "background", workspaceId: "original-workspace", threadId: "original-thread" }, turns: [{ status }], modelPreferences: { selectedModel: "stored-model" } });
    });
    const ctx = {
        sessionId: "background", locks: new Set<string>(), getQueue: () => queue,
        remove: (id: string) => { queue = queue.filter((prompt) => prompt.id !== id); },
        readStream: async (_body: ReadableStream<Uint8Array>) => {},
        onError: (error: unknown) => { errors.push(error); }
    };
    return { ctx, requests, errors };
}

test("completion dispatches the background session with its original settings", async (t) => {
    const { ctx, requests, errors } = setup(t);
    await dispatchBackgroundPrompt(ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].sessionId, "background");
    assert.equal(requests[0].workspaceId, "original-workspace");
    assert.equal(requests[0].resumeThreadId, "original-thread");
    assert.equal(requests[0].model, "queued-model");
    assert.equal(requests[0].approvalPolicy, "never");
    assert.equal(requests[0].turnId, "prompt-1");
    assert.equal(ctx.getQueue().length, 0);
    assert.deepEqual(errors, []);
});

test("duplicate completion events cannot dispatch twice while the stream is open", async (t) => {
    const { ctx, requests } = setup(t);
    let release!: () => void;
    ctx.readStream = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = dispatchBackgroundPrompt(ctx);
    await new Promise((resolve) => setImmediate(resolve));
    await dispatchBackgroundPrompt(ctx);
    assert.equal(requests.length, 1);
    assert.equal(ctx.locks.has("background"), true);
    release();
    await pending;
    assert.equal(ctx.locks.size, 0);
});

for (const status of ["running", "todo"]) {
    test(`does not bypass a ${status} turn`, async (t) => {
        const { ctx, requests } = setup(t, status);
        await dispatchBackgroundPrompt(ctx);
        assert.equal(requests.length, 0);
        assert.equal(ctx.getQueue().length, 1);
    });
}

test("failed submission preserves the queued prompt for retry", async (t) => {
    const { ctx, requests, errors } = setup(t, "done", 503);
    await dispatchBackgroundPrompt(ctx);
    assert.equal(requests.length, 1);
    assert.equal(ctx.getQueue().length, 1);
    assert.equal(errors.length, 1);
    assert.equal(ctx.locks.size, 0);
});
