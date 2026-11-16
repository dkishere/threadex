/** Copy JSON document containers while sharing immutable string values.
 * structuredClone copies every multi-MB history string even when only one status changes.
 * Match JSON serialization for undefined fields and non-finite numbers.
 */
export function cloneJsonDocument<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return (typeof value === "number" && !Number.isFinite(value) ? null : value) as T;
  }
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : cloneJsonDocument(item)) as T;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, cloneJsonDocument(item)])) as T;
}
