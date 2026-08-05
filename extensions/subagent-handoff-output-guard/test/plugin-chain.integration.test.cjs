const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const registerGuard = require("../index.js");
const {
  ARTIFACT_PROFILE_IDS,
  HANDOFF_GATES,
  HANDOFF_ISSUE_CODES,
  HANDOFF_VERIFICATION_STATUSES,
  HANDOFF_DELIVERY_STATUSES,
  STAGING_POLICY_STATUSES,
} = require("../lib/artifact-handoff-contract.js");
const { createRuntime } = require("./runtime-harness.cjs");

const STAGING_PREFIX = "artifacts/imports/subagent";
const PLUGIN_CONFIG = {
  stagingPrefix: STAGING_PREFIX,
  maxArtifactsPerHandoff: 1,
  artifactProfiles: [
    {
      id: ARTIFACT_PROFILE_IDS.GENERIC_SUBAGENT_ARTIFACT,
      prefix: STAGING_PREFIX,
      allowedExtensions: [".md"],
      allowedMimeTypes: ["text/markdown"],
      maxArtifacts: 1,
      maxBytes: 30 * 1024 * 1024,
      requireFileNameMatchPath: true,
      deliveryPolicy: "auto",
    },
  ],
};

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-handoff-chain-"));
  try {
    await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function createHarness(pluginConfig = PLUGIN_CONFIG) {
  const handlers = [];
  registerGuard({
    pluginConfig,
    config: {},
    runtime: createRuntime(),
    logger: { info() {}, warn() {}, error() {} },
    on(hookName, handler, options = {}) {
      if (hookName !== "subagent_handoff_staging") return;
      handlers.push({
        pluginId: "subagent-handoff-output-guard",
        priority: options.priority || 0,
        handler,
      });
    },
  });

  const ordered = [...handlers].sort((left, right) => right.priority - left.priority);
  return {
    registrations: ordered.map(({ pluginId, priority }) => ({ pluginId, priority })),
    async run(event) {
      const executionOrder = [];
      let merged;
      for (const entry of ordered) {
        executionOrder.push(entry.priority);
        const next = await entry.handler(event, {});
        if (!next) continue;

        const acceptedArtifacts = new Map(
          (merged?.acceptedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.acceptedArtifacts || []) {
          const current = acceptedArtifacts.get(artifact.sourceRelativePath);
          acceptedArtifacts.set(
            artifact.sourceRelativePath,
            current ? { ...artifact, ...current } : artifact,
          );
        }

        const stagedArtifacts = new Map(
          (merged?.stagedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.stagedArtifacts || []) {
          const current = stagedArtifacts.get(artifact.sourceRelativePath);
          stagedArtifacts.set(
            artifact.sourceRelativePath,
            current ? { ...artifact, ...current } : artifact,
          );
        }

        const haltRemainingHandlers = Boolean(
          merged?.haltRemainingHandlers || next.haltRemainingHandlers,
        );
        if (haltRemainingHandlers) {
          acceptedArtifacts.clear();
          stagedArtifacts.clear();
        }
        merged = {
          policyStatus:
            merged?.policyStatus === STAGING_POLICY_STATUSES.EVALUATED ||
            next.policyStatus === STAGING_POLICY_STATUSES.EVALUATED
              ? STAGING_POLICY_STATUSES.EVALUATED
              : STAGING_POLICY_STATUSES.UNAVAILABLE,
          acceptedArtifacts: [...acceptedArtifacts.values()],
          stagedArtifacts: [...stagedArtifacts.values()],
          rejections: [...(merged?.rejections || []), ...(next.rejections || [])],
          failures: [...(merged?.failures || []), ...(next.failures || [])],
          ...(haltRemainingHandlers ? { haltRemainingHandlers: true } : {}),
        };
        if (next.haltRemainingHandlers) break;
      }
      return { executionOrder, result: merged };
    },
  };
}

function createEvent(childWorkspaceDir, requesterWorkspaceDir, relativePath, overrides = {}) {
  return {
    runId: overrides.runId || "researcher-run-1",
    handoffAt: Date.now(),
    childSessionKey: "agent:researcher:subagent:child-1",
    requesterSessionKey: "agent:main:webchat:client-1:chat-1",
    requesterOrigin: { channel: "webchat" },
    childWorkspaceDir,
    requesterWorkspaceDir,
    content: "Research complete",
    handoff: {
      mode: "export-file",
      summary: "Research complete",
      quality: {
        gate: HANDOFF_GATES.UNMANAGED,
        verificationStatus: HANDOFF_VERIFICATION_STATUSES.UNKNOWN,
        deliveryStatus: HANDOFF_DELIVERY_STATUSES.UNMANAGED,
      },
      artifacts: [
        {
          relativePath,
          fileName: path.posix.basename(relativePath),
          title: "Research report",
          mimeType: "text/markdown",
        },
      ],
      omittedArtifactCount: 0,
    },
    deliveryEligible: overrides.deliveryEligible ?? true,
    outcome: "ok",
    completionDelivery: "direct",
  };
}

test("guard chain executes 200 -> 100 -> 0 and delivers only the controlled copy", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspaceDir = path.join(tmpRoot, "workspace-main");
    const relativePath = "reports/research-report.md";
    const requesterRelativePath = "artifacts/imports/subagent/researcher-run-1/research-report.md";
    const sourcePath = path.join(childWorkspaceDir, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# report\n", "utf8");

    const harness = createHarness();
    assert.deepEqual(harness.registrations, [
      { pluginId: "subagent-handoff-output-guard", priority: 200 },
      { pluginId: "subagent-handoff-output-guard", priority: 100 },
      { pluginId: "subagent-handoff-output-guard", priority: 0 },
    ]);

    const { executionOrder, result } = await harness.run(
      createEvent(childWorkspaceDir, requesterWorkspaceDir, relativePath),
    );

    assert.deepEqual(executionOrder, [200, 100, 0]);
    assert.deepEqual(result, {
      policyStatus: STAGING_POLICY_STATUSES.EVALUATED,
      acceptedArtifacts: [
        {
          sourceRelativePath: relativePath,
          requesterRelativePath,
          profileId: ARTIFACT_PROFILE_IDS.GENERIC_SUBAGENT_ARTIFACT,
          deliveryPolicy: "auto",
        },
      ],
      stagedArtifacts: [
        {
          sourceRelativePath: relativePath,
          relativePath: requesterRelativePath,
          fileName: "research-report.md",
          title: "Research report",
          mimeType: "text/markdown",
          profileId: ARTIFACT_PROFILE_IDS.GENERIC_SUBAGENT_ARTIFACT,
          deliveryPolicy: "auto",
        },
      ],
      rejections: [],
      failures: [],
    });
    assert.equal(
      await fs.readFile(path.join(requesterWorkspaceDir, requesterRelativePath), "utf8"),
      "# report\n",
    );
  });
});

test("priority 200 terminal preflight prevents lower-priority staging side effects", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspaceDir = path.join(tmpRoot, "workspace-main");
    const relativePath = "output/blocked.md";
    const sourcePath = path.join(childWorkspaceDir, relativePath);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# blocked\n", "utf8");

    const harness = createHarness();
    const { executionOrder, result } = await harness.run(
      createEvent(childWorkspaceDir, requesterWorkspaceDir, relativePath, {
        runId: "ineligible-run",
        deliveryEligible: false,
      }),
    );

    assert.deepEqual(executionOrder, [200]);
    assert.equal(result.haltRemainingHandlers, true);
    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.rejections[0].code, HANDOFF_ISSUE_CODES.RUN_NOT_DELIVERY_ELIGIBLE);
    await assert.rejects(
      fs.readFile(
        path.join(requesterWorkspaceDir, "artifacts/imports/subagent/ineligible-run/blocked.md"),
      ),
      /ENOENT/,
    );
  });
});
