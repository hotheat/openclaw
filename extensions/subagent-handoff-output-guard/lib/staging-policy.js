const path = require("node:path");
const { evaluateArtifactProfile, normalizeRelativePath } = require("./artifact-profiles.js");
const {
  ArtifactStagingError,
  buildRequesterRelativePath,
  stageArtifactIntoRequester,
} = require("./artifact-stager.js");
const {
  ARTIFACT_PROFILE_IDS,
  HANDOFF_DELIVERY_STATUSES,
  HANDOFF_ISSUE_CODES,
  STAGING_POLICY_STATUSES,
  normalizeHandoffQuality,
} = require("./artifact-handoff-contract.js");
const { canonicalHashes, requesterCanAccessArtifact } = require("./artifact-identity.js");
const { resolveDeliveryPolicy } = require("./delivery-policy.js");
const {
  asTrimmedString,
  isEnabledForStagingEvent,
  normalizeChannels,
  resolvePeerFromEvent,
  resolvePendingTtlMs,
  shouldPersistFeishuState,
} = require("./runtime-context.js");

const PRIMARY_PPTX_PROFILE_IDS = new Set([
  ARTIFACT_PROFILE_IDS.PPTX_GENERATOR,
  ARTIFACT_PROFILE_IDS.PPTX_RESTYLE,
]);
const DEFAULT_MAX_ARTIFACTS_PER_HANDOFF = 1;

function emptyStagingResult(policyStatus = STAGING_POLICY_STATUSES.EVALUATED) {
  return {
    policyStatus,
    acceptedArtifacts: [],
    stagedArtifacts: [],
    rejections: [],
    failures: [],
  };
}

function unavailableStagingResult(code, message) {
  const result = emptyStagingResult(STAGING_POLICY_STATUSES.UNAVAILABLE);
  result.failures.push({ code, message });
  result.haltRemainingHandlers = true;
  return result;
}

function createStagingPolicy(api, stateStore) {
  function resolveGlobalMaxArtifacts() {
    const configured = api.pluginConfig?.maxArtifactsPerHandoff;
    return Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_ARTIFACTS_PER_HANDOFF;
  }

  function evaluateArtifactPath(artifact, event) {
    const sourceRelativePath = normalizeRelativePath(
      asTrimmedString(artifact?.relativePath).replaceAll("\\", "/"),
    );
    const requesterRelativePath = buildRequesterRelativePath(
      sourceRelativePath,
      event?.runId,
      api.pluginConfig,
    );
    const sourceEvaluation = evaluateArtifactProfile({
      relativePath: sourceRelativePath,
      fileName: artifact?.fileName,
      mimeType: artifact?.mimeType,
      childSessionKey: event?.childSessionKey,
      config: api?.pluginConfig,
    });
    const evaluation =
      !sourceEvaluation.accepted &&
      sourceEvaluation.code === HANDOFF_ISSUE_CODES.EXPORT_PREFIX_REJECTED &&
      requesterRelativePath &&
      requesterRelativePath !== sourceRelativePath
        ? evaluateArtifactProfile({
            relativePath: requesterRelativePath,
            fileName: artifact?.fileName,
            mimeType: artifact?.mimeType,
            childSessionKey: event?.childSessionKey,
            config: api?.pluginConfig,
          })
        : sourceEvaluation;
    if (!evaluation.profile) return evaluation;
    return {
      ...evaluation,
      sourceRelativePath,
      requesterRelativePath,
      deliveryPolicy: resolveDeliveryPolicy(evaluation.profile, event),
    };
  }

  function resolveHandoffArtifactPolicies(event) {
    const artifacts = Array.isArray(event?.handoff?.artifacts) ? event.handoff.artifacts : [];
    const globalMaxArtifacts = resolveGlobalMaxArtifacts();
    if (artifacts.length > globalMaxArtifacts) {
      return artifacts.map((artifact) => ({
        accepted: false,
        normalizedPath: normalizeRelativePath(artifact?.relativePath),
        code: HANDOFF_ISSUE_CODES.ARTIFACT_COUNT_REJECTED,
        message: `Artifact handoff allows at most ${globalMaxArtifacts} artifact(s)`,
      }));
    }
    const profileCounts = new Map();
    const requesterPaths = new Set();
    return artifacts.map((artifact) => {
      const evaluation = evaluateArtifactPath(artifact, event);
      if (!evaluation.accepted || !evaluation.profile?.maxArtifacts) return evaluation;
      const isPrimaryPptx = PRIMARY_PPTX_PROFILE_IDS.has(evaluation.profile.id);
      const countKey = isPrimaryPptx ? "pptx-primary" : evaluation.profile.id;
      const maxArtifacts = isPrimaryPptx ? 1 : evaluation.profile.maxArtifacts;
      const nextCount = (profileCounts.get(countKey) || 0) + 1;
      profileCounts.set(countKey, nextCount);
      if (nextCount > maxArtifacts) {
        return {
          ...evaluation,
          accepted: false,
          code: HANDOFF_ISSUE_CODES.ARTIFACT_COUNT_REJECTED,
          message: `Artifact profile ${evaluation.profile.id} allows at most ${maxArtifacts} artifact(s) per handoff`,
        };
      }
      if (requesterPaths.has(evaluation.requesterRelativePath)) {
        return {
          ...evaluation,
          accepted: false,
          code: HANDOFF_ISSUE_CODES.FILE_NAME_REJECTED,
          message: "Multiple artifacts resolve to the same requester staging path",
        };
      }
      requesterPaths.add(evaluation.requesterRelativePath);
      return evaluation;
    });
  }

  function shouldPersistConfirmationState(event, evaluations) {
    return (
      shouldPersistFeishuState(event) &&
      evaluations.some(
        (evaluation) => evaluation.profile && evaluation.deliveryPolicy === "confirmation",
      )
    );
  }

  async function preflightHandoff(event) {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForStagingEvent(event, enabledChannels)) return undefined;
    if (event?.signal?.aborted) {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.STAGING_ABORTED,
        "Artifact staging was aborted",
      );
    }
    if (!event?.handoff || typeof event.handoff !== "object") {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.HANDOFF_UNAVAILABLE,
        "Parsed subagent handoff is unavailable",
      );
    }

    const runId = asTrimmedString(event.runId);
    const handoffAt = Number(event.handoffAt);
    const requesterWorkspaceDir = asTrimmedString(event.requesterWorkspaceDir);
    if (!runId || !Number.isFinite(handoffAt) || !requesterWorkspaceDir) {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.STAGING_CONTEXT_UNAVAILABLE,
        "Run id, handoff timestamp, or requester workspace is unavailable",
      );
    }

    const result = emptyStagingResult();
    const quality = normalizeHandoffQuality(event.handoff.quality);
    const artifacts = Array.isArray(event.handoff.artifacts) ? event.handoff.artifacts : [];
    const artifactEvaluations = resolveHandoffArtifactPolicies(event);
    const artifactPathHashes = canonicalHashes(
      artifactEvaluations.map(
        (evaluation, index) => evaluation.requesterRelativePath || artifacts[index]?.relativePath,
      ),
      requesterWorkspaceDir,
      api,
      { audit: false },
    );
    const expiresAt = handoffAt + resolvePendingTtlMs(api);
    const peer = resolvePeerFromEvent(event);
    const rejectedEvaluations = artifactEvaluations.filter((evaluation) => !evaluation.accepted);
    if (rejectedEvaluations.length > 0) {
      for (const evaluation of rejectedEvaluations) {
        result.rejections.push({
          ...(evaluation.normalizedPath ? { sourceRelativePath: evaluation.normalizedPath } : {}),
          code: evaluation.code,
          message: evaluation.message,
        });
      }
      if (shouldPersistFeishuState(event)) {
        try {
          await stateStore.persistHandoffState({
            runId,
            handoffAt,
            expiresAt,
            requesterWorkspaceDir,
            peer,
            handoff: event.handoff,
            quality,
            acceptedArtifacts: [],
            artifactPathHashes,
            deliveryState: "superseded",
            signal: event.signal,
          });
        } catch (error) {
          await stateStore.persistFallbackTombstone({
            runId,
            handoffAt,
            expiresAt,
            requesterWorkspaceDir,
            peer,
            quality,
            artifactPathHashes,
            deliveryState: "superseded",
          });
          result.failures.push({
            code: HANDOFF_ISSUE_CODES.STATE_PERSIST_FAILED,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      result.haltRemainingHandlers = true;
      return result;
    }
    const persistConfirmationState =
      shouldPersistConfirmationState(event, artifactEvaluations) ||
      (shouldPersistFeishuState(event) &&
        quality.deliveryStatus === HANDOFF_DELIVERY_STATUSES.BLOCKED);
    if (shouldPersistFeishuState(event) && !persistConfirmationState) {
      try {
        await stateStore.supersedePendingConfirmationState({
          runId,
          handoffAt,
          expiresAt,
          requesterWorkspaceDir,
          peer,
          quality,
          signal: event.signal,
        });
      } catch (error) {
        api.logger.warn?.(
          `subagent-handoff-output-guard: failed to supersede confirmation state: ${String(error)}`,
        );
      }
    }

    if (
      event.deliveryEligible === false ||
      expiresAt <= Date.now() ||
      quality.deliveryStatus === HANDOFF_DELIVERY_STATUSES.BLOCKED
    ) {
      const code =
        event.deliveryEligible === false
          ? HANDOFF_ISSUE_CODES.RUN_NOT_DELIVERY_ELIGIBLE
          : expiresAt <= Date.now()
            ? HANDOFF_ISSUE_CODES.HANDOFF_EXPIRED
            : HANDOFF_ISSUE_CODES.QUALITY_BLOCKED;
      const message =
        code === HANDOFF_ISSUE_CODES.RUN_NOT_DELIVERY_ELIGIBLE
          ? "Artifact delivery was disabled because the subagent run did not complete successfully"
          : code === HANDOFF_ISSUE_CODES.HANDOFF_EXPIRED
            ? "Artifact handoff expired before it could be delivered"
            : "Blocked handoff artifacts cannot be delivered";
      for (const artifact of artifacts) {
        const sourceRelativePath = asTrimmedString(artifact?.relativePath).replaceAll("\\", "/");
        result.rejections.push({
          ...(sourceRelativePath ? { sourceRelativePath } : {}),
          code,
          message,
        });
      }
      result.haltRemainingHandlers = true;
      if (persistConfirmationState) {
        const deliveryState =
          code === HANDOFF_ISSUE_CODES.QUALITY_BLOCKED ? "blocked" : "superseded";
        try {
          await stateStore.persistHandoffState({
            runId,
            handoffAt,
            expiresAt,
            requesterWorkspaceDir,
            peer,
            handoff: event.handoff,
            quality,
            acceptedArtifacts: [],
            artifactPathHashes,
            deliveryState,
            signal: event.signal,
          });
        } catch (error) {
          await stateStore.persistFallbackTombstone({
            runId,
            handoffAt,
            expiresAt,
            requesterWorkspaceDir,
            peer,
            quality,
            artifactPathHashes,
            deliveryState,
          });
          result.failures.push({
            code: HANDOFF_ISSUE_CODES.STATE_PERSIST_FAILED,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    }

    if (!persistConfirmationState) {
      return result;
    }

    let reservationOutcome;
    try {
      reservationOutcome = await stateStore.reserveHandoffState({
        runId,
        handoffAt,
        expiresAt,
        requesterWorkspaceDir,
        peer,
        quality,
        artifactPathHashes,
        signal: event.signal,
      });
    } catch (error) {
      await stateStore.persistFallbackTombstone({
        runId,
        handoffAt,
        expiresAt,
        requesterWorkspaceDir,
        peer,
        quality,
        artifactPathHashes,
        deliveryState: "superseded",
      });
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.STATE_PERSIST_FAILED,
        message: error instanceof Error ? error.message : String(error),
      });
      result.haltRemainingHandlers = true;
      return result;
    }
    if (reservationOutcome === "stale") {
      api.logger.info?.(`subagent-handoff-output-guard: ignored stale handoff ${runId}`);
      for (const artifact of artifacts) {
        const sourceRelativePath = asTrimmedString(artifact?.relativePath).replaceAll("\\", "/");
        result.rejections.push({
          ...(sourceRelativePath ? { sourceRelativePath } : {}),
          code: HANDOFF_ISSUE_CODES.STALE_HANDOFF,
          message: "A newer handoff already owns the requester state",
        });
      }
      result.haltRemainingHandlers = true;
    } else if (reservationOutcome === "aborted") {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.STAGING_ABORTED,
        "Artifact staging was aborted",
      );
    }
    return result;
  }

  async function stageHandoffArtifacts(event) {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForStagingEvent(event, enabledChannels)) return undefined;
    if (!event?.handoff || typeof event.handoff !== "object") {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.HANDOFF_UNAVAILABLE,
        "Parsed subagent handoff is unavailable",
      );
    }
    if (event?.signal?.aborted) {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.STAGING_ABORTED,
        "Artifact staging was aborted",
      );
    }
    if (
      event.deliveryEligible === false ||
      normalizeHandoffQuality(event.handoff.quality).deliveryStatus ===
        HANDOFF_DELIVERY_STATUSES.BLOCKED
    ) {
      return undefined;
    }

    const childWorkspaceDir = asTrimmedString(event.childWorkspaceDir);
    const requesterWorkspaceDir = asTrimmedString(event.requesterWorkspaceDir);
    if (!childWorkspaceDir || !requesterWorkspaceDir) {
      return unavailableStagingResult(
        HANDOFF_ISSUE_CODES.WORKSPACE_UNAVAILABLE,
        "Child or requester workspace is unavailable",
      );
    }

    const artifacts = Array.isArray(event.handoff.artifacts) ? event.handoff.artifacts : [];
    const evaluations = resolveHandoffArtifactPolicies(event);
    const result = emptyStagingResult();
    const rejectedEvaluations = evaluations.filter((evaluation) => !evaluation.accepted);
    if (rejectedEvaluations.length > 0) {
      result.rejections.push(
        ...rejectedEvaluations.map((evaluation) => ({
          ...(evaluation.normalizedPath ? { sourceRelativePath: evaluation.normalizedPath } : {}),
          code: evaluation.code,
          message: evaluation.message,
        })),
      );
      result.haltRemainingHandlers = true;
      return result;
    }

    for (const [index, artifact] of artifacts.entries()) {
      const policy = evaluations[index];
      try {
        const staged = await stageArtifactIntoRequester({
          sourceRelativePath: policy.sourceRelativePath,
          runId: event.runId,
          childWorkspaceDir,
          requesterWorkspaceDir,
          maxBytes: policy.profile.maxBytes,
          config: api.pluginConfig,
          detectMime: api.runtime?.media?.detectMime,
          signal: event.signal,
        });
        const fileName =
          asTrimmedString(artifact.fileName) || path.posix.basename(staged.sourceRelativePath);
        result.acceptedArtifacts.push({
          sourceRelativePath: staged.sourceRelativePath,
          requesterRelativePath: staged.requesterRelativePath,
          profileId: policy.profile.id,
          deliveryPolicy: policy.deliveryPolicy,
        });
        result.stagedArtifacts.push({
          sourceRelativePath: staged.sourceRelativePath,
          relativePath: staged.requesterRelativePath,
          fileName,
          ...(asTrimmedString(artifact.title) ? { title: asTrimmedString(artifact.title) } : {}),
          ...(asTrimmedString(artifact.mimeType)
            ? { mimeType: asTrimmedString(artifact.mimeType) }
            : {}),
          profileId: policy.profile.id,
          deliveryPolicy: policy.deliveryPolicy,
        });
        api.logger.info?.(
          `subagent-handoff-output-guard: staged ${staged.sourceRelativePath} -> ${staged.requesterRelativePath}`,
        );
      } catch (error) {
        result.acceptedArtifacts = [];
        result.stagedArtifacts = [];
        const issue = {
          sourceRelativePath: policy.sourceRelativePath,
          code:
            error instanceof ArtifactStagingError ? error.code : HANDOFF_ISSUE_CODES.STAGING_FAILED,
          message: error instanceof Error ? error.message : String(error),
        };
        if (
          issue.code === HANDOFF_ISSUE_CODES.FILE_SIZE_REJECTED ||
          issue.code === HANDOFF_ISSUE_CODES.MIME_TYPE_REJECTED ||
          issue.code === HANDOFF_ISSUE_CODES.UNSAFE_ARTIFACT_PATH
        ) {
          result.rejections.push(issue);
        } else {
          result.failures.push(issue);
        }
        result.haltRemainingHandlers = true;
        return result;
      }
    }
    return result;
  }

  async function stageHandoff(event) {
    const enabledChannels = normalizeChannels(api.pluginConfig?.enabledChannels);
    if (!isEnabledForStagingEvent(event, enabledChannels)) return undefined;
    if (event?.signal?.aborted) {
      const result = emptyStagingResult(STAGING_POLICY_STATUSES.UNAVAILABLE);
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.STAGING_ABORTED,
        message: "Artifact staging was aborted",
      });
      return result;
    }

    if (!event?.handoff || typeof event.handoff !== "object") {
      const result = emptyStagingResult(STAGING_POLICY_STATUSES.UNAVAILABLE);
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.HANDOFF_UNAVAILABLE,
        message: "Parsed subagent handoff is unavailable",
      });
      return result;
    }

    const runId = asTrimmedString(event.runId);
    const handoffAt = Number(event.handoffAt);
    const requesterWorkspaceDir = asTrimmedString(event.requesterWorkspaceDir);
    if (!runId || !Number.isFinite(handoffAt) || !requesterWorkspaceDir) {
      const result = emptyStagingResult(STAGING_POLICY_STATUSES.UNAVAILABLE);
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.STAGING_CONTEXT_UNAVAILABLE,
        message: "Run id, handoff timestamp, or requester workspace is unavailable",
      });
      return result;
    }

    const result = emptyStagingResult();
    if (event.deliveryEligible === false) {
      result.rejections.push({
        code: HANDOFF_ISSUE_CODES.RUN_NOT_DELIVERY_ELIGIBLE,
        message:
          "Artifact delivery was disabled because the subagent run did not complete successfully",
      });
      result.haltRemainingHandlers = true;
      return result;
    }
    const handoff = event.handoff;
    const quality = normalizeHandoffQuality(handoff.quality);
    const artifacts = Array.isArray(handoff.artifacts) ? handoff.artifacts : [];
    const acceptedStateArtifacts = [];

    for (const artifact of artifacts) {
      if (event.signal?.aborted) {
        result.acceptedArtifacts = [];
        result.stagedArtifacts = [];
        result.failures.push({
          code: HANDOFF_ISSUE_CODES.STAGING_ABORTED,
          message: "Artifact staging was aborted",
        });
        return result;
      }
      const sourceRelativePath = asTrimmedString(artifact?.relativePath).replaceAll("\\", "/");
      const policy = evaluateArtifactPath(artifact, event);
      if (!policy.accepted) {
        result.rejections.push({
          ...(sourceRelativePath ? { sourceRelativePath } : {}),
          code: policy.code,
          message: policy.message,
        });
        continue;
      }
      if (quality.deliveryStatus === HANDOFF_DELIVERY_STATUSES.BLOCKED) {
        result.rejections.push({
          sourceRelativePath: policy.sourceRelativePath,
          code: HANDOFF_ISSUE_CODES.QUALITY_BLOCKED,
          message: "Blocked handoff artifacts cannot be delivered",
        });
        continue;
      }
      if (!(await requesterCanAccessArtifact(event, policy.requesterRelativePath))) {
        result.rejections.push({
          sourceRelativePath: policy.sourceRelativePath,
          code: HANDOFF_ISSUE_CODES.REQUESTER_ARTIFACT_UNAVAILABLE,
          message: "Artifact is not accessible from the requester workspace",
        });
        continue;
      }
      result.acceptedArtifacts.push({
        sourceRelativePath: policy.sourceRelativePath,
        requesterRelativePath: policy.requesterRelativePath,
        profileId: policy.profile.id,
        deliveryPolicy: policy.deliveryPolicy,
      });
      acceptedStateArtifacts.push({
        sourceRelativePath: policy.sourceRelativePath,
        requesterRelativePath: policy.requesterRelativePath,
        profileId: policy.profile.id,
        deliveryPolicy: policy.deliveryPolicy,
        fileName:
          asTrimmedString(artifact.fileName) || path.posix.basename(policy.sourceRelativePath),
        ...(asTrimmedString(artifact.title) ? { title: asTrimmedString(artifact.title) } : {}),
        ...(asTrimmedString(artifact.mimeType)
          ? { mimeType: asTrimmedString(artifact.mimeType) }
          : {}),
      });
    }

    const allArtifactPathHashes = canonicalHashes(
      artifacts.map((artifact) => {
        const policy = evaluateArtifactPath(artifact, event);
        return policy.requesterRelativePath || artifact?.relativePath;
      }),
      requesterWorkspaceDir,
      api,
      { audit: false },
    );
    const acceptedArtifactPathHashes = canonicalHashes(
      result.acceptedArtifacts.map((artifact) => artifact.requesterRelativePath),
      requesterWorkspaceDir,
      api,
      { audit: false },
    );
    if (event.signal?.aborted) {
      result.acceptedArtifacts = [];
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.STAGING_ABORTED,
        message: "Artifact staging was aborted",
      });
      return result;
    }
    const expiresAt = handoffAt + resolvePendingTtlMs(api);
    const expired = expiresAt <= Date.now();
    if (expired) {
      for (const artifact of result.acceptedArtifacts) {
        result.rejections.push({
          sourceRelativePath: artifact.sourceRelativePath,
          code: HANDOFF_ISSUE_CODES.HANDOFF_EXPIRED,
          message: "Artifact handoff expired before it could be delivered",
        });
      }
      result.acceptedArtifacts = [];
    }
    const deliveryState =
      quality.deliveryStatus === HANDOFF_DELIVERY_STATUSES.BLOCKED
        ? "blocked"
        : result.acceptedArtifacts.length > 0 && !expired
          ? "pending"
          : "superseded";

    const persistConfirmationState =
      shouldPersistFeishuState(event) &&
      acceptedStateArtifacts.some((artifact) => artifact.deliveryPolicy === "confirmation");
    if (!persistConfirmationState) {
      return result;
    }

    try {
      const stateOutcome = await stateStore.persistHandoffState({
        runId,
        handoffAt,
        expiresAt,
        requesterWorkspaceDir,
        peer: resolvePeerFromEvent(event),
        handoff,
        quality,
        acceptedArtifacts: acceptedStateArtifacts,
        artifactPathHashes:
          deliveryState === "pending" ? acceptedArtifactPathHashes : allArtifactPathHashes,
        deliveryState,
        signal: event.signal,
      });
      if (stateOutcome === "aborted") {
        result.acceptedArtifacts = [];
        result.failures.push({
          code: HANDOFF_ISSUE_CODES.STAGING_ABORTED,
          message: "Artifact staging was aborted",
        });
      } else if (stateOutcome === "stale") {
        for (const artifact of result.acceptedArtifacts) {
          result.rejections.push({
            sourceRelativePath: artifact.sourceRelativePath,
            code: HANDOFF_ISSUE_CODES.STALE_HANDOFF,
            message: "A newer handoff already owns the requester state",
          });
        }
        result.acceptedArtifacts = [];
      }
    } catch (error) {
      api.logger.warn?.(
        `subagent-handoff-output-guard: failed to persist handoff state: ${String(error)}`,
      );
      await stateStore.persistFallbackTombstone({
        runId,
        handoffAt,
        expiresAt,
        requesterWorkspaceDir,
        peer: resolvePeerFromEvent(event),
        quality,
        artifactPathHashes: allArtifactPathHashes,
        deliveryState: "superseded",
      });
      result.acceptedArtifacts = [];
      result.stagedArtifacts = [];
      result.failures.push({
        code: HANDOFF_ISSUE_CODES.STATE_PERSIST_FAILED,
        message: error instanceof Error ? error.message : String(error),
      });
      result.haltRemainingHandlers = true;
    }
    return result;
  }

  return {
    preflightHandoff,
    stageHandoffArtifacts,
    stageHandoff,
  };
}

module.exports = {
  createStagingPolicy,
};
