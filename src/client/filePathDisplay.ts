/** Returns a compact path label while preserving enough context to identify a file. */
export function compactFilePath(path: string, levels = 3): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= levels) return path;

  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  return `…${separator}${segments.slice(-levels).join(separator)}`;
}
