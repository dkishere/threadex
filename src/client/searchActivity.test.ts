import assert from "node:assert/strict";
import test from "node:test";
import type { LiveItem } from "./appTypes.js";
import { actionGroupTitle, compactLiveItemGroup, compactTimelineEntries } from "./sessionHelpers01.js";

function search(id: string): LiveItem {
  return { id, itemType: "web_search", eventType: "item.completed", query: `query ${id}` };
}

test("compacts consecutive web searches into one search action group", () => {
  const compactGroup = (item: LiveItem) => compactLiveItemGroup({ isCommandLiveItem: () => false }, item);
  const entries = compactTimelineEntries({ compactLiveItemGroup: compactGroup }, [
    { id: "live:search-1", type: "live", item: search("search-1") },
    { id: "live:search-2", type: "live", item: search("search-2") }
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, "action_group");
  assert.equal(entries[0]?.groupType, "search");
  assert.equal(entries[0]?.items.length, 2);
  assert.equal(
    actionGroupTitle(
      { collectFileChanges: () => [], subagentNames: () => [] },
      entries[0]?.items.map(({ item }: { item: LiveItem }) => item),
      "search"
    ),
    "Searched 2 queries"
  );
});
