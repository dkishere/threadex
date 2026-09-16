import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useState } from "react";
import { CompletedTurn, MessageTimeline } from "../../src/client/ThreadexApp";
import { deferSnapshotWrite } from "../../src/client/deferredSnapshot";
import { normalizeMessageStartupSnapshots, writeStoredSession } from "../../src/client/sessionHelpers03";
import "../../src/client/styles/app-05.css";
import "../../src/client/styles/app-07.css";

let detailReads = 0;
let cacheWrites = 0;
const persist = new URLSearchParams(location.search).has("persistence");
const comments = Array.from({ length: 150 }, (_, index) => ({
  id: `comment-${index}`, type: "live", item: {
    id: `comment-${index}`, itemType: "agent_message", eventType: "item.completed", text: "",
    comment: {
      extracts: [{ type: "action", shortMsg: `Finished action ${index}` }],
      get detail() { detailReads++; return `Detail ${index}\n\n${"Long **hidden** detail.\n\n".repeat(30)}`; }
    }
  }
}));
const commands = comments.map((_, index) => ({
  id: `command-${index}`, type: "live", item: {
    id: `command-${index}`, itemType: "command_execution", eventType: "item.completed",
    command: `echo task-${index}`, exitCode: 0, aggregatedOutput: `Output ${index}\n${"x".repeat(20_000)}`
  }
}));
let prefix = comments.flatMap((comment, index) => [comment, commands[index]]);
const finalAnswer = new URLSearchParams(location.search).has("final");
let text = "[Stable link](https://example.com)\n\n" + (finalAnswer
  ? Array.from({ length: 10 }, (_, index) => `Paragraph ${index}: **verified** the result and checked the implementation. The existing behaviour is preserved.\n\n`).join("") + "| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst n = 1;\n```\n\n"
  : "") + "Streaming";
let segments = [...prefix, { id: "tail", type: "text", text }];
let publish: (value: typeof segments) => void;
let complete: (message: any) => void;
function Fixture() {
  const [current, setCurrent] = useState(segments);
  const [input, setInput] = useState("");
  const [finalMessage, setFinalMessage] = useState<any>(null);
  publish = setCurrent;
  complete = setFinalMessage;
  useEffect(() => {
    if (!persist) return;
    return deferSnapshotWrite(() => {
      cacheWrites++;
      writeStoredSession({ STORAGE_KEY: "timeline-fixture", normalizeMessageStartupSnapshots: (messages: any[]) => normalizeMessageStartupSnapshots({}, messages) }, {
        messages: [{ id: "fixture", role: "assistant", content: current.at(-1)?.text, segments: current }]
      });
    });
  }, [current]);
  return <>
    <input aria-label="Typing probe" value={input} onChange={(event) => setInput(event.target.value)} />
    {finalMessage ? <CompletedTurn message={finalMessage} steerMessages={[]} sessionId="fixture" />
      : <MessageTimeline segments={current} running anchorPrefix="fixture" sessionId="fixture" turnId="fixture" />}
  </>;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Fixture />));
Object.assign(window, { timelineFixture: {
  resetReads() { detailReads = 0; },
  reads() { return detailReads; },
  resetWrites() { cacheWrites = 0; localStorage.removeItem("timeline-fixture"); },
  writes() { return cacheWrites; },
  textLength() { return text.length; },
  finish() {
    const start = performance.now();
    flushSync(() => complete({ id: "fixture", turnId: "fixture", content: text, conclusion: text, segments, liveItems: prefix.map((segment) => segment.item) }));
    return performance.now() - start;
  },
  append(value = " next") {
    text += value;
    segments = [...prefix, { id: "tail", type: "text", text }];
    const start = performance.now();
    flushSync(() => publish(segments));
    return performance.now() - start;
  },
  updateCommand() {
    prefix = prefix.map((segment) => segment.id === "command-0"
      ? { ...segment, item: { ...segment.item, aggregatedOutput: "Updated command output" } } : segment);
    this.append();
  }
} });
