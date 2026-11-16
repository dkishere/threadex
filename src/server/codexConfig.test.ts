import assert from "node:assert/strict";
import test from "node:test";

import { buildAppServerArgs, buildSandboxPolicy, resolveApprovalSettings, sandboxModeForApprovalPolicy } from "./codexConfig";

test("Full access lifts the sandbox while other policies keep the configured one", () => {
  assert.equal(sandboxModeForApprovalPolicy("never", "workspace-write"), "danger-full-access");
  for (const policy of ["on-request", "granular", "untrusted"]) {
    assert.equal(sandboxModeForApprovalPolicy(policy, "workspace-write"), "workspace-write");
  }
  // An operator read-only sandbox is a ceiling that Full access does not lift.
  assert.equal(sandboxModeForApprovalPolicy("never", "read-only"), "read-only");
  assert.deepEqual(buildSandboxPolicy("/work", "danger-full-access"), { type: "dangerFullAccess" });
  assert.equal(buildSandboxPolicy("/work", "workspace-write").type, "workspaceWrite");
});

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
