import assert from "node:assert/strict";
import test from "node:test";

import { isCreditExhaustionError, isUsageLimitError } from "./usageLimit";

test("classifies account and workspace credit exhaustion as a usage limit", () => {
  const messages = [
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "workspace_member_credits_depleted",
    "Insufficient credits to continue.",
    "Credit balance exhausted."
  ];

  for (const message of messages) {
    assert.equal(isCreditExhaustionError(message), true, message);
    assert.equal(isUsageLimitError(message), true, message);
  }
});

test("keeps ordinary failures out of usage-limit retry handling", () => {
  assert.equal(isUsageLimitError("Agent CLI exec timed out."), false);
  assert.equal(isUsageLimitError("Request exceeded the transport timeout."), false);
});

test("does not treat exhausted request retries as exhausted account quota", () => {
  const messages = [
    "exceeded retry limit, last status: 429 Too Many Requests",
    "exceeded retry limit, last status: 503 Service Unavailable",
    "Auto model exceeded the maximum number of upgrade phases for one user turn."
  ];

  for (const message of messages) {
    assert.equal(isUsageLimitError(message), false, message);
  }
});

test("keeps explicit quota failures in usage-limit retry handling", () => {
  const messages = [
    "You've hit your usage limit. Try again later.",
    "Rate limit exceeded. Retry after reset.",
    "Quota exceeded."
  ];

  for (const message of messages) {
    assert.equal(isUsageLimitError(message), true, message);
  }
});
