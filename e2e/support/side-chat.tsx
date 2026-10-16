import { createRoot } from "react-dom/client";
import { SideChatPanel } from "../../src/client/SideChatPanel";

createRoot(document.getElementById("root")!).render(<SideChatPanel active sessionReady sessionId="side-test"
  CompletedTurn={({ message }) => <div>{message.content}</div>} />);
