const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  HANDOFF_DELIVERY_STATUSES,
  HANDOFF_VERIFICATION_STATUSES,
} = require("./artifact-handoff-contract.js");
const { canonicalHashes } = require("./artifact-identity.js");
const {
  agentIdFromPeer,
  asTrimmedString,
  deriveExplicitWorkspaceDir,
  deriveWorkspaceDir,
  deriveWorkspaceDirForAgentId,
  formatPeer,
  readConfiguredAgentWorkspace,
  resolvePendingStatePath,
} = require("./runtime-context.js");

const DEFAULT_FALLBACK_TITLE = "交付文件";
const RETRYABLE_DELIVERY_STATES = new Set(["pending", "sending", "failed_retryable"]);
const TOMBSTONE_DELIVERY_STATES = new Set(["blocked", "superseded"]);
const stateLocks = new Map();
const fallbackTombstones = new Map();

function writeJsonAtomic(filePath, value) {
  return (async () => {
    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tmp, filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  })();
}

async function withStateLock(statePath, operation) {
  const previous = stateLocks.get(statePath) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  stateLocks.set(statePath, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stateLocks.get(statePath) === tail) stateLocks.delete(statePath);
  }
}

async function readStateFile(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stateWithRuntimeFields(state, statePath, workspaceDir) {
  return state
    ? {
        ...state,
        __statePath: statePath,
        __workspaceDir: workspaceDir,
      }
    : null;
}

function compareHandoffStateOrder(left, right) {
  const leftAt = Number(left?.handoffAt);
  const rightAt = Number(right?.handoffAt);
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
    return leftAt - rightAt;
  }
  if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) {
    return Number.isFinite(leftAt) ? 1 : -1;
  }
  return asTrimmedString(left?.runId).localeCompare(asTrimmedString(right?.runId));
}

function rememberFallbackTombstone(statePath, state) {
  fallbackTombstones.delete(statePath);
  fallbackTombstones.set(statePath, state);
}

function clearCoveredFallbackTombstone(statePath, state) {
  const fallback = fallbackTombstones.get(statePath);
  if (fallback && compareHandoffStateOrder(state, fallback) >= 0) {
    fallbackTombstones.delete(statePath);
  }
}

async function readLatestHandoffStateEntry(statePath) {
  const persisted = await readStateFile(statePath);
  const fallback = fallbackTombstones.get(statePath);
  if (!fallback) return { state: persisted, statePath };
  if (!persisted || compareHandoffStateOrder(fallback, persisted) >= 0) {
    return { state: fallback, statePath };
  }
  fallbackTombstones.delete(statePath);
  return { state: persisted, statePath };
}

async function readLatestHandoffState(statePath) {
  return (await readLatestHandoffStateEntry(statePath)).state;
}

function buildTombstoneState(params) {
  return {
    runId: params.runId,
    handoffAt: params.handoffAt,
    expiresAt: params.expiresAt,
    deliveryState: params.deliveryState,
    supersedesRunId: params.supersedesRunId || "",
    artifactPathHashes: params.artifactPathHashes,
    supersededArtifactPathHashes: params.supersededArtifactPathHashes || [],
    peer: formatPeer(params.peer),
    lastTarget: params.peer?.id || "",
    verificationStatus: params.quality.verificationStatus,
    deliveryStatus: params.quality.deliveryStatus,
    updatedAt: Date.now(),
    source: "subagent-handoff-output-guard",
  };
}

function buildPendingState(params) {
  const primary = params.acceptedArtifacts[0];
  return {
    runId: params.runId,
    handoffAt: params.handoffAt,
    expiresAt: params.expiresAt,
    deliveryState: "pending",
    supersedesRunId: params.supersedesRunId || "",
    artifactPathHashes: params.artifactPathHashes,
    supersededArtifactPathHashes: params.supersededArtifactPathHashes || [],
    peer: formatPeer(params.peer),
    lastTarget: params.peer?.id || "",
    exportPath: primary?.requesterRelativePath || "",
    exportPaths: params.acceptedArtifacts.map((entry) => entry.requesterRelativePath),
    exports: params.acceptedArtifacts.map((entry) => ({
      path: entry.requesterRelativePath,
      sourceRelativePath: entry.sourceRelativePath,
      fileName: entry.fileName || path.posix.basename(entry.requesterRelativePath),
      title: entry.title || "",
      mime: entry.mimeType || "",
    })),
    title: primary?.title || primary?.fileName || DEFAULT_FALLBACK_TITLE,
    mime: primary?.mimeType || "",
    mode: asTrimmedString(params.handoff.mode).toLowerCase() || "export-file",
    verificationStatus: params.quality.verificationStatus,
    verificationSummary: params.quality.verificationSummary || "",
    deliveryStatus: params.quality.deliveryStatus,
    profileId: primary?.profileId || "",
    deliveryPolicy: primary?.deliveryPolicy || "confirmation",
    lastToolCallId: "",
    lastToolCallRunId: "",
    stagedPath: "",
    stagedPaths: [],
    messageId: "",
    lastError: "",
    updatedAt: Date.now(),
    source: "subagent-handoff-output-guard",
  };
}

function listStateExportPaths(state) {
  if (Array.isArray(state?.exportPaths)) {
    return state.exportPaths.map(asTrimmedString).filter(Boolean);
  }
  const single = asTrimmedString(state?.exportPath);
  return single ? [single] : [];
}

function listStateArtifactHashes(state) {
  return Array.isArray(state?.artifactPathHashes)
    ? state.artifactPathHashes.map(asTrimmedString).filter(Boolean)
    : [];
}

function listStateSupersededArtifactHashes(state) {
  return Array.isArray(state?.supersededArtifactPathHashes)
    ? state.supersededArtifactPathHashes.map(asTrimmedString).filter(Boolean)
    : [];
}

function createHandoffStateStore(api) {
  async function persistHandoffState(params) {
    const statePath = resolvePendingStatePath(params.requesterWorkspaceDir, api);
    if (!statePath) throw new Error("Pending state path is unavailable");

    return withStateLock(statePath, async () => {
      if (params.signal?.aborted) return "aborted";
      const current = await readLatestHandoffState(statePath);
      const currentHandoffAt = Number(current?.handoffAt);
      const currentRunId = asTrimmedString(current?.runId);
      const upgradesReservation =
        currentRunId === params.runId && current?.stagingReservation === true;
      if (currentRunId === params.runId && !upgradesReservation) {
        api.logger.info?.(
          `subagent-handoff-output-guard: ignored idempotent handoff replay ${params.runId}`,
        );
        return "replay";
      }
      if (
        Number.isFinite(currentHandoffAt) &&
        (params.handoffAt < currentHandoffAt ||
          (params.handoffAt === currentHandoffAt &&
            currentRunId &&
            params.runId.localeCompare(currentRunId) < 0))
      ) {
        api.logger.info?.(`subagent-handoff-output-guard: ignored stale handoff ${params.runId}`);
        return "stale";
      }

      const currentArtifactPathHashes = Array.isArray(current?.artifactPathHashes)
        ? current.artifactPathHashes.map(asTrimmedString).filter(Boolean)
        : canonicalHashes(
            Array.isArray(current?.exportPaths) ? current.exportPaths : [current?.exportPath],
            params.requesterWorkspaceDir,
            api,
            { audit: false },
          );
      const currentSupersededArtifactPathHashes = Array.isArray(
        current?.supersededArtifactPathHashes,
      )
        ? current.supersededArtifactPathHashes.map(asTrimmedString).filter(Boolean)
        : [];
      const artifactPathHashes =
        params.deliveryState === "pending"
          ? params.artifactPathHashes
          : [...new Set([...currentArtifactPathHashes, ...params.artifactPathHashes])];
      const nextArtifactPathHashes = new Set(params.artifactPathHashes);
      const supersededArtifactPathHashes = [
        ...new Set([...currentSupersededArtifactPathHashes, ...currentArtifactPathHashes]),
      ].filter((hash) => !nextArtifactPathHashes.has(hash));
      const common = {
        runId: params.runId,
        handoffAt: params.handoffAt,
        expiresAt: params.expiresAt,
        supersedesRunId: upgradesReservation
          ? asTrimmedString(current?.supersedesRunId)
          : currentRunId,
        artifactPathHashes,
        supersededArtifactPathHashes,
        peer: params.peer,
        quality: params.quality,
      };
      const state =
        params.deliveryState === "pending"
          ? buildPendingState({
              ...common,
              acceptedArtifacts: params.acceptedArtifacts,
              handoff: params.handoff,
            })
          : buildTombstoneState({
              ...common,
              deliveryState: params.deliveryState,
            });
      if (params.signal?.aborted) return "aborted";
      await writeJsonAtomic(statePath, state);
      clearCoveredFallbackTombstone(statePath, state);
      api.logger.info?.(
        `subagent-handoff-output-guard: persisted ${state.deliveryState} handoff ${params.runId}`,
      );
      return "written";
    });
  }

  async function reserveHandoffState(params) {
    const statePath = resolvePendingStatePath(params.requesterWorkspaceDir, api);
    if (!statePath) throw new Error("Pending state path is unavailable");

    return withStateLock(statePath, async () => {
      if (params.signal?.aborted) return "aborted";
      const current = await readLatestHandoffState(statePath);
      const currentHandoffAt = Number(current?.handoffAt);
      const currentRunId = asTrimmedString(current?.runId);
      if (currentRunId === params.runId) return "replay";
      if (
        Number.isFinite(currentHandoffAt) &&
        (params.handoffAt < currentHandoffAt ||
          (params.handoffAt === currentHandoffAt &&
            currentRunId &&
            params.runId.localeCompare(currentRunId) < 0))
      ) {
        return "stale";
      }

      const currentArtifactPathHashes = Array.isArray(current?.artifactPathHashes)
        ? current.artifactPathHashes.map(asTrimmedString).filter(Boolean)
        : canonicalHashes(
            Array.isArray(current?.exportPaths) ? current.exportPaths : [current?.exportPath],
            params.requesterWorkspaceDir,
            api,
            { audit: false },
          );
      const currentSupersededArtifactPathHashes = Array.isArray(
        current?.supersededArtifactPathHashes,
      )
        ? current.supersededArtifactPathHashes.map(asTrimmedString).filter(Boolean)
        : [];
      const reservation = buildTombstoneState({
        runId: params.runId,
        handoffAt: params.handoffAt,
        expiresAt: params.expiresAt,
        deliveryState: "superseded",
        supersedesRunId: currentRunId,
        artifactPathHashes: [
          ...new Set([...currentArtifactPathHashes, ...params.artifactPathHashes]),
        ],
        supersededArtifactPathHashes: currentSupersededArtifactPathHashes,
        peer: params.peer,
        quality: params.quality,
      });
      reservation.stagingReservation = true;
      if (params.signal?.aborted) return "aborted";
      await writeJsonAtomic(statePath, reservation);
      clearCoveredFallbackTombstone(statePath, reservation);
      return "reserved";
    });
  }

  async function persistFallbackTombstone(params) {
    const statePath = resolvePendingStatePath(params.requesterWorkspaceDir, api);
    if (!statePath) return;
    const current = await readLatestHandoffState(statePath);
    const currentArtifactPathHashes = Array.isArray(current?.artifactPathHashes)
      ? current.artifactPathHashes.map(asTrimmedString).filter(Boolean)
      : canonicalHashes(
          Array.isArray(current?.exportPaths) ? current.exportPaths : [current?.exportPath],
          params.requesterWorkspaceDir,
          api,
          { audit: false },
        );
    const state = buildTombstoneState({
      runId: params.runId,
      handoffAt: params.handoffAt,
      expiresAt: params.expiresAt,
      deliveryState: params.deliveryState,
      supersedesRunId: asTrimmedString(current?.runId),
      artifactPathHashes: [
        ...new Set([...currentArtifactPathHashes, ...params.artifactPathHashes]),
      ],
      supersededArtifactPathHashes: Array.isArray(current?.supersededArtifactPathHashes)
        ? current.supersededArtifactPathHashes.map(asTrimmedString).filter(Boolean)
        : [],
      peer: params.peer,
      quality: params.quality,
    });
    rememberFallbackTombstone(statePath, state);
    if (RETRYABLE_DELIVERY_STATES.has(asTrimmedString(current?.deliveryState))) {
      await fs.rm(statePath, { force: true }).catch(() => {});
    }
    api.logger.warn?.(
      `subagent-handoff-output-guard: installed in-memory tombstone for ${params.runId}`,
    );
  }

  async function supersedePendingConfirmationState(params) {
    const statePath = resolvePendingStatePath(params.requesterWorkspaceDir, api);
    if (!statePath) return;
    await withStateLock(statePath, async () => {
      if (params.signal?.aborted) return;
      const current = await readLatestHandoffState(statePath);
      if (!current || !RETRYABLE_DELIVERY_STATES.has(asTrimmedString(current.deliveryState))) {
        return;
      }
      const currentHandoffAt = Number(current.handoffAt);
      const currentRunId = asTrimmedString(current.runId);
      if (
        Number.isFinite(currentHandoffAt) &&
        (params.handoffAt < currentHandoffAt ||
          (params.handoffAt === currentHandoffAt &&
            currentRunId &&
            params.runId.localeCompare(currentRunId) <= 0))
      ) {
        return;
      }
      const artifactPathHashes = Array.isArray(current.artifactPathHashes)
        ? current.artifactPathHashes.map(asTrimmedString).filter(Boolean)
        : canonicalHashes(
            Array.isArray(current.exportPaths) ? current.exportPaths : [current.exportPath],
            params.requesterWorkspaceDir,
            api,
            { audit: false },
          );
      const state = buildTombstoneState({
        runId: params.runId,
        handoffAt: params.handoffAt,
        expiresAt: params.expiresAt,
        deliveryState: "superseded",
        supersedesRunId: currentRunId,
        artifactPathHashes,
        supersededArtifactPathHashes: Array.isArray(current.supersededArtifactPathHashes)
          ? current.supersededArtifactPathHashes.map(asTrimmedString).filter(Boolean)
          : [],
        peer: params.peer,
        quality: params.quality,
      });
      await writeJsonAtomic(statePath, state);
      clearCoveredFallbackTombstone(statePath, state);
    });
  }

  async function expireRetryableState(state) {
    const expiresAt = Number(state?.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() <= expiresAt) return state;
    if (!RETRYABLE_DELIVERY_STATES.has(asTrimmedString(state.deliveryState))) {
      return { ...state, __expired: true };
    }

    return withStateLock(state.__statePath, async () => {
      const current = await readStateFile(state.__statePath);
      if (
        asTrimmedString(current?.runId) !== asTrimmedString(state.runId) ||
        Number(current?.handoffAt) !== Number(state.handoffAt)
      ) {
        return stateWithRuntimeFields(current, state.__statePath, state.__workspaceDir);
      }
      const next = buildTombstoneState({
        runId: state.runId,
        handoffAt: state.handoffAt,
        expiresAt: state.expiresAt,
        deliveryState: "superseded",
        supersedesRunId: state.supersedesRunId,
        artifactPathHashes: Array.isArray(state.artifactPathHashes) ? state.artifactPathHashes : [],
        supersededArtifactPathHashes: Array.isArray(state.supersededArtifactPathHashes)
          ? state.supersededArtifactPathHashes
          : [],
        peer: null,
        quality: {
          verificationStatus: state.verificationStatus || HANDOFF_VERIFICATION_STATUSES.UNKNOWN,
          verificationSummary: state.verificationSummary || "",
          deliveryStatus: state.deliveryStatus || HANDOFF_DELIVERY_STATUSES.UNMANAGED,
        },
      });
      next.peer = asTrimmedString(state.peer);
      next.lastTarget = asTrimmedString(state.lastTarget);
      await writeJsonAtomic(state.__statePath, next);
      return {
        ...stateWithRuntimeFields(next, state.__statePath, state.__workspaceDir),
        __expired: true,
      };
    });
  }

  async function readPendingStateFromWorkspace(workspaceDir) {
    const statePath = resolvePendingStatePath(workspaceDir, api);
    if (!statePath) return null;
    return withStateLock(statePath, async () => {
      const latest = await readLatestHandoffStateEntry(statePath);
      return stateWithRuntimeFields(latest.state, latest.statePath, workspaceDir);
    });
  }

  async function readPendingState(ctx, options = {}) {
    const candidates = [];
    const pushUnique = (value) => {
      if (!value || candidates.includes(value)) return;
      candidates.push(value);
    };
    const explicitWorkspaceDir = deriveExplicitWorkspaceDir(ctx);
    const peerAgentId = agentIdFromPeer(options.peer);
    pushUnique(readConfiguredAgentWorkspace(peerAgentId, api));
    pushUnique(explicitWorkspaceDir);
    if (!explicitWorkspaceDir) {
      pushUnique(deriveWorkspaceDirForAgentId(peerAgentId, api));
    }
    pushUnique(deriveWorkspaceDir(ctx, api));

    for (const workspaceDir of candidates) {
      const state = await readPendingStateFromWorkspace(workspaceDir);
      if (state) return expireRetryableState(state);
    }
    return null;
  }

  async function updateStateIfCurrent(state, predicate, patch) {
    if (!state?.__statePath) return null;
    return withStateLock(state.__statePath, async () => {
      const current = await readStateFile(state.__statePath);
      if (
        asTrimmedString(current?.runId) !== asTrimmedString(state.runId) ||
        Number(current?.handoffAt) !== Number(state.handoffAt) ||
        !predicate(current)
      ) {
        return stateWithRuntimeFields(current, state.__statePath, state.__workspaceDir);
      }
      const next = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      await writeJsonAtomic(state.__statePath, next);
      return stateWithRuntimeFields(next, state.__statePath, state.__workspaceDir);
    });
  }

  return {
    persistFallbackTombstone,
    persistHandoffState,
    readPendingState,
    reserveHandoffState,
    supersedePendingConfirmationState,
    updateStateIfCurrent,
  };
}

module.exports = {
  DEFAULT_FALLBACK_TITLE,
  RETRYABLE_DELIVERY_STATES,
  TOMBSTONE_DELIVERY_STATES,
  createHandoffStateStore,
  listStateArtifactHashes,
  listStateExportPaths,
  listStateSupersededArtifactHashes,
};
