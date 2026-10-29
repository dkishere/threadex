import { useState } from "react";
import { AVATAR_STYLES, dicebearAvatar } from "../actorAvatar";

export function ActorAvatar({ actor, decorative = false }: { actor: { id: string; name: string; avatar?: string }; decorative?: boolean }) {
  const source = actor.avatar ?? dicebearAvatar(actor.id);
  const [failed, setFailed] = useState("");
  return <span className="actor-avatar" aria-hidden={decorative || undefined}>{failed === source ? <span>{actor.name.trim().slice(0, 2).toUpperCase() || "?"}</span>
    : <img src={source} alt={decorative ? "" : `${actor.name || "Actor"} avatar`} referrerPolicy="no-referrer" onError={() => setFailed(source)} />}</span>;
}

export function ActorAvatarEditor({ actor, onChange }: { actor: { id: string; name: string; avatar?: string }; onChange: (avatar: string) => void }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const style = AVATAR_STYLES.find(style => actor.avatar?.includes(`/${style}/`)) ?? "bottts";
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) { setError("Choose a PNG, JPEG or WebP image up to 5 MB."); return; }
    setLoading(true);
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 128;
        const context = canvas.getContext("2d"); if (!context) throw new Error("Image processing is unavailable.");
        const side = Math.min(bitmap.width, bitmap.height);
        context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128);
        const data = canvas.toDataURL("image/webp", .85);
        if (data.length > 65536) throw new Error("Image is too large. Choose a simpler image.");
        onChange(data);
      } finally { bitmap.close(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to read image."); }
    finally { setLoading(false); }
  }
  return <div className="actor-avatar-editor"><ActorAvatar actor={actor} /><div className="actor-avatar-controls">
    <label className="actor-avatar-upload">{loading ? "Uploading…" : "Upload avatar"}<input type="file" aria-label="Upload avatar" accept="image/png,image/jpeg,image/webp" disabled={loading} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label>
    <label>DiceBear style<select aria-label="DiceBear style" value={style} onChange={event => onChange(dicebearAvatar(actor.id, event.target.value))}>{AVATAR_STYLES.map(style => <option key={style} value={style}>{style}</option>)}</select></label>
    <button type="button" onClick={() => onChange(dicebearAvatar(crypto.randomUUID(), style))}>Shuffle DiceBear</button>
    <a href="https://www.dicebear.com/" target="_blank" rel="noreferrer">Avatars by DiceBear</a>
    {error && <p role="alert">{error}</p>}
  </div></div>;
}
