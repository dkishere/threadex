import assert from "node:assert/strict";
import test from "node:test";
import { formatTimestampShort, formatTokenCount } from "./formatters";

test("formatTokenCount uses compact decimal units", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_500), "1.5K");
  assert.equal(formatTokenCount(2_000_000), "2.0M");
});

test("formatTimestampShort formats relative timestamps against an injectable clock", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  assert.equal(formatTimestampShort("2026-08-25T11:59:30Z", now), "now");
  assert.equal(formatTimestampShort("2026-08-25T11:30:00Z", now), "30m");
  assert.equal(formatTimestampShort("2026-08-25T09:00:00Z", now), "3h");
  assert.equal(formatTimestampShort("not-a-date", now), "");
});
