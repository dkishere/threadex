import assert from "node:assert/strict";
import test from "node:test";
import { normalizePageValueMappings, pageValuesForUrl } from "../src/pageValues.js";

test("merges all matched URL prefixes and attaches every matching prefix", () => {
  const mappings = normalizePageValueMappings([
    { urlPrefix: "https://example.test/", values: { project: "shared", environment: "test", nested: { source: "broad" } } },
    { urlPrefix: "https://example.test/projects/alpha/", values: { project: "alpha", region: "eu", nested: { source: "specific" } } }
  ]);
  assert.deepEqual(pageValuesForUrl("https://example.test/projects/alpha/task/1", mappings), {
    values: { project: "alpha", environment: "test", region: "eu", nested: { source: "specific" } },
    matchedPrefixes: ["https://example.test/", "https://example.test/projects/alpha/"]
  });
});
