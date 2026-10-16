import { createRoot } from "react-dom/client";
import { RoundtableSettings, useRoundtable } from "../../src/client/Roundtable";
import { SideChatPanel } from "../../src/client/SideChatPanel";
import { DEFAULT_MODEL } from "../../src/modelCatalog";
import "../../src/client/styles/app-11.css";

function Example() {
  const roundtable = useRoundtable({ sessionId: null, workspaceId: "picker-test", gearProfiles: [{ model: DEFAULT_MODEL, effort: "high" }], onChanged: () => {} });
  return <main style={{ padding: 24, fontFamily: "system-ui" }}>
    <button onClick={() => void roundtable.toggle()}>Enable round table</button>
    <div className="content-header-actions" style={{ display: "flex", justifyContent: "flex-end" }} />
    <RoundtableSettings controller={roundtable} />
    <div className="session-side-chat-view" style={{ maxWidth: 480, height: 600, marginTop: 24 }}><SideChatPanel active sessionReady sessionId="side-test"
      CompletedTurn={({ message }) => <div>{message.content}</div>} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Example />);
