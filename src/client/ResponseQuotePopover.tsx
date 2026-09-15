import { Quote } from "lucide-react";
import type { ResponseAnnotation } from "./responseAnnotations";

export function ResponseQuotePopover({ quote, onChange, onAsk, onAskSideChat }: {
  quote: ResponseAnnotation & { left: number; top: number };
  onChange: (quote: ResponseAnnotation & { left: number; top: number }) => void;
  onAsk: () => void;
  onAskSideChat?: () => void;
}) {
  return <div className="response-quote-popover" style={{ left: quote.left, top: quote.top }} role="dialog" aria-label="Ask about selected response text" onMouseUp={(event) => event.stopPropagation()}>
    <Quote aria-hidden="true" />
    <span>{quote.text}</span>
    <textarea aria-label="Annotation (optional)" placeholder="Add a note or question (optional)…" rows={2} value={quote.annotation ?? ""} onChange={(event) => onChange({ ...quote, annotation: event.target.value })} />
    <button type="button" onClick={onAsk}>Ask</button>
    {onAskSideChat && <button type="button" onClick={onAskSideChat}>Ask side chat</button>}
  </div>;
}
