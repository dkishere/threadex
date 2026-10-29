import type { WorkspaceManagerSnapshot } from "../workspaceManager";
import type { SessionRecord } from "./appTypes";
import { ActorRoomPanel } from "./ActorRoomPanel";
import { ActorSessionsPanel } from "./ActorSessionsPanel";
import { useActorRoom } from "./actorRoomState";

/** One actor's sessions (middle column) and Individual/Group dialog; every node is a direct `.chat` child. */
export function ActorView({ workspaceId, actorId, snapshot, sessions, middleHidden, onOpenSession, approvalPolicy }: {
  approvalPolicy?: import("../domainActors").ActorRound["approvalPolicy"];
  workspaceId: string; actorId: string; snapshot: WorkspaceManagerSnapshot | null; sessions: SessionRecord[];
  middleHidden: boolean; onOpenSession: (sessionId: string) => void;
}) {
  const roomState = useActorRoom(workspaceId);
  const { room, error, authRequired } = roomState;
  const actor = room?.actors.find(candidate => candidate.id === actorId);
  if (!room) return <div className="messages-pane actor-room-messages-pane">
    <div className="messages actor-room-messages">
      {authRequired ? <p role="alert" className="actor-room-error"><a href="/">Sign in to Threadex</a> to see this actor.</p>
        : error ? <p role="alert" className="actor-room-error">{error}</p> : <p role="status">Loading actor…</p>}
    </div>
  </div>;
  if (!actor) return <div className="messages-pane actor-room-messages-pane">
    <div className="messages actor-room-messages" role="alert">Actor not found in this workspace.</div>
  </div>;
  return <>
    <ActorSessionsPanel actor={actor} room={room} snapshot={snapshot} sessions={sessions} hidden={middleHidden} onOpenSession={onOpenSession} />
    <ActorRoomPanel key={actor.id} workspaceId={workspaceId} approvalPolicy={approvalPolicy} actor={actor} roomState={roomState} onOpenSession={onOpenSession} />
  </>;
}
