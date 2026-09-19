import { createHash } from "node:crypto";

/** Preserve ordinary IDs; encode other IDs consistently on every platform. */
export function runnerFileName(id: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/.test(id)
    && !id.endsWith(".")
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
    && !id.startsWith("encoded-")) return id;
  return `encoded-${createHash("sha256").update(id).digest("hex")}`;
}
