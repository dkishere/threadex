import WebSocket from "ws";
import type { QuickChatStatus } from "../quickChat";

export type QuickChatCompletion = { text: string; messageId: string; conversationId: string };
export type QuickChatRequest = { accountId: string; model: string; prompt: string; conversationId?: string; parentMessageId?: string };
export interface QuickChatBridge {
  status(): Promise<QuickChatStatus>;
  send(request: QuickChatRequest): Promise<QuickChatCompletion>;
}

// Private desktop APIs are build-specific. Fail closed when the installed build changes.
// No authentication material leaves the App, and no window/navigation API is called.
export const quickChatRuntime = String.raw`async (input) => {
  // This deliberately works in a visible renderer too. The adapter only calls
  // existing completion APIs: it never focuses, navigates, or writes App UI state.
  let asset = [...document.scripts].map(script => script.src).find(name => /\/app-initial-[\w]+\.js(?:$|\?)/.test(name));
  if (!asset) {
    const entry = [...document.scripts].map(script => script.src).find(name => /\/index-[\w]+\.js(?:$|\?)/.test(name));
    if (entry) {
      const source = await (await fetch(entry)).text();
      const match = source.match(/["']\.\/(app-initial-[\w]+\.js)["']/);
      if (match) asset = new URL(match[1], entry).href;
    }
  }
  if (!asset) throw Error("Could not locate the ChatGPT App completion module.");
  const m = await import(asset);
  const symbols = /\/app-initial-b21bd554b363\.js(?:$|\?)/.test(asset)
    ? {root:m.Een, auth:m.sXt, models:m.CSt, client:m.TDt}
    : /\/app-initial-c72822ce2409\.js(?:$|\?)/.test(asset)
      ? {root:m.Xpn, auth:m.Vin, models:m.azt, client:m.zUt}
      : null;
  if (!symbols) throw Error("This ChatGPT App build is not supported by the Quick Chat adapter.");
  const root = document.querySelector("#root, #app");
  const key = root && Object.keys(root).find(k => k.startsWith("__reactContainer"));
  if (!key) throw Error("ChatGPT renderer is not ready.");
  const fiber = root[key];
  const queue = [fiber.stateNode?.current ?? fiber];
  const seen = new Set();
  let scope;
  while (queue.length && seen.size < 20000 && !scope) {
    const f = queue.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f); queue.push(f.child, f.sibling);
    let hook = f.memoizedState;
    for (let i = 0; hook && i < 100 && !scope; i++, hook = hook.next) {
      const value = hook.memoizedState;
      const candidates = [value, value?.current, ...(Array.isArray(value) ? value : [])];
      for (const candidate of candidates) {
        if (candidate?.scope === symbols.root && typeof candidate.get === "function" && typeof candidate.set === "function") { scope = candidate; break; }
      }
    }
  }
  if (!scope) throw Error("ChatGPT background scope is not ready.");
  const identity = () => {
    const auth = scope.get(symbols.auth);
    if (auth.requiresAuth || !auth.authenticatedAccountId || !auth.userId) throw Error("Sign in to ChatGPT App before using Quick Chat.");
    return {id: JSON.stringify([auth.authenticatedAccountId, auth.userId]), label: auth.email || auth.authenticatedAccountId};
  };
  const account = identity();
  if (input.accountId && input.accountId !== account.id) throw Error("ChatGPT App account changed. Refresh the account selector.");
  const state = globalThis.__threadexQuickChatV1 ??= {job: null};
  if (input.action === "poll") {
    if (!state.job || state.job.id !== input.id) throw Error("Quick Chat request no longer exists; its outcome is unknown.");
    return state.job.result;
  }
  const catalog = await scope.query.getOrFetch(symbols.models);
  if (identity().id !== account.id) throw Error("ChatGPT App account changed while loading models.");
  const options = (catalog?.options ?? []).map(o => ({
    id: JSON.stringify([o.slug, o.thinkingEffort ?? null]), label: o.selectedLabel || o.title,
    slug: o.slug, effort: o.thinkingEffort
  })).filter(o => typeof o.slug === "string" && typeof o.label === "string");
  if (!options.length) throw Error("ChatGPT App model presets are unavailable.");
  if (input.action === "status") return {accounts: [account], models: options.map(({id,label}) => ({id,label}))};
  const option = options.find(o => o.id === input.model);
  if (!option) throw Error("Model preset is no longer available. Refresh Quick Chat.");
  if (state.job?.result?.state === "pending") throw Error("A background Quick Chat request is already running.");
  const job = {id: input.id, result: {state: "pending"}};
  state.job = job;
  const controller = new AbortController();
  const client = scope.get(symbols.client);
  let streamRequestId;
  let text = "", messageId = "", conversationId = input.conversationId || "";
  const finish = (result) => { if (job.result.state === "pending") { clearTimeout(timer); job.result = result; } };
  const timer = setTimeout(() => {
    finish({state:"error", error:"Quick Chat timed out; start a new session before retrying."});
    controller.abort();
    if (streamRequestId) client.cancelStream(streamRequestId);
  }, 120000);
  const request = {
    action: "next", model: option.slug, parent_message_id: input.parentMessageId || crypto.randomUUID(),
    messages: [{id: crypto.randomUUID(), author: {role: "user"}, content: {content_type: "text", parts: [input.prompt]}}],
    history_and_training_disabled: true, conversation_mode: {kind: "primary_assistant"}, timezone_offset_min: new Date().getTimezoneOffset(),
    ...(option.effort ? {thinking_effort: option.effort} : {}),
    ...(input.conversationId ? {conversation_id: input.conversationId} : {})
  };
  try {
    if (identity().id !== input.accountId) throw Error("ChatGPT App account changed before sending.");
    Promise.resolve(client.startCompletionStream({
      request, startupSignal: controller.signal,
      onUpdate: update => {
        if (update.conversationId) conversationId = update.conversationId;
        const message = update.message;
        if (message?.author?.role === "assistant" && message.channel !== "analysis") {
          const parts = message.content?.parts;
          if (Array.isArray(parts)) { text = parts.filter(p => typeof p === "string").join("\n"); messageId = message.id; }
        }
      },
      onComplete: () => {
        try {
          if (identity().id !== input.accountId) throw Error("ChatGPT App account changed during the reply.");
          if (!text || !messageId || !conversationId) throw Error("ChatGPT returned no complete text reply.");
          finish({state: "complete", text, messageId, conversationId});
        } catch (error) { finish({state: "error", error: error.message}); }
      },
      onError: () => finish({state:"error", error:"ChatGPT could not complete this request. Start a new session before retrying."}),
      onPrematureTermination: () => finish({state:"error", error:"ChatGPT interrupted this request. Start a new session before retrying."})
    })).then(started => {
      streamRequestId = started?.streamRequestId;
      if (controller.signal.aborted && streamRequestId) client.cancelStream(streamRequestId);
    }).catch(() => finish({state:"error", error:"ChatGPT could not start this request."}));
  } catch (error) { finish({state:"error", error:error.message}); }
  return job.result;
}`;

function localEndpoint(value: string, protocol: string, port?: string) {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || url.username || url.password || (port && url.port !== port)) {
    throw new Error("Quick Chat debugging endpoint must use 127.0.0.1 on the configured port.");
  }
  return url;
}

class Connection {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private socket: WebSocket) {
    socket.on("message", data => {
      let message; try { message = JSON.parse(data.toString()); } catch { return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error("ChatGPT debugging request failed."));
      else entry.resolve(message.result);
    });
    const fail = () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("ChatGPT connection closed; the request outcome may be unknown.")); } this.pending.clear(); };
    socket.on("close", fail); socket.on("error", fail);
  }
  async evaluate(input: object): Promise<any> {
    const id = ++this.nextId;
    const result: any = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("ChatGPT background renderer did not respond.")); }, 15000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method: "Runtime.evaluate", params: {expression: `(${quickChatRuntime})(${JSON.stringify(input)})`, awaitPromise: true, returnByValue: true}}));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] || "ChatGPT adapter failed.");
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

export class DesktopQuickChatBridge implements QuickChatBridge {
  constructor(private endpoint = process.env.QUICK_CHAT_CDP_URL ?? "http://127.0.0.1:9222") {}
  private async connect(): Promise<Connection> {
    const endpoint = localEndpoint(this.endpoint, "http:");
    let targets: any[];
    try {
      const response = await fetch(new URL("/json/list", endpoint), {signal: AbortSignal.timeout(3000), redirect: "error"});
      if (!response.ok) throw new Error();
      targets = await response.json() as any[];
    } catch { throw new Error("ChatGPT App background connection is unavailable. Enable its local debugging port, then refresh Quick Chat."); }
    let lastError = "No supported ChatGPT renderer is available.";
    for (const target of targets) {
      if (target.type !== "page" || !/^(file:|app:|codex:)/.test(target.url ?? "") || !target.webSocketDebuggerUrl) continue;
      const url = localEndpoint(target.webSocketDebuggerUrl, "ws:", endpoint.port);
      const socket = new WebSocket(url, {handshakeTimeout: 3000});
      let connection: Connection | undefined;
      try {
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        connection = new Connection(socket);
        await connection.evaluate({action: "status"});
        return connection;
      } catch (error) { lastError = error instanceof Error ? error.message : lastError; if (connection) connection.close(); else socket.terminate(); }
    }
    throw new Error(lastError);
  }
  async status() {
    const connection = await this.connect();
    try { return await connection.evaluate({action:"status"}) as QuickChatStatus; }
    finally { connection.close(); }
  }
  async send(request: QuickChatRequest) {
    const connection = await this.connect();
    try {
      const id = crypto.randomUUID();
      let result = await connection.evaluate({...request, action:"send", id});
      const deadline = Date.now() + 125000;
      while (result?.state === "pending" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 300));
        result = await connection.evaluate({action:"poll", accountId: request.accountId, id});
      }
      if (result?.state !== "complete") throw new Error(result?.error || "Quick Chat did not complete; its outcome is unknown.");
      return {text: result.text, messageId: result.messageId, conversationId: result.conversationId};
    } finally { connection.close(); }
  }
}
