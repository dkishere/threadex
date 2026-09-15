import assert from "node:assert/strict";
import test from "node:test";
import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsx, jsxs } from "react/jsx-runtime";
import { PlanStepTimeline, planStepStatus, planStepStatusLabel, nextActivePlanStepIndex, syncPlanSteps, CompletedTurn, removeLastTextSegment } from "./sessionHelpers01.js";

function renderPlan(completed: boolean, allDone = false) {
  return renderToStaticMarkup(PlanStepTimeline({
    CheckCircle2: () => null, ChevronRight: () => null, Circle: () => null,
    TimelineEntries: () => null, _jsx: jsx, _jsxs: jsxs,
    countTimelineLeafEntries: () => 0,
    nextActivePlanStepIndex: (steps: Array<{ completed: boolean }>) => steps.findIndex((step) => !step.completed),
    planStepStatus: (step: { completed: boolean }, index: number, activeIndex: number) => planStepStatus({}, step, index, activeIndex),
    planStepStatusLabel: (status: string) => planStepStatusLabel({}, status)
  }, { id: "plan", anchorPrefix: "turn", sessionId: "session", completed, steps: [
    { id: "one", text: "Inspect", completed: true, entries: [] },
    { id: "two", text: "Verify", completed: allDone, entries: [] }
  ] }));
}

test("live plan exposes progress and the active step", () => {
  const html = renderPlan(false);
  assert.match(html, /1\/2 completed/);
  assert.match(html, /<progress value="1" max="2"/);
  assert.match(html, /data-status="active" open/);
});

test("ended plan preserves unfinished work without showing an active step", () => {
  const html = renderPlan(true);
  assert.match(html, /1\/2 completed · Turn ended/);
  assert.match(html, /data-status="incomplete"/);
  assert.doesNotMatch(html, /data-status="active"/);
});


test("native plan selects the explicit active step instead of the first pending step", () => {
  const steps: Array<{ completed: boolean; status?: string }> = [];
  syncPlanSteps({}, steps, { id: "native", items: [
    { text: "Later", completed: false, status: "pending" },
    { text: "Now", completed: false, status: "in_progress" }
  ] });
  assert.equal(nextActivePlanStepIndex({}, steps), 1);
  syncPlanSteps({}, steps, { id: "native", items: [
    { text: "Later", completed: false, status: "pending" },
    { text: "Now", completed: true, status: "completed" }
  ] });
  assert.equal(nextActivePlanStepIndex({}, steps), -1);
  assert.equal(nextActivePlanStepIndex({}, [{ completed: false }]), 0);
});


test("fully completed native plan keeps its step titles and completion count visible", () => {
  const html = renderPlan(true, true);
  assert.match(html, /2\/2 completed/);
  assert.match(html, /Inspect/);
  assert.match(html, /Verify/);
  assert.equal((html.match(/data-status="done"/g) ?? []).length, 2);
});

test("completed turn restores a saved native plan absent from text segments without duplicating it", () => {
  const plan = { id: "native-plan:t1", itemType: "todo_list", items: [{ text: "Verified work", completed: true }] };
  const planSegment = { id: "live:plan", type: "live", item: plan };
  for (const hasPlanSegment of [false, true]) {
    const html = renderToStaticMarkup(CompletedTurn({
      _jsx: jsx, _jsxs: jsxs, _Fragment: Fragment,
      MarkdownContent: ({ children }: { children: string }) => jsx("p", { children }),
      TimelineEntries: ({ entries }: { entries: Array<typeof planSegment> }) => jsx("div", {
        children: entries.flatMap((entry) => entry.item.items.map((item) => item.text)).join(",")
      }),
      collectFileChanges: () => [], latestTurnIssueTracker: () => null,
      isDisplayableLiveItem: () => true, isDisplayableMessageSegment: () => true,
      liveItemKey: (item: { id: string }) => item.id,
      compactTimelineEntries: (segments: unknown[]) => segments,
      removeLastTextSegment: (segments: unknown[]) => removeLastTextSegment({}, segments),
      withTurnLevelStatus: (segments: unknown[]) => segments
    }, {
      message: { id: "response", content: "Finished", liveItems: [plan], segments: [
        ...(hasPlanSegment ? [planSegment] : []), { id: "final", type: "text", text: "Finished" }
      ] }, steerMessages: [], codexSessionId: undefined, sessionId: "session", workspaceId: undefined
    }));
    assert.equal((html.match(/Verified work/g) ?? []).length, 1);
    assert.match(html, /Finished/);
  }
});
