import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ActorRoomPanel } from "../../src/client/ActorRoomPanel";
import { useActorRoom } from "../../src/client/actorRoomState";
import { WorkspaceManagerView } from "../../src/client/WorkspaceManagerPanel";
import { App } from "../../src/client/App";
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
import "../../src/client/styles/responsive.css";

function ActorFixture() {
  const [workspaceId, setWorkspaceId] = useState("actors-test");
  const actorId = new URLSearchParams(location.search).get("actorId");
  // An actor view shares the full room; a group chat reads its own server-partitioned `room?chat=`.
  const roomState = useActorRoom(workspaceId, { enabled: !!actorId });
  const chatKey = new URLSearchParams(location.search).get("chat") ?? undefined;
  return <div className="app responsive-layout" data-left-open="false" data-middle-open="false">
  <WorkspaceManagerView className="chat" data-session-tab="dashboard">
    <header className="content-header"><h1>Workspace manager</h1></header>
    {new URLSearchParams(location.search).has("project-test") && <button onClick={() => setWorkspaceId("other-workspace")}>Switch workspace</button>}
    <ActorRoomPanel workspaceId={workspaceId} roomState={actorId ? roomState : undefined} chatKey={chatKey} actor={roomState.room?.actors.find(actor => actor.id === actorId)} onOpenSession={id => { document.body.dataset.openedSession = id; }} />
  </WorkspaceManagerView>
</div>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("shell") ? <App /> : <ActorFixture />);
