/** Local bot-style face: cream head, capsule eyes and a fixed colour and topper per character. */
type Top = "cat" | "bear" | "antenna" | "fringe" | "bunny" | "headphones";
type Look = { hair: string; eye: string; top: Top };

const characterLooks: Record<string, Look> = {
  Mira: { hair: "#fb7185", eye: "#be123c", top: "bunny" },
  Atlas: { hair: "#7cb3f6", eye: "#1d4ed8", top: "headphones" },
  Sage: { hair: "#9ccc65", eye: "#3f6212", top: "fringe" },
  Luna: { hair: "#818cf8", eye: "#3730a3", top: "cat" },
  Theo: { hair: "#f6c453", eye: "#a16207", top: "antenna" },
  Iris: { hair: "#5ec2b7", eye: "#0f766e", top: "cat" },
  Nova: { hair: "#a78bfa", eye: "#6d28d9", top: "antenna" },
  Quinn: { hair: "#6ee7b7", eye: "#047857", top: "headphones" },
  Raven: { hair: "#94a3b8", eye: "#334155", top: "cat" },
  Kai: { hair: "#67e8f9", eye: "#0e7490", top: "bear" },
  Ada: { hair: "#f48fb1", eye: "#be185d", top: "fringe" },
  Cleo: { hair: "#fdba74", eye: "#c2410c", top: "bear" },
  Finn: { hair: "#d6a77a", eye: "#7c4a1e", top: "headphones" },
  Vera: { hair: "#e879f9", eye: "#a21caf", top: "bunny" }
};
const looks = Object.values(characterLooks);

function hash(seed: string) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.codePointAt(0)!, 16777619);
  return value >>> 0;
}

/** Named characters keep their own look; other actors pick one of the same looks by seed. */
export function botAvatarLook(seed: string, character?: string): Look {
  return (character && characterLooks[character]) || looks[hash(seed) % looks.length];
}

export function BotAvatar({ seed, character }: { seed: string; character?: string }) {
  const { hair, eye, top } = botAvatarLook(seed, character);
  return <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <rect width="64" height="64" fill="#24262c" />
    <g transform="translate(-7 9) rotate(20 30 42)">
      {top === "cat" && <path d="M8 26 L12 4 L26 16 Z M52 26 L48 4 L34 16 Z" fill={hair} />}
      {top === "bear" && <><circle cx="10" cy="16" r="8" fill={hair} /><circle cx="50" cy="16" r="8" fill={hair} /></>}
      {top === "antenna" && <><rect x="28.5" y="4" width="3" height="12" rx="1.5" fill={hair} /><circle cx="30" cy="5" r="4.5" fill={hair} /></>}
      {top === "bunny" && <><rect x="14" y="-6" width="9" height="28" rx="4.5" fill={hair} /><rect x="37" y="-6" width="9" height="28" rx="4.5" fill={hair} /></>}
      <circle cx="30" cy="42" r="27" fill={hair} />
      <ellipse cx="30" cy="45" rx="23" ry="22" fill="#fdf6e9" />
      {top === "fringe" && <path d="M5 38 Q8 14 30 14 Q52 14 55 38 Q46 26 38 30 Q32 22 24 30 Q14 26 5 38 Z" fill={hair} />}
      {top === "headphones" && <><path d="M6 40 Q6 12 30 12 Q54 12 54 40" fill="none" stroke={hair} strokeWidth="5" /><rect x="1" y="34" width="9" height="16" rx="4" fill={hair} /><rect x="50" y="34" width="9" height="16" rx="4" fill={hair} /></>}
      <rect x="19" y="34" width="6" height="18" rx="3" fill={eye} />
      <rect x="35" y="34" width="6" height="18" rx="3" fill={eye} />
      <ellipse cx="14" cy="54" rx="5" ry="3" fill="#f9a8b8" opacity=".4" />
      <ellipse cx="46" cy="54" rx="5" ry="3" fill="#f9a8b8" opacity=".4" />
    </g>
  </svg>;
}
