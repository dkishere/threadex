export const AVATAR_STYLES = ["bottts", "lorelei", "adventurer", "pixel-art"] as const;
export function dicebearAvatar(seed: string, style: string = "bottts") {
  return `https://api.dicebear.com/10.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}
export function parseActorAvatar(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 65536) throw new Error("Avatar must be a small uploaded image or DiceBear avatar.");
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin === "https://api.dicebear.com" && AVATAR_STYLES.some(style => url.pathname === `/10.x/${style}/svg`)
      && [...url.searchParams.keys()].every(key => key === "seed") && (url.searchParams.get("seed")?.length ?? 0) <= 100) return url.href;
  } catch { /* Invalid avatar URL. */ }
  throw new Error("Avatar must be a small uploaded image or DiceBear avatar.");
}
