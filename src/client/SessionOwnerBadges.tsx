import { useRef, useState, type ReactNode } from "react";
import { ActorAvatar } from "./ActorAvatar";
import { domainActorIdentity } from "./domainActorIdentity";
import { useActorRoom } from "./actorRoomState";
import { sessionOwnerActors, type SessionOwnerActor } from "./sessionOwnerActors";
import "./SessionOwnerBadges.css";

function ownerLabel(entry: SessionOwnerActor) {
  const name = domainActorIdentity(entry.actor).name;
  return entry.parentActorName ? `${name} (sub-actor of ${domainActorIdentity({ name: entry.parentActorName }).name})` : name;
}

/**
 * Responsible actors of the open session, shown in its title bar. One actor is a single badge;
 * several show the owner plus "+N" and a menu (hover, focus or click) listing all of them.
 * Renders nothing while the session has no actor, where Pick owner applies instead.
 */
export function SessionOwnerBadges({ workspaceId, sessionId, enabled, onOpenActor }: {
  workspaceId: string; sessionId: string; enabled: boolean; onOpenActor: (actorId: string) => void;
}) {
  const roomState = useActorRoom(workspaceId, { enabled });
  const owners = enabled ? sessionOwnerActors(roomState.room, sessionId) : [];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  if (!owners.length) return null;
  const [first, ...others] = owners;
  const many = others.length > 0;
  const choose = (actorId: string) => { setOpen(false); onOpenActor(actorId); };
  const badge = (entry: SessionOwnerActor, extra?: ReactNode) => <>
    <ActorAvatar decorative actor={{ ...entry.actor, name: domainActorIdentity(entry.actor).name }} />
    <span className="session-owner-name">{domainActorIdentity(entry.actor).name}</span>{extra}
  </>;
  if (!many) {
    return <div className="session-owner-badges">
      <button type="button" className="session-owner-badge" title={`Owner: ${ownerLabel(first)}`} aria-label={`Open ${ownerLabel(first)} actor view`}
        onClick={() => choose(first.actor.id)}>{badge(first)}</button>
    </div>;
  }
  return <div className="session-owner-badges" ref={root} data-open={open || undefined}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onBlur={(event) => { if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); (root.current?.querySelector(".session-owner-badge") as HTMLElement | null)?.focus(); }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && open) {
        const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    }}>
    <button type="button" className="session-owner-badge" aria-haspopup="menu" aria-expanded={open} aria-label={`${ownerLabel(first)} and ${others.length} more responsible actors`}
      title={owners.map(ownerLabel).join(", ")} onClick={() => setOpen(true)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { setOpen(true); requestAnimationFrame(() => (root.current?.querySelector("[role=menuitem]") as HTMLElement | null)?.focus()); } }}>
      {badge(first, <span className="session-owner-more">+{others.length}</span>)}
    </button>
    {open && <div className="session-owner-menu" role="menu" aria-label="Responsible actors">
      {owners.map((entry) => <button key={entry.actor.id} type="button" role="menuitem" className="session-owner-menu-item"
        onClick={() => choose(entry.actor.id)}>
        <ActorAvatar decorative actor={{ ...entry.actor, name: domainActorIdentity(entry.actor).name }} />
        <span className="session-owner-menu-copy"><strong>{domainActorIdentity(entry.actor).name}</strong>
          <small>{entry.kind === "owner" ? "Owner" : "Also working here"}{entry.parentActorName ? ` · Sub-actor of ${domainActorIdentity({ name: entry.parentActorName }).name}` : ""}</small></span>
      </button>)}
    </div>}
  </div>;
}
