const sharedJsonDocuments = new WeakSet<object>();

/** Deep-freeze a JSON value and let cloneJsonDocument share it instead of copying it. For immutable
 * parts of a large document, such as frozen actor round snapshots repeated across hundreds of rounds. */
export function shareJsonDocument<T extends object>(value: T): T {
  const freeze = (item: unknown) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(value);
  sharedJsonDocuments.add(value);
  return value;
}

/** Copy JSON document containers while sharing immutable string values.
 * structuredClone copies every multi-MB history string even when only one status changes.
 * Match JSON serialization for undefined fields and non-finite numbers.
 */
export function cloneJsonDocument<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return (typeof value === "number" && !Number.isFinite(value) ? null : value) as T;
  }
  if (sharedJsonDocuments.has(value)) return value;
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : cloneJsonDocument(item)) as T;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, cloneJsonDocument(item)])) as T;
}
