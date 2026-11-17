import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SideChatPanel } from "../../src/client/SideChatPanel";
import type { ResponseAnnotation } from "../../src/client/responseAnnotations";
import "../../src/client/styles/app-01.css";
import "../../src/client/styles/app-04.css";
import "../../src/client/styles/app-11.css";

// Mirrors ThreadexShell: the side chat stays mounted and is merely hidden while another session tab is shown.
function Harness() {
  const [tab, setTab] = useState<"turns" | "side-chat">("turns");
  const [sessionId, setSessionId] = useState("side-a");
  const [annotations, setAnnotations] = useState<ResponseAnnotation[]>([]);
  return <div className="chat" data-session-tab={tab} style={{ position: "fixed", inset: 0, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
    <nav>
      <button onClick={() => setTab("turns")}>Turns tab</button>
      <button onClick={() => setTab("side-chat")}>Side chat tab</button>
      <button onClick={() => setSessionId(current => current === "side-a" ? "side-b" : "side-a")}>Switch session</button>
      <button onClick={() => setAnnotations(current => [...current, { text: `excerpt ${current.length + 1}`, annotation: `comment ${current.length + 1}` }])}>Add annotation</button>
    </nav>
    <div className="session-side-chat-view" hidden={tab !== "side-chat"} style={{ gridRow: 2 }}>
      <SideChatPanel key={sessionId} active={tab === "side-chat"} sessionId={sessionId} sessionReady
        annotations={annotations}
        onRemoveAnnotation={index => setAnnotations(current => current.filter((_, item) => item !== index))}
        onClearAnnotations={() => setAnnotations([])}
        CompletedTurn={({ message }) => <div style={{ minHeight: 160 }}>{message.content}</div>} />
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
