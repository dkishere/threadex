export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PageValueMapping = { urlPrefix: string; values: Record<string, JsonValue> };

const maxMappings = 100;
const maxValues = 100;
const maxPrefixLength = 2_048;
const maxKeyLength = 256;
const maxDepth = 12;

export function normalizePageValueMappings(input: unknown): PageValueMapping[] {
  const mappings = Array.isArray(input) ? input : record(input) && Array.isArray(input.mappings) ? input.mappings : null;
  if (!mappings) throw new Error("mappings must be an array.");
  if (mappings.length > maxMappings) throw new Error(`Configure at most ${maxMappings} URL prefix mappings.`);
  const seen = new Set<string>();
  return mappings.map((item, index) => {
    if (!record(item)) throw new Error(`Mapping ${index + 1} must be an object.`);
    const urlPrefix = typeof item.urlPrefix === "string" ? item.urlPrefix.trim() : "";
    if (!urlPrefix) throw new Error(`Mapping ${index + 1} needs a URL prefix.`);
    if (urlPrefix.length > maxPrefixLength) throw new Error(`Mapping ${index + 1} has a URL prefix that is too long.`);
    if (!httpUrl(urlPrefix)) throw new Error(`Mapping ${index + 1} must start with an http(s) URL.`);
    if (seen.has(urlPrefix)) throw new Error(`URL prefix '${urlPrefix}' is configured more than once.`);
    seen.add(urlPrefix);
    if (!record(item.values)) throw new Error(`Mapping ${index + 1} values must be a JSON object.`);
    const entries = Object.entries(item.values);
    if (entries.length > maxValues) throw new Error(`Mapping ${index + 1} has too many values.`);
    const values = Object.fromEntries(entries.map(([key, value]) => {
      const normalized = key.trim();
      if (!normalized) throw new Error(`Mapping ${index + 1} contains an empty value key.`);
      if (normalized.length > maxKeyLength) throw new Error(`A value key in mapping ${index + 1} is too long.`);
      if (!json(value, 0)) throw new Error(`Value '${normalized}' in mapping ${index + 1} must be valid JSON data.`);
      return [normalized, clone(value)];
    })) as Record<string, JsonValue>;
    return { urlPrefix, values };
  });
}

/** Broad mappings merge first; a more-specific URL prefix wins duplicate keys. */
export function pageValuesForUrl(url: string, mappings: PageValueMapping[]): { values: Record<string, JsonValue>; matchedPrefixes: string[] } | null {
  const values = new Map<string, JsonValue>();
  const matchedPrefixes: string[] = [];
  for (const mapping of [...mappings].sort((left, right) => left.urlPrefix.length - right.urlPrefix.length)) {
    if (!url.startsWith(mapping.urlPrefix)) continue;
    matchedPrefixes.push(mapping.urlPrefix);
    for (const [key, value] of Object.entries(mapping.values)) values.set(key, clone(value));
  }
  return values.size ? { values: Object.fromEntries(values), matchedPrefixes } : null;
}

export function cloneMappings(mappings: PageValueMapping[]): PageValueMapping[] { return mappings.map((mapping) => ({ urlPrefix: mapping.urlPrefix, values: clone(mapping.values) as Record<string, JsonValue> })); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function httpUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; } }
function json(value: unknown, depth: number): value is JsonValue { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (depth >= maxDepth || !value || typeof value !== "object") return false; return Array.isArray(value) ? value.every((item) => json(item, depth + 1)) : Object.values(value).every((item) => json(item, depth + 1)); }
function clone<T extends JsonValue>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
