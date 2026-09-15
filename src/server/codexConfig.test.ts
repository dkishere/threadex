import assert from "node:assert/strict";
import test from "node:test";

import { buildAppServerArgs, resolveApprovalSettings } from "./codexConfig";

test("Approve for me uses on-request approvals with the automatic reviewer", () => {
  assert.deepEqual(resolveApprovalSettings("granular"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review"
  });

  const args = buildAppServerArgs("granular");
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.ok(args.includes('approvals_reviewer="auto_review"'));
  assert.ok(!args.some((arg) => arg.includes("granular")));
});

test("interactive approval policies keep the user as reviewer", () => {
  assert.deepEqual(resolveApprovalSettings("on-request"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  });
});
