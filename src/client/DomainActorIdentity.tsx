import { ActorAvatar } from "./ActorAvatar";
import { BotAvatar } from "./BotAvatar";
import { domainActorIdentity } from "./domainActorIdentity";
import "./DomainActorIdentity.css";

export function DomainActorIdentity({ actor, detail }: {
  actor: { id: string; name: string; avatar?: string }; detail?: string;
}) {
  const identity = domainActorIdentity(actor);
  return <span className="domain-actor-identity">
    {actor.avatar ? <ActorAvatar decorative actor={{ ...actor, name: identity.name }} />
      : <span className="actor-avatar actor-avatar-bot" aria-hidden="true"><BotAvatar seed={actor.id} character={identity.role ? identity.name : undefined} /></span>}
    <span className="domain-actor-identity-copy">
      <strong>{identity.name}{identity.role && <span className="domain-actor-role"> · {identity.role}</span>}</strong>
      {detail && <small>{detail}</small>}
    </span>
  </span>;
}
