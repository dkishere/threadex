import assert from "node:assert/strict";
import test from "node:test";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckCircle2, Loader2, Shrink } from "lucide-react";
import { isLiveItem } from "./appStreamProtocol";
import { LiveEvent, StatusUpdateIndicator as renderStatusUpdateIndicator } from "./sessionHelpers02";
import { messageIndicatorItemTitle } from "./sessionHelpers03";

const completedItem = {
  id: "compact-1",
  eventType: "item.completed",
  itemType: "context_compaction"
};

test("context compaction is accepted as a displayable live item", () => {
  assert.equal(isLiveItem(completedItem), true);
  assert.equal(messageIndicatorItemTitle({
    approvalShortText: () => "",
    compactIndicatorTitle: (value: string) => value,
    subagentNames: () => [],
    subagentToolLabel: () => "",
    summarizeFileChangeItem: () => ({ label: "" })
  }, completedItem), "Context compacted");
});

test("context compaction renders progress and completion labels", () => {
  function StatusUpdateIndicator({ text, spinning, completedIcon }: { text: string; spinning: boolean; completedIcon?: typeof Shrink }) {
    return renderStatusUpdateIndicator({ CheckCircle2, Loader2, _jsx, _jsxs }, { text, spinning, completedIcon });
  }
  const ctx = { _jsx, _jsxs, Shrink, StatusUpdateIndicator };

  const started = renderToStaticMarkup(LiveEvent(ctx, {
    item: { ...completedItem, eventType: "item.started" },
    sessionId: undefined
  }));
  const completed = renderToStaticMarkup(LiveEvent(ctx, { item: completedItem, sessionId: undefined }));

  assert.match(started, />Compacting context</);
  assert.match(started, /data-state="running"/);
  assert.match(started, /class="spin/);
  assert.match(completed, />Context compacted</);
  assert.match(completed, /data-state="completed"/);
  assert.doesNotMatch(completed, /class="spin/);
  assert.match(completed, /lucide-shrink/);
});
