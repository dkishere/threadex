import { useRef, useState } from "react";
import type { MessageAttachment } from "./appTypes";
import { readAttachment } from "./attachments";

/** Keep uploads with their original dialog even when selection changes mid-read. */
export function useActorAttachments(dialogId: string) {
  const [drafts, setDrafts] = useState<Record<string, MessageAttachment[]>>({});
  const [loading, setLoading] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const generations = useRef<Record<string, number>>({});
  function clear() {
    generations.current[dialogId] = (generations.current[dialogId] ?? 0) + 1;
    setDrafts(current => ({ ...current, [dialogId]: [] }));
    setErrors(current => ({ ...current, [dialogId]: "" }));
  }
  async function add(files: FileList | File[]) {
    const key = dialogId, generation = generations.current[key] ?? 0;
    const selected = Array.from(files);
    if (!selected.length) return;
    setErrors(current => ({ ...current, [key]: "" }));
    setLoading(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
    try {
      const results = await Promise.allSettled(selected.map(readAttachment));
      if ((generations.current[key] ?? 0) !== generation) return;
      const attachments = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : []);
      setDrafts(current => ({ ...current, [key]: [...current[key] ?? [], ...attachments] }));
      setErrors(current => ({ ...current, [key]: failures.join("; ") }));
    } finally { setLoading(current => ({ ...current, [key]: Math.max(0, (current[key] ?? 1) - 1) })); }
  }
  return { attachments: drafts[dialogId] ?? [], reading: !!loading[dialogId], error: errors[dialogId] ?? "", add, clear,
    remove: (id: string) => setDrafts(current => ({ ...current, [dialogId]: (current[dialogId] ?? []).filter(file => file.id !== id) })) };
}
