import { createRoot } from "react-dom/client";
import { ActorRoomPanel } from "../../src/client/ActorRoomPanel";
import { useActorRoom } from "../../src/client/actorRoomState";
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

function Fixture() {
  const state = useActorRoom("attachment-test");
  return <main className="app"><div className="chat" style={{ height: "100vh", width: "100vw" }}>
    <ActorRoomPanel workspaceId="attachment-test" roomState={state} actor={state.room?.actors[0]} onOpenSession={() => {}} />
  </div></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
