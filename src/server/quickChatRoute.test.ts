import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QuickChatService } from "./quickChatRoute";
import { quickChatRuntime, type QuickChatBridge, type QuickChatRequest } from "./quickChatBridge";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "threadex-quick-chat-"));
  const path = join(directory, "sessions.json");
  const requests: QuickChatRequest[] = [];
  const bridge: QuickChatBridge = {
    async status() { return {accounts:[{id:"account-a",label:"A"}], models:[{id:"preset",label:"Thinking"}]}; },
    async send(request) { requests.push(request); return {text:"Reply", conversationId:"conversation", messageId:`reply-${requests.length}`}; }
  };
  return {path, bridge, requests, service:new QuickChatService(path, bridge), cleanup:() => rmSync(directory, {recursive:true, force:true})};
}
const message = {accountId:"account-a", model:"preset", prompt:"Hello"};

test("Quick Chat persists sessions and continues with the returned conversation and parent", async () => {
  const f = fixture();
  try {
    const first = await f.service.send(message);
    const restored = new QuickChatService(f.path, f.bridge);
    const next = await restored.send({...message, sessionId:first.id, prompt:"Continue"});
    assert.equal(next.messages.length, 4);
    assert.equal(f.requests[1].conversationId, "conversation");
    assert.equal(f.requests[1].parentMessageId, "reply-1");
    assert.equal(restored.list("account-b").length, 0);
    assert.equal("conversationId" in next, false);
  } finally { f.cleanup(); }
});

test("Quick Chat rejects cross-account sessions and arbitrary model presets before dispatch", async () => {
  const f = fixture();
  try {
    const session = await f.service.send(message);
    await assert.rejects(f.service.send({...message, sessionId:session.id, accountId:"account-b"}), /does not belong/);
    await assert.rejects(f.service.send({...message, accountId:"account-b"}), /not connected/);
    await assert.rejects(f.service.send({...message, model:"custom"}), /preset is unavailable/);
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});

test("interrupted requests survive restart and cannot silently resume uncertain history", async () => {
  const f = fixture();
  try {
    f.bridge.send = async () => { throw new Error("Connection lost"); };
    await assert.rejects(f.service.send(message), /Connection lost/);
    const restored = new QuickChatService(f.path, f.bridge);
    const [session] = restored.list("account-a");
    assert.equal(session.interrupted, true);
    assert.equal(session.messages[0].text, "Hello");
    await assert.rejects(restored.send({...message, sessionId:session.id}), /interrupted request/);
  } finally { f.cleanup(); }
});

test("simultaneous requests do not dispatch overlapping App streams", async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.bridge.send = async () => { await new Promise<void>(resolve => { release = resolve; }); return {text:"Reply", conversationId:"c", messageId:"m"}; };
    const first = f.service.send(message);
    await assert.rejects(f.service.send(message), /already being sent/);
    release();
    await first;
  } finally { f.cleanup(); }
});

test("renderer adapter reads immutable presets, checks identity and sends without changing UI", async () => {
  const token = {};
  let accountId = "a";
  let dispatched: any;
  const module = {Een:token, sXt:"auth", CSt:"models", TDt:"client"};
  const scope = {
    scope:token, set() { throw new Error("UI state must not be changed"); },
    get(atom: string) {
      if (atom === "auth") return {authenticatedAccountId:accountId, userId:"u", email:"test@example.invalid", requiresAuth:false};
      return {startCompletionStream(options: any) {
        dispatched = options.request;
        queueMicrotask(() => {
          options.onUpdate({conversationId:"c", message:{id:"m", author:{role:"assistant"}, channel:"final", content:{parts:["OK"]}}});
          options.onComplete();
        });
        return Promise.resolve();
      }};
    },
    query: {async getOrFetch() { return {options:[{slug:"model", title:"Thinking", thinkingEffort:"extended"}]}; }}
  };
  const document = {visibilityState:"visible", scripts:[{src:"app://-/assets/app-initial-b21bd554b363.js"}], querySelector:() => ({__reactContainerTest:{memoizedState:{memoizedState:scope}}})};
  const performance = {getEntriesByType:() => [{name:"app://-/assets/app-initial-b21bd554b363.js"}]};
  const globals = {};
  const run = new Function("input", "fixtureModule", "document", "performance", "globalThis", `return (${quickChatRuntime.replace("await import(asset)", "fixtureModule")})(input)`);
  const invoke = (input: object) => run(input, module, document, performance, globals);
  const status = await invoke({action:"status"});
  assert.deepEqual(status.models, [{id:'["model","extended"]',label:"Thinking"}]);
  await assert.rejects(invoke({action:"send", accountId:"wrong"}), /account changed/);
  await invoke({action:"send", accountId:status.accounts[0].id, model:status.models[0].id, prompt:"Hello", id:"job"});
  const reply = await invoke({action:"poll", accountId:status.accounts[0].id, id:"job"});
  assert.equal(reply.text, "OK");
  assert.equal(dispatched.history_and_training_disabled, true);
  assert.equal(dispatched.thinking_effort, "extended");
  const currentBuildModule = {Xpn:token, Vin:"auth", azt:"models", zUt:"client"};
  document.scripts[0].src = "app://-/assets/app-initial-c72822ce2409.js";
  const currentBuild = await run({action:"status"}, currentBuildModule, document, performance, {});
  assert.equal(currentBuild.accounts.length, 1);
  document.scripts[0].src = "app://-/assets/app-initial-b21bd554b363.js";
  accountId = "b";
  await assert.rejects(invoke({action:"poll", accountId:status.accounts[0].id, id:"job"}), /account changed/);
  assert.equal(document.visibilityState, "visible");
});
