import { createRoot } from "react-dom/client";
import { SessionOwnerBadges } from "../../src/client/SessionOwnerBadges";
import "../../src/client/styles/responsive.css";
import "../../src/client/ManagerWorkspace.css";
// Feature styles load before main.tsx's base sheets in the real application.
import "../../src/client/styles/app-01.css";
import "../../src/client/styles/app-04.css";
import "../../src/client/styles/app-11.css";

const parameters = new URLSearchParams(location.search);
const title = parameters.get("title") ?? "Short title";
const embedded = parameters.has("embedded");
const panelWidth = Number(parameters.get("panelWidth")) || undefined;
const header = <section className={`chat ${embedded ? "session-main-block" : ""}`} data-session-tab="turns">
  <header className="content-header">
    <div className="content-header-heading">
      {embedded && <><button className="ghost-icon manager-session-collapse" aria-label="Close session">×</button><button className="ghost-icon manager-session-expand" aria-label="Expand session">↗</button></>}
      <div className="session-header-title">
      <h1 title={title}>{title}</h1>
      <SessionOwnerBadges workspaceId="header-test" sessionId="header-session" enabled onOpenActor={actorId => { document.body.dataset.openedActor = actorId; }} />
      <div className="session-header-id"><span>tx_7f411c77-58dd-47a4-bfe7-50ce128fea27</span><button className="session-header-id-copy" aria-label="Copy Threadex session URL">⧉</button></div>
    </div></div>
    <div className="content-header-actions"><button>Concurrent</button></div>
  </header>
  <div className="session-view-tabs">Turns</div>
</section>;
createRoot(document.getElementById("root")!).render(<div className="responsive-layout" data-middle-open="true">
  {embedded ? <div className="manager-workspace" data-session-expanded="false" data-mobile-panel="details" style={panelWidth ? { gridTemplateColumns: `minmax(0, 1fr) ${panelWidth}px` } : undefined}><div className="manager-conversation" /><div className="manager-details">{header}</div></div> : header}
</div>);
