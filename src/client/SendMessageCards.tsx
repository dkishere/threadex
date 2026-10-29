import type { ComponentType } from "react";
import { Send } from "lucide-react";
import {
  isLongSendMessage,
  sendMessageSenderLabel,
  sendMessageStatusLabel,
  sendMessageTone,
  type SendMessageView
} from "./sendMessageView";

function messageTime(at?: string) {
  const time = at ? new Date(at) : null;
  return time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

type Markdown = ComponentType<{ children: string }>;

/** One SendMessage call: sender → recipient, status, time, summary and a collapsible message body. */
export function SendMessageCard({ view, ownAgentIds = [], ownName, Markdown }: { view: SendMessageView; ownAgentIds?: readonly string[]; ownName?: string; Markdown: Markdown }) {
  const { record } = view;
  const tone = sendMessageTone(view);
  const time = messageTime(record.completedAt ?? record.at);
  const body = record.message ? (
    <div className="send-message-body">
      <Markdown>{record.message}</Markdown>
      {record.messageTruncated && (
        <p className="send-message-truncated">Message truncated{record.omittedMessageChars ? `: ${record.omittedMessageChars.toLocaleString()} characters omitted` : ""}.</p>
      )}
    </div>
  ) : null;
  return (
    <article className="send-message-card" data-status={tone} data-tool-use-id={record.toolUseId}>
      <header className="send-message-header">
        <Send aria-hidden="true" />
        <span className="send-message-route">
          <strong>{sendMessageSenderLabel(record, ownAgentIds, ownName)}</strong>
          <span aria-hidden="true"> → </span>
          <strong title={record.recipientAgentId}>{record.to}</strong>
        </span>
        {time && <time dateTime={record.completedAt ?? record.at}>{time}</time>}
        <span className="send-message-status">{sendMessageStatusLabel(view)}</span>
      </header>
      {record.summary && <p className="send-message-summary">{record.summary}</p>}
      {body && (isLongSendMessage(record.message)
        ? <details className="send-message-details"><summary>Show message ({record.message.length.toLocaleString()} chars)</summary>{body}</details>
        : body)}
      {record.resultSummary && <p className="send-message-result" data-status={tone}>{record.resultSummary}</p>}
    </article>
  );
}

export function SendMessageList({ views, ownAgentIds, ownName, Markdown }: { views: readonly SendMessageView[]; ownAgentIds?: readonly string[]; ownName?: string; Markdown: Markdown }) {
  if (views.length === 0) return null;
  return (
    <section className="send-message-list" aria-label="Messages">
      {views.map((view) => <SendMessageCard key={view.record.toolUseId} view={view} ownAgentIds={ownAgentIds} ownName={ownName} Markdown={Markdown} />)}
    </section>
  );
}
