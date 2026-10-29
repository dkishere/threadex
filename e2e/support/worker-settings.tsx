import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AgentActorsSettingsPanel } from "../../src/client/AgentActorsSettingsPanel";
import "../../src/client/styles/app-01.css";
import "../../src/client/styles/app-02.css";
import "../../src/client/styles/app-03.css";
import "../../src/client/styles/app-04.css";
import "../../src/client/styles/app-05.css";
import "../../src/client/styles/app-06.css";
import "../../src/client/styles/app-07.css";
import "../../src/client/styles/app-08.css";
import "../../src/client/styles/responsive.css";

function Fixture() {
  const [workspaceId, setWorkspaceId] = useState("workspace");
  return <><button onClick={() => setWorkspaceId(id => id === "workspace" ? "other" : "workspace")}>Switch workspace</button>
    <AgentActorsSettingsPanel workspaceId={workspaceId} workspaceName={workspaceId} summary={null} error={null} authRequired={false}
      onSelectActor={id => { document.body.dataset.openedActor = id; }} onOpenRoom={chatKey => { document.body.dataset.openedRoom = chatKey; }} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
