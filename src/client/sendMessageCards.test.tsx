import assert from "node:assert/strict";
import test from "node:test";
import { useEffect, useRef, useState } from "react";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentEvent } from "./sessionHelpers02";
import { compactTimelineEntries } from "./sessionHelpers01";
import { collectSendMessages } from "./sendMessageView";
import { SEND_MESSAGE_TEXT_MAX_CHARS } from "../eventProtocol";

const ctx = {
  ChevronRight: () => null, UserPlus: () => null, MarkdownContent: ({ children }: { children: string }) => _jsx("p", { children }),
  SubagentTranscript: () => null, _jsx, _jsxs, fetchSubagentTranscript: async () => ({}),
  formatSubagentStatus: (status: string) => status, subagentNames: (item: any) => [item.label].filter(Boolean),
  subagentStatusTone: () => "running", useEffect, useRef, useState
};

function record(over: Record<string, unknown> = {}) {
  return { toolUseId: "toolu_msg", sender: { kind: "main" }, to: "researcher", recipientAgentId: "toolu_agent",
    summary: "Ask for status", message: "How far along are you?", status: "sent", resultSummary: "Message delivered",
    at: "2026-10-28T01:00:00.000Z", completedAt: "2026-10-28T01:00:02.000Z", ...over };
}

function messageItem(rec: any, over: Record<string, unknown> = {}) {
  return { id: rec.toolUseId, eventType: "item.completed", itemType: "subagent", tool: "send_message",
    status: rec.status === "failed" ? "failed" : "completed", label: rec.summary, prompt: rec.message,
    receiverThreadIds: rec.recipientAgentId ? [rec.recipientAgentId] : [],
    agents: [{ id: rec.recipientAgentId ?? rec.to, name: rec.to, status: "completed", message: rec.resultSummary }],
    sendMessage: rec, ...over };
}

function spawn() {
  return { id: "toolu_agent", eventType: "item.started", itemType: "subagent", tool: "spawn_agent", status: "inProgress",
    label: "Researcher", prompt: "Research it", receiverThreadIds: [], agents: [{ id: "toolu_agent", name: "researcher", status: "running" }] };
}

function html(item: any) {
  const Card = () => SubagentEvent(ctx, { item, sessionId: "tx_1" });
  return renderToStaticMarkup(_jsx(Card, {}));
}

function entries(items: any[]) {
  return compactTimelineEntries({ compactLiveItemGroup: () => null }, items.map((item) => ({ type: "live", id: item.id, item })));
}

test("a message to a known agent joins the recipient card without renaming or re-status-ing it", () => {
  const [entry, ...rest] = entries([spawn(), messageItem(record())]);
  assert.equal(rest.length, 0);
  assert.equal(entry.item.label, "Researcher");
  assert.equal(entry.item.status, "running", "the spawn agent's status, not the message's");
  const out = html(entry.item);
  assert.match(out, /Main session<\/strong><span aria-hidden="true"> → <\/span><strong title="toolu_agent">researcher/);
  assert.match(out, /Ask for status/);
  assert.match(out, /How far along are you\?/);
  assert.match(out, /Message delivered/);
  assert.match(out, /Sent<\/span>/);
  assert.doesNotMatch(out, /Follow-up task/, "message text is not a delegated task");
  assert.doesNotMatch(out, /Returned content/);
});

test("a message with no known recipient card stands alone, even without a summary", () => {
  const rec = record({ recipientAgentId: undefined, summary: undefined, to: "team-lead" });
  const [entry, ...rest] = entries([messageItem(rec, { label: undefined })]);
  assert.equal(rest.length, 0);
  const out = html(entry.item);
  assert.match(out, /send-message-card/);
  assert.match(out, /team-lead/);
  assert.doesNotMatch(out, /subagent-event"/);
});

test("long messages are collapsed and truncation is labelled", () => {
  const long = "x".repeat(SEND_MESSAGE_TEXT_MAX_CHARS + 500);
  const [entry] = entries([messageItem(record({ message: long, messageTruncated: true, omittedMessageChars: 500 }))]);
  const out = html(entry.item);
  assert.match(out, /<details class="send-message-details"><summary>Show message/);
  assert.doesNotMatch(out, /send-message-details" open/);
  assert.match(out, /Message truncated: \d[\d,]* characters omitted/);
  assert.match(html(entries([messageItem(record())])[0].item), /How far along/);
  assert.doesNotMatch(html(entries([messageItem(record())])[0].item), /send-message-details/, "short messages are not collapsed");
});

test("failed and declined messages are marked", () => {
  const failed = html(entries([messageItem(record({ status: "failed", resultSummary: "Unknown recipient" }))])[0].item);
  assert.match(failed, /data-status="error"/);
  assert.match(failed, /Failed<\/span>/);
  assert.match(failed, /Unknown recipient/);
  const declined = html(entries([messageItem(record({ status: "failed" }), { status: "declined" })])[0].item);
  assert.match(declined, /Declined<\/span>/);
});

test("missing fields fall back instead of throwing", () => {
  const bad = { ...messageItem(record()), sendMessage: { toolUseId: "x" } };
  assert.deepEqual(collectSendMessages([bad]), []);
  assert.deepEqual(collectSendMessages([{ id: "a", itemType: "command_execution", command: "SendMessage {...}" }]), []);
  const minimal = record({ summary: undefined, resultSummary: undefined, completedAt: undefined, recipientAgentId: undefined });
  const out = html(entries([messageItem(minimal, { label: undefined })])[0].item);
  assert.match(out, /How far along/);
  assert.doesNotMatch(html({ ...spawn(), sendMessage: undefined }), /send-message/, "old sessions render as before");
});

test("duplicate frames and activity events for one tool_use id show one card", () => {
  const started = messageItem(record({ status: "pending", resultSummary: undefined, completedAt: undefined }), { eventType: "item.started", status: "inProgress" });
  const done = messageItem(record());
  const event = { agentId: "toolu_agent", source: "claude" as const, kind: "send_message" as const, at: "2026-10-28T01:00:02.000Z", seq: 3, sendMessage: record() as any };
  const views = collectSendMessages([started, done, done], [event]);
  assert.equal(views.length, 1);
  assert.equal(views[0].record.status, "sent");
  const [entry] = entries([spawn(), started, done]);
  assert.equal((html(entry.item).match(/class="send-message-card"/g) ?? []).length, 1);
  assert.equal(collectSendMessages([done, started])[0].record.status, "sent", "a late pending frame never downgrades the result");
});

test("a sub-agent's own send_message activity is shown in its card with the card name as sender", () => {
  const rec = record({ sender: { kind: "subagent", agentId: "toolu_agent" }, to: "reviewer", recipientAgentId: undefined });
  const views = collectSendMessages([], [{ agentId: "toolu_agent", source: "claude", kind: "send_message", at: rec.at, seq: 1, sendMessage: rec as any }]);
  assert.equal(views.length, 1);
  assert.equal(views[0].record.sender.kind, "subagent");
});
