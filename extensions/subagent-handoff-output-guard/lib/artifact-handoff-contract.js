const ARTIFACT_PROFILE_IDS = Object.freeze({
  RESEARCHER_EXPORT: "researcher-export",
  PPTX_GENERATOR: "pptx-generator",
  PPTX_RESTYLE: "pptx-restyle",
  GENERIC_SUBAGENT_ARTIFACT: "generic-subagent-artifact",
});

const ARTIFACT_DELIVERY_POLICIES = Object.freeze({
  AUTO: "auto",
  CONFIRMATION: "confirmation",
});

const HANDOFF_GATES = Object.freeze({
  UNMANAGED: "unmanaged",
  MANAGED: "managed",
});

const HANDOFF_VERIFICATION_STATUSES = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  UNKNOWN: "unknown",
});

const HANDOFF_DELIVERY_STATUSES = Object.freeze({
  UNMANAGED: "unmanaged",
  READY: "ready",
  WARNING: "warning",
  BLOCKED: "blocked",
});

const STAGING_POLICY_STATUSES = Object.freeze({
  EVALUATED: "evaluated",
  UNAVAILABLE: "unavailable",
});

const HANDOFF_ISSUE_CODES = Object.freeze({
  EXPORT_PREFIX_REJECTED: "export-prefix-rejected",
  ARTIFACT_COUNT_REJECTED: "artifact-count-rejected",
  FILE_EXTENSION_REJECTED: "file-extension-rejected",
  FILE_SIZE_REJECTED: "file-size-rejected",
  FILE_NAME_REJECTED: "file-name-rejected",
  HANDOFF_EXPIRED: "handoff-expired",
  HANDOFF_UNAVAILABLE: "handoff-unavailable",
  HOOK_ERROR: "hook-error",
  MIME_TYPE_REJECTED: "mime-type-rejected",
  PATH_POLICY_REJECTED: "path-policy-rejected",
  PRODUCER_AGENT_REJECTED: "producer-agent-rejected",
  QUALITY_BLOCKED: "quality-blocked",
  REQUESTER_ARTIFACT_UNAVAILABLE: "requester-artifact-unavailable",
  RUN_NOT_DELIVERY_ELIGIBLE: "run-not-delivery-eligible",
  STAGING_ABORTED: "staging-aborted",
  STAGING_CONTEXT_UNAVAILABLE: "staging-context-unavailable",
  STAGING_FAILED: "staging-failed",
  STALE_HANDOFF: "stale-handoff",
  STATE_PERSIST_FAILED: "state-persist-failed",
  UNSAFE_ARTIFACT_PATH: "unsafe-artifact-path",
  WORKSPACE_UNAVAILABLE: "workspace-unavailable",
});

function normalizeHandoffQuality(rawQuality) {
  if (!rawQuality || typeof rawQuality !== "object") {
    return {
      gate: HANDOFF_GATES.MANAGED,
      verificationStatus: HANDOFF_VERIFICATION_STATUSES.UNKNOWN,
      deliveryStatus: HANDOFF_DELIVERY_STATUSES.BLOCKED,
    };
  }

  const gate = typeof rawQuality.gate === "string" ? rawQuality.gate.trim().toLowerCase() : "";
  const declaredVerificationStatus =
    typeof rawQuality.verificationStatus === "string"
      ? rawQuality.verificationStatus.trim().toLowerCase()
      : "";
  const declaredDeliveryStatus =
    typeof rawQuality.deliveryStatus === "string"
      ? rawQuality.deliveryStatus.trim().toLowerCase()
      : "";
  const verificationStatus =
    declaredVerificationStatus === HANDOFF_VERIFICATION_STATUSES.PASSED ||
    declaredVerificationStatus === HANDOFF_VERIFICATION_STATUSES.FAILED
      ? declaredVerificationStatus
      : HANDOFF_VERIFICATION_STATUSES.UNKNOWN;
  const deliveryStatus = Object.values(HANDOFF_DELIVERY_STATUSES).includes(declaredDeliveryStatus)
    ? declaredDeliveryStatus
    : HANDOFF_DELIVERY_STATUSES.BLOCKED;

  return {
    gate: gate === HANDOFF_GATES.UNMANAGED ? HANDOFF_GATES.UNMANAGED : HANDOFF_GATES.MANAGED,
    verificationStatus,
    verificationSummary:
      typeof rawQuality.verificationSummary === "string"
        ? rawQuality.verificationSummary.trim()
        : "",
    deliveryStatus,
  };
}

module.exports = {
  ARTIFACT_DELIVERY_POLICIES,
  ARTIFACT_PROFILE_IDS,
  HANDOFF_DELIVERY_STATUSES,
  HANDOFF_GATES,
  HANDOFF_ISSUE_CODES,
  HANDOFF_VERIFICATION_STATUSES,
  STAGING_POLICY_STATUSES,
  normalizeHandoffQuality,
};
