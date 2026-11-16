import { ActorAvatar } from "./ActorAvatar";
import { BotAvatar } from "./BotAvatar";
import { domainActorIdentity } from "./domainActorIdentity";
import "./DomainActorIdentity.css";

export function DomainActorIdentity({ actor, detail, onOpen }: {
  actor: { id: string; name: string; avatar?: string }; detail?: string;
  /** Makes avatar and name one button that opens the actor view; never use inside another button. */
  onOpen?: (actorId: string) => void;
}) {
  const identity = domainActorIdentity(actor);
  const Wrapper = onOpen ? "button" : "span";
  return <Wrapper className={onOpen ? "domain-actor-identity domain-actor-identity-link" : "domain-actor-identity"}
    {...(onOpen ? { type: "button" as const, title: `Open ${identity.name}`, "aria-label": `Open ${identity.name} actor view`, onClick: () => onOpen(actor.id) } : {})}>
    {actor.avatar ? <ActorAvatar decorative actor={{ ...actor, name: identity.name }} />
      : <span className="actor-avatar actor-avatar-bot" aria-hidden="true"><BotAvatar seed={actor.id} character={identity.role ? identity.name : undefined} /></span>}
    <span className="domain-actor-identity-copy">
      <strong>{identity.name}{identity.role && <span className="domain-actor-role"> · {identity.role}</span>}</strong>
      {detail && <small>{detail}</small>}
    </span>
  </Wrapper>;
}
