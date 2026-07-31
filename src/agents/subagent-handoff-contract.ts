export const SUBAGENT_HANDOFF_GATES = ["unmanaged", "managed"] as const;
export type SubagentHandoffGate = (typeof SUBAGENT_HANDOFF_GATES)[number];

export const SUBAGENT_HANDOFF_VERIFICATION_STATUSES = ["passed", "failed", "unknown"] as const;
export type SubagentHandoffVerificationStatus =
  (typeof SUBAGENT_HANDOFF_VERIFICATION_STATUSES)[number];

export const SUBAGENT_HANDOFF_DELIVERY_STATUSES = [
  "unmanaged",
  "ready",
  "warning",
  "blocked",
] as const;
export type SubagentHandoffDeliveryStatus = (typeof SUBAGENT_HANDOFF_DELIVERY_STATUSES)[number];

export const SUBAGENT_HANDOFF_STAGING_POLICY_STATUSES = ["evaluated", "unavailable"] as const;
export type SubagentHandoffStagingPolicyStatus =
  (typeof SUBAGENT_HANDOFF_STAGING_POLICY_STATUSES)[number];

export const SUBAGENT_HANDOFF_ISSUE_CODES = [
  "artifact-count-rejected",
  "export-prefix-rejected",
  "file-extension-rejected",
  "file-name-rejected",
  "handoff-expired",
  "handoff-unavailable",
  "hook-error",
  "mime-type-rejected",
  "path-policy-rejected",
  "producer-agent-rejected",
  "quality-blocked",
  "requester-artifact-unavailable",
  "run-not-delivery-eligible",
  "staging-aborted",
  "staging-context-unavailable",
  "staging-failed",
  "stale-handoff",
  "state-persist-failed",
  "unsafe-artifact-path",
  "workspace-unavailable",
] as const;

export type SubagentHandoffIssueCode =
  | (typeof SUBAGENT_HANDOFF_ISSUE_CODES)[number]
  | `plugin:${string}`;
