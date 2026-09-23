import { Globe2 } from "lucide-react";

type UrlTagIconProps = {
  url?: string | null;
  className?: string;
};

export function isCodexUrl(url?: string | null) {
  return /^(codex|threadex):\/\//i.test(url?.trim() ?? "");
}

/** A shared leading icon for every URL chip, in the composer and sent messages. */
export function UrlTagIcon({ url, className = "url-tag-icon" }: UrlTagIconProps) {
  if (isCodexUrl(url)) {
    return <ChatGptMark className={`${className} url-tag-chatgpt-icon`} />;
  }
  return <Globe2 className={`${className} url-tag-web-icon`} aria-hidden="true" data-url-kind="web" />;
}

function ChatGptMark({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" data-url-kind="chatgpt">
      <path d="M12 3.1a4.3 4.3 0 0 1 6.1 4.08 4.3 4.3 0 0 1 2.3 6.96 4.3 4.3 0 0 1-5.15 5.12A4.3 4.3 0 0 1 8.3 20.3a4.3 4.3 0 0 1-4.7-5.8A4.3 4.3 0 0 1 5.9 7.1 4.3 4.3 0 0 1 12 3.1Z" />
      <path d="M8.02 5.53 12 7.82v4.6l-3.98 2.3m3.98-7.25 3.98-2.3m0 4.6-3.98 2.3m3.98-2.3v4.6L12 16.67m-3.98-1.85v4.6" />
    </svg>
  );
}
