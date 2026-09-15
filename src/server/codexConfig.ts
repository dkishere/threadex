import { agentCliExecutable } from "./agentCli";

export type ApprovalPolicy = "untrusted" | "on-request" | "granular" | "never";
export type AppServerApprovalPolicy = Exclude<ApprovalPolicy, "granular">;
export type ApprovalsReviewer = "user" | "auto_review";

export type ApprovalSettings = {
  approvalPolicy: AppServerApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
};

export type AppServerThreadOptions = {
  cwd: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: ApprovalPolicy;
};

export type AppServerSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
  | { type: "dangerFullAccess" };

export const defaultThreadOptions: AppServerThreadOptions = {
  cwd: process.env.CODEX_WORKDIR ?? process.cwd(),
  sandbox: readSandboxMode(process.env.CODEX_SANDBOX_MODE) ?? "workspace-write",
  approvalPolicy: readApprovalPolicy(process.env.CODEX_APPROVAL_POLICY) ?? "on-request"
};

export function codexExecutable() {
  return agentCliExecutable();
}

export function buildAppServerArgs(approvalPolicy = defaultThreadOptions.approvalPolicy) {
  const settings = resolveApprovalSettings(approvalPolicy);
  return [
    "app-server",
    "-c",
    `approval_policy="${settings.approvalPolicy}"`,
    "-c",
    `approvals_reviewer="${settings.approvalsReviewer}"`,
    "-c",
    `sandbox_mode="${defaultThreadOptions.sandbox}"`,
    "-c",
    "features.memories=false"
  ];
}

export function resolveApprovalSettings(approvalPolicy = defaultThreadOptions.approvalPolicy): ApprovalSettings {
  if (approvalPolicy === "granular") {
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review"
    };
  }

  return {
    approvalPolicy,
    approvalsReviewer: "user"
  };
}

export function buildSandboxPolicy(cwd: string): AppServerSandboxPolicy {
  if (defaultThreadOptions.sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }

  if (defaultThreadOptions.sandbox === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }

  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function readSandboxMode(value: string | undefined): AppServerThreadOptions["sandbox"] | null {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return null;
}

function readApprovalPolicy(value: string | undefined): AppServerThreadOptions["approvalPolicy"] | null {
  if (value === "on-failure") {
    return "granular";
  }
  if (value === "untrusted" || value === "on-request" || value === "granular" || value === "never") {
    return value;
  }
  return null;
}
