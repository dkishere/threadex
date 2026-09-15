---
name: codex-app-server
description: Use when working on tools/threadex features that need to talk directly to the local Codex App Server protocol, including listing Codex threads, resuming a thread, starting or steering turns, streaming app-server events, generating protocol schemas, or deciding between Codex App Server, Codex SDK, and workspace-agent MCP APIs.
---

# Codex App Server

Use this skill when `tools/threadex` needs deeper local Codex control than the `@openai/codex-sdk` `thread.runStreamed()` path provides.

## Choose The Right Surface

- **Codex App Server**: local JSON-RPC control plane for Codex threads, turns, approvals, history, file-system helpers, app/plugin/skill metadata, and streamed events.
- **Codex SDK**: best default for app-level automation and streamed turns when the threadex only needs to prompt Codex and render events.
- **`mcp__codex_apps__workspace_agents`**: manages saved workspace agents in Agent Studio. It does not control this live local Codex session and does not expose a generic prompt/run action here.

Do not treat workspace-agent `agent_id` values as local Codex session/thread IDs.

## App-Server Protocol

`codex app-server` speaks JSON-RPC-style messages without the `jsonrpc` field.

Supported transports in current Codex builds:

- stdio: `codex app-server`
- websocket: `codex app-server --listen ws://127.0.0.1:4500`
- unix socket: `codex app-server --listen unix://`

Always initialize before other requests:

```json
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"threadex","title":"Threadex","version":"0.1.0"}}}
{"method":"initialized","params":{}}
```

Common request flow:

```json
{"method":"thread/list","id":1,"params":{}}
{"method":"thread/resume","id":2,"params":{"threadId":"019f..."}}
{"method":"thread/start","id":3,"params":{"cwd":"/Volumes/dev","model":"gpt-5.4"}}
{"method":"turn/start","id":4,"params":{"threadId":"019f...","input":[{"type":"text","text":"Summarize this repo."}]}}
{"method":"turn/steer","id":5,"params":{"threadId":"019f...","input":[{"type":"text","text":"Focus only on server code."}]}}
{"method":"turn/interrupt","id":6,"params":{"threadId":"019f..."}}
```

After `turn/start`, keep reading server notifications such as:

- `thread/started`
- `turn/started`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `turn/completed`
- approval and tool-request messages

Handle server requests that require a response, especially approval prompts, before using app-server as an unattended backend.

## Schema Discovery

Generate schemas from the installed Codex version instead of hard-coding from memory:

```bash
codex app-server generate-json-schema --out /private/tmp/codex-app-server-schema
codex app-server generate-ts --out /private/tmp/codex-app-server-ts
```

Useful generated files:

- `ClientRequest.json`: client-to-server request methods and params.
- `ServerNotification.json`: streamed notification shapes.
- `ServerRequest.json`: server-to-client requests that need responses.
- `v2/ThreadStartParams.json`, `v2/TurnStartParams.json`, `v2/ThreadResumeParams.json`: core thread and turn inputs.

To extract request method names:

```bash
jq -r '.. | objects | select(((.title? // "") | type) == "string" and ((.title? // "") | test("RequestMethod$"))) | .enum[]?' /private/tmp/codex-app-server-schema/ClientRequest.json
```

## Local Probe

Use a harmless probe before wiring new UI/server behavior:

```bash
node -e 'const {spawn}=require("child_process"); const readline=require("readline"); const p=spawn("codex",["app-server"],{stdio:["pipe","pipe","pipe"]}); const rl=readline.createInterface({input:p.stdout}); const send=(m)=>p.stdin.write(JSON.stringify(m)+"\n"); let done=false; const finish=(why)=>{ if(done) return; done=true; console.log(why); p.kill(); }; p.stderr.on("data",d=>process.stderr.write(d)); rl.on("line",line=>{ console.log(line); let msg; try{msg=JSON.parse(line)}catch{return;} if(msg.id===0){ send({method:"initialized",params:{}}); send({method:"thread/list",id:1,params:{}}); } if(msg.id===1){ finish("thread/list completed"); } }); p.on("error",e=>finish("spawn error: "+e.message)); setTimeout(()=>finish("timeout"),10000); send({method:"initialize",id:0,params:{clientInfo:{name:"codex_probe",title:"Codex Probe",version:"0.1.0"}}});'
```

In sandboxed Codex runs this may fail with:

```text
failed to initialize sqlite state runtime under /Users/.../.codex
```

That means app-server needs access to the local Codex state directory. Request scoped escalation rather than changing `CODEX_HOME` or copying state.

## Implementation Notes For This App

- Keep the browser-facing API small; translate app-server events to a stable internal event shape in `src/server/`.
- Avoid exposing raw app-server control directly to the browser without an allowlist.
- Treat `turn/start` as potentially consequential: it can spend tokens and may request file or command approvals depending on sandbox and approval settings.
- Prefer `thread/list` and `thread/read` for read-only session browsing.
- Prefer the existing `@openai/codex-sdk` path for simple prompt/response streaming unless the feature needs app-server-only capabilities such as listing local Codex threads or resuming arbitrary local threads.
