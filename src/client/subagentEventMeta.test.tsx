import assert from "node:assert/strict";
import test from "node:test";
import { useEffect, useRef, useState } from "react";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { awaitsActorBrief, SubagentEvent } from "./sessionHelpers02";
import { CurrentDomainActorsProvider } from "./CurrentDomainActorsContext";

const ctx = {
  ChevronRight: () => null, UserPlus: () => _jsx("span", { "data-native-agent-icon": true }), MarkdownContent: ({ children }: { children: string }) => _jsx("p", { children }),
  SubagentTranscript: () => null, _jsx, _jsxs, fetchSubagentTranscript: async () => ({}),
  formatSubagentStatus: (status: string) => status, subagentNames: (item: any) => [item.label].filter(Boolean),
  subagentStatusTone: () => "running", useEffect, useRef, useState
};

type Registry = { workspaceId: string; actors: { id: string; name: string; avatar?: string }[] };

function render(item: Record<string, unknown>, registry?: Registry | null, workspaceId = "default") {
  const Card = () => SubagentEvent(ctx, { item: { id: "toolu_1", itemType: "subagent", tool: "spawn_agent", status: "inProgress",
    label: "Group chat round table UI", receiverThreadIds: [], agents: [], ...item }, sessionId: "tx_1" });
  return renderToStaticMarkup(registry === undefined ? _jsx(Card, {}) : _jsx(CurrentDomainActorsProvider, {
    workspaceId, summary: registry, children: _jsx(Card, {})
  }));
}

test("a Claude actor sub-agent card shows the actual model and effort the runner recorded", () => {
  const html = render({ actualModel: "claude-opus-5-5", actualReasoningEffort: "medium" });
  assert.match(html, /<span>Model: claude-opus-5-5<\/span>/);
  assert.match(html, /<span>Effort: medium<\/span>/);
  assert.doesNotMatch(html, /not reported|unknown|Requested/);
});

test("a requested value that differs from the actual one stays visible", () => {
  const html = render({ model: "claude-haiku-5-5", actualModel: "claude-opus-5-5", actualReasoningEffort: "medium" });
  assert.match(html, /<span>Model: claude-opus-5-5<\/span>/);
  assert.match(html, /<span>Requested model: claude-haiku-5-5<\/span>/);
});

const actorBrief = "You are domain actor 輸入操作與介面體驗 (threadex-composer-ui), root threadex-composer-ui, a root actor.\n\nBounded actor memory: ui decisions";

test("a Claude actor child shows its actor context collapsed to the actor name", () => {
  const html = render({ prompt: "Coordination notes", actorContext: actorBrief });
  assert.match(html, /<details class="subagent-actor-context"><summary title="threadex-composer-ui"><span>Actor context<\/span><strong>Iris · 輸入操作與介面體驗<\/strong><\/summary><pre>/);
  assert.doesNotMatch(html, /subagent-actor-context" open/, "collapsed by default");
  assert.match(html, /<pre>[^<]*ui decisions<\/pre>/);
  assert.match(html, /Delegated task<\/span><p>Coordination notes<\/p>/, "the host's notes stay the delegated task");
});

test("a Codex actor brief moves from the delegated task into the actor context", () => {
  const html = render({ prompt: `[threadex-actor-assignment:actor_a2_b62911]\n${actorBrief}` });
  assert.match(html, /<strong>Iris · 輸入操作與介面體驗<\/strong>/);
  assert.doesNotMatch(html, /Delegated task|Prompt not provided/);
});

test("with nothing recorded the card says so and keeps the reason", () => {
  const html = render({});
  assert.match(html, /title="The runner recorded no requested or actual value[^"]*">Model: not reported/);
  assert.match(html, />Effort: not reported/);
});

test("an actor sub-agent header shows the actor name and avatar instead of its internal path", () => {
  const html = render({ label: "/root/actor_a2_9fd316", prompt: "[threadex-actor-assignment:x]\nYou are domain actor 輸入操作與介面體驗 (threadex-composer-ui), root x." });
  assert.match(html, /subagent-event-avatar/);
  assert.match(html, /<strong[^>]*>Iris · 輸入操作與介面體驗<\/strong>/);
  assert.doesNotMatch(html, /<strong[^>]*>\/root\//);
});

test("an unresolved internal agent path falls back to its last segment", () => {
  const html = render({ label: "/root/actor_a2_9fd316" });
  assert.match(html, /<strong title="\/root\/actor_a2_9fd316">actor_a2_9fd316<\/strong>/);
});

test("a collapsed Codex actor child reads its brief up front; other cards wait for expansion", () => {
  assert.equal(awaitsActorBrief("/root/actor_a2_9fd316", []), true);
  assert.equal(awaitsActorBrief("actor_a2_9fd316", []), true);
  assert.equal(awaitsActorBrief("/root/actor_a2_9fd316", [actorBrief]), false, "an identity already on the card needs no fetch");
  assert.equal(awaitsActorBrief("Group chat round table UI", []), false);
  assert.equal(awaitsActorBrief("/root/check", []), false);
});

const oldDataBrief ="You are domain actor Ada · Data Models and API Contracts (data-models), root data-models.\nHistorical brief remains unchanged.";
const dataCard = { label: "/root/actor_data", actorContext: oldDataBrief, prompt: "Keep this delegated prompt." };
const rin = { id: "data-models", name: "Rin Tohsaka · Data Models and APIs", avatar: "https://example.test/rin.webp" };
const cardHeader = (html: string) => html.match(/<summary class="subagent-event-header">([\s\S]*?)<\/summary>/)?.[1] ?? "";

test("the current registry replaces an old actor header and renders its saved avatar without rewriting history", () => {
  const html = render(dataCard, { workspaceId: "default", actors: [rin] });
  const header = cardHeader(html);
  assert.match(header, /<strong[^>]*>Rin Tohsaka · Data Models and APIs<\/strong>/);
  assert.match(header, /<img src="https:\/\/example.test\/rin.webp" alt=""/);
  assert.doesNotMatch(header, /Ada|<svg|data-native-agent-icon/);
  assert.ok(html.includes(`<pre>${oldDataBrief}</pre>`), "the original actor context is retained verbatim");
  assert.match(html, /<p>Keep this delegated prompt\.<\/p>/);
});

test("an actor with an already current name also receives the registry avatar", () => {
  const anya = { id: "threadex-composer-ui", name: "安妮亞 · 介面體驗", avatar: "https://example.test/anya.webp" };
  const html = render({ actorContext: `You are domain actor ${anya.name} (${anya.id}), root x.` }, { workspaceId: "threadex", actors: [anya] }, "threadex");
  assert.match(cardHeader(html), /<strong[^>]*>安妮亞 · 介面體驗<\/strong>/);
  assert.match(cardHeader(html), /<img src="https:\/\/example.test\/anya.webp"/);
  assert.doesNotMatch(cardHeader(html), /<svg/);
});

test("registry refreshes change the header and workspace switches reject a stale summary even for the same actor ID", () => {
  const registry = { workspaceId: "default", actors: [rin] };
  const updated = { ...rin, name: "Rin updated", avatar: "https://example.test/rin-v2.webp" };
  const fresh = cardHeader(render(dataCard, { ...registry, actors: [updated] }));
  assert.match(fresh, />Rin updated<\/strong>/);
  assert.match(fresh, /rin-v2.webp/);
  assert.doesNotMatch(fresh, /Rin Tohsaka/);
  const switching = cardHeader(render(dataCard, registry, "threadex"));
  assert.match(switching, />Ada · Data Models and API Contracts<\/strong>/);
  assert.doesNotMatch(switching, /Rin|<img/);
  const nextWorkspace = cardHeader(render(dataCard, { workspaceId: "threadex", actors: [{ ...updated, name: "本 workspace actor" }] }, "threadex"));
  assert.match(nextWorkspace, />本 workspace actor<\/strong>/);
  assert.doesNotMatch(nextWorkspace, /Rin/);
});

test("missing providers, loading summaries and deleted actors retain the snapshot and Bot fallback", () => {
  for (const registry of [undefined, null, { workspaceId: "default", actors: [] }]) {
    const header = cardHeader(render(dataCard, registry));
    assert.match(header, />Ada · Data Models and API Contracts<\/strong>/);
    assert.match(header, /subagent-event-avatar[^]*<svg/);
    assert.doesNotMatch(header, /<img/);
  }
});

test("a current actor without an avatar still updates its name and uses a Bot fallback", () => {
  const header = cardHeader(render(dataCard, { workspaceId: "default", actors: [{ id: rin.id, name: rin.name }] }));
  assert.match(header, />Rin Tohsaka · Data Models and APIs<\/strong>/);
  assert.match(header, /<svg/);
  assert.doesNotMatch(header, /<img/);
});

test("native agents without an actor brief retain their name and UserPlus even when the registry has a matching name", () => {
  const header = cardHeader(render({ label: rin.name }, { workspaceId: "default", actors: [rin] }));
  assert.match(header, />Rin Tohsaka · Data Models and APIs<\/strong>/);
  assert.match(header, /data-native-agent-icon="true"/);
  assert.doesNotMatch(header, /subagent-event-avatar|<img/);
});
