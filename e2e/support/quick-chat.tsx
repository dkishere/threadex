import { createRoot } from "react-dom/client";
import { QuickChatPanel } from "../../src/client/QuickChatPanel";
import "../../src/client/styles/app-01.css";
import "../../src/client/styles/app-02.css";
import "../../src/client/styles/app-03.css";
import "../../src/client/styles/app-04.css";
import "../../src/client/styles/app-05.css";
import "../../src/client/styles/app-06.css";
import "../../src/client/styles/app-07.css";
import "../../src/client/styles/app-08.css";
import "../../src/client/styles/app-09.css";
import "../../src/client/styles/app-10.css";
import "../../src/client/styles/app-11.css";

createRoot(document.getElementById("root")!).render(<div className="session-side-chat-view" style={{height:"100vh"}}><QuickChatPanel active /></div>);
