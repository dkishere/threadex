import { MAX_INLINE_ATTACHMENT_BYTES, MAX_PATH_ATTACHMENT_BYTES } from "../attachmentLimits";
import type { ApprovalPolicy, ModelReasoningEffort } from "./appTypes";

export const MESSAGE_BOTTOM_THRESHOLD = 80;

export const STORAGE_KEY = "threadex.current-session";
export const MODEL_SELECTOR_STORAGE_KEY = "threadex.model-selector";
export const COMPOSER_DRAFT_STORAGE_KEY = "threadex.composer-drafts";
export const NEW_SESSION_QUEUE_KEY = "__new_session__";
export const AUTO_MODEL_VALUE = "auto";
export const APPROVAL_POLICY_OPTIONS: Array<{ value: ApprovalPolicy; label: string }> = [
  { value: "on-request", label: "Ask for approval" },
  { value: "granular", label: "Approve for me" },
  { value: "never", label: "Full access" },
  { value: "untrusted", label: "Custom (config.toml)" }
];
export const MODEL_OPTIONS = ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;
export const EFFORT_OPTIONS: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
export const ULTRA_EFFORT_OPTIONS: ModelReasoningEffort[] = [...EFFORT_OPTIONS, "ultra"];
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = MAX_INLINE_ATTACHMENT_BYTES;
export { MAX_PATH_ATTACHMENT_BYTES };
export const PASTED_TEXT_COMPACT_THRESHOLD = 2_000;
export const PASTED_TEXT_COMPACT_LINE_THRESHOLD = 20;
export const FORCE_PLAN_TAG_LABEL = "Todo plan";
export const GOAL_MODE_TAG_LABEL = "Goal mode";
export const CONTEXT_FORK_TAG_LABEL = "Fork";
