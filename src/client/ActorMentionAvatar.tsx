import { ActorAvatar } from "./ActorAvatar";
import { BotAvatar } from "./BotAvatar";
import { domainActorIdentity } from "./domainActorIdentity";

/** Small decorative avatar for @ mention options and chips; same rules as DomainActorIdentity. */
export function ActorMentionAvatar({ actor }: { actor: { id: string; name: string; avatar?: string } }) {
  const identity = domainActorIdentity(actor);
  return <span className="session-actor-mention-avatar">{actor.avatar ? <ActorAvatar decorative actor={{ ...actor, name: identity.name }} />
    : <span className="actor-avatar actor-avatar-bot" aria-hidden="true"><BotAvatar seed={actor.id} character={identity.role ? identity.name : undefined} /></span>}</span>;
}
