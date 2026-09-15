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
