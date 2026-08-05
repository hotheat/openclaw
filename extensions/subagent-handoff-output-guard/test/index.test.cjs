const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const register = require("../index.js");
const {
  DEFAULT_ARTIFACT_PROFILES,
  evaluateArtifactProfile,
  resolveArtifactProfiles,
} = require("../lib/artifact-profiles.js");
const { normalizeHandoffQuality } = require("../lib/artifact-handoff-contract.js");
const { resolveDeliveryPolicy } = require("../lib/delivery-policy.js");
const { createOoxmlBuffer, createRuntime } = require("./runtime-harness.cjs");

const STATE_PATH = path.join(".artifacts", "state", "pending-artifact-handoff.json");
const STAGING_PREFIX = "artifacts/imports/subagent";
const CONFIRMATION_PROFILES = DEFAULT_ARTIFACT_PROFILES.map((profile) => ({
  ...profile,
  deliveryPolicy: "confirmation",
}));

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-output-guard-"));
  try {
    await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function createHarness(pluginConfig = {}, config = {}) {
  const handlers = new Map();
  const logs = { info: [], warn: [] };
  const api = {
    pluginConfig: {
      ...pluginConfig,
      artifactProfiles: pluginConfig.artifactProfiles ?? CONFIRMATION_PROFILES,
    },
    config,
    runtime: createRuntime(),
    logger: {
      info(message) {
        logs.info.push(String(message));
      },
      warn(message) {
        logs.warn.push(String(message));
      },
    },
    on(eventName, handler, opts) {
      const entries = handlers.get(eventName) || [];
      entries.push({ handler, opts });
      handlers.set(eventName, entries);
    },
  };
  register(api);
  return {
    logs,
    async call(name, event, ctx) {
      const entries = handlers.get(name);
      assert.ok(entries?.length, `missing hook: ${name}`);
      const ordered = [...entries].sort(
        (left, right) => (right.opts?.priority || 0) - (left.opts?.priority || 0),
      );
      if (name !== "subagent_handoff_staging") {
        return ordered[0].handler(event, ctx);
      }

      let merged;
      for (const entry of ordered) {
        const next = await entry.handler(event, ctx);
        if (!next) continue;
        const acceptedArtifacts = new Map(
          (merged?.acceptedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.acceptedArtifacts || []) {
          if (!acceptedArtifacts.has(artifact.sourceRelativePath)) {
            acceptedArtifacts.set(artifact.sourceRelativePath, artifact);
          }
        }
        const stagedArtifacts = new Map(
          (merged?.stagedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.stagedArtifacts || []) {
          if (!stagedArtifacts.has(artifact.sourceRelativePath)) {
            stagedArtifacts.set(artifact.sourceRelativePath, artifact);
          }
        }
        merged = {
          policyStatus:
            merged?.policyStatus === "evaluated" || next.policyStatus === "evaluated"
              ? "evaluated"
              : "unavailable",
          acceptedArtifacts: [...acceptedArtifacts.values()],
          stagedArtifacts: [...stagedArtifacts.values()],
          rejections: [...(merged?.rejections || []), ...(next.rejections || [])],
          failures: [...(merged?.failures || []), ...(next.failures || [])],
          ...(merged?.haltRemainingHandlers || next.haltRemainingHandlers
            ? { haltRemainingHandlers: true }
            : {}),
        };
        if (next.haltRemainingHandlers) break;
      }
      return merged;
    },
  };
}

function createMultiArtifactHarness() {
  return createHarness({
    maxArtifactsPerHandoff: 2,
    artifactProfiles: [
      {
        id: "researcher-export",
        prefix: "artifacts/exports/feishu",
        enabled: false,
      },
      {
        id: "multi-export",
        prefix: "artifacts/exports/feishu",
        allowedExtensions: [".csv"],
        allowedMimeTypes: ["text/csv"],
        maxArtifacts: 2,
        requireAsciiSlugBasename: true,
        requireFileNameMatchPath: false,
        deliveryPolicy: "confirmation",
      },
    ],
  });
}

function quality(deliveryStatus) {
  if (deliveryStatus === "unmanaged") {
    return {
      gate: "unmanaged",
      verificationStatus: "unknown",
      deliveryStatus,
    };
  }
  if (deliveryStatus === "warning") {
    return {
      gate: "managed",
      verificationStatus: "failed",
      verificationSummary: "slide overflow",
      deliveryStatus,
    };
  }
  return {
    gate: "managed",
    verificationStatus: deliveryStatus === "ready" ? "passed" : "failed",
    deliveryStatus,
  };
}

function createHandoff(relativePath, deliveryStatus = "ready", overrides = {}) {
  return {
    mode: "export-file",
    summary: "done",
    quality: quality(deliveryStatus),
    artifacts: relativePath
      ? [
          {
            relativePath,
            fileName: path.posix.basename(relativePath),
            title: "Demo artifact",
            mimeType: relativePath.endsWith(".pptx")
              ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
              : "text/markdown",
          },
        ]
      : [],
    omittedArtifactCount: 0,
    ...overrides,
  };
}

function createStagingEvent(workspaceDir, options = {}) {
  const relativePath = options.relativePath || "artifacts/pptx-generator/run-1/deck-title.pptx";
  return {
    runId: options.runId || "handoff-run-1",
    handoffAt: options.handoffAt ?? Date.now(),
    childSessionKey: "agent:researcher:subagent:child-1",
    requesterSessionKey:
      options.requesterSessionKey || "agent:feishu-ou_test:feishu:direct:ou_test",
    requesterOrigin:
      options.requesterOrigin === undefined
        ? { channel: "feishu", to: "ou_test" }
        : options.requesterOrigin,
    childWorkspaceDir: workspaceDir,
    requesterWorkspaceDir: workspaceDir,
    content: "<SUBAGENT_HANDOFF>{malformed and intentionally ignored}</SUBAGENT_HANDOFF>",
    handoff: options.handoff || createHandoff(relativePath, options.deliveryStatus || "ready"),
    deliveryEligible: options.deliveryEligible ?? true,
    outcome: "ok",
    completionDelivery: "direct",
  };
}

function hookContext(workspaceDir, runId = "parent-turn-1") {
  return {
    runId,
    channelId: "feishu",
    agentId: "feishu-ou_test",
    workspaceDir,
  };
}

async function readState(workspaceDir) {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, STATE_PATH), "utf8"));
}

async function writeArtifact(workspaceDir, relativePath) {
  const artifactPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  const ooxml = await createOoxmlBuffer(path.extname(relativePath).toLowerCase());
  await fs.writeFile(artifactPath, ooxml || "artifact\n");
}

function stagedArtifactPath(runId, sourceRelativePath) {
  return path.posix.join(STAGING_PREFIX, runId, path.posix.basename(sourceRelativePath));
}

async function stage(h, workspaceDir, options = {}) {
  const relativePath = options.relativePath || "artifacts/pptx-generator/run-1/deck-title.pptx";
  if (options.createArtifact !== false && relativePath) {
    await writeArtifact(workspaceDir, relativePath);
  }
  return h.call(
    "subagent_handoff_staging",
    createStagingEvent(workspaceDir, options),
    hookContext(workspaceDir),
  );
}

async function startSend(h, workspaceDir, relativePath, options = {}) {
  const toolCallId = options.toolCallId || "tool-call-1";
  const runId = options.runId || "parent-turn-1";
  let requesterRelativePath = relativePath;
  try {
    const state = await readState(workspaceDir);
    const matchedExport = Array.isArray(state.exports)
      ? state.exports.find((entry) => entry.sourceRelativePath === relativePath)
      : undefined;
    requesterRelativePath = matchedExport?.path || requesterRelativePath;
  } catch {}
  const event = {
    toolName: "message",
    toolCallId,
    runId,
    params: {
      action: "send",
      channel: "feishu",
      target: "ou_test",
      filePath: options.absolute
        ? path.join(workspaceDir, requesterRelativePath)
        : requesterRelativePath,
    },
  };
  const result = await h.call("before_tool_call", event, hookContext(workspaceDir, runId));
  return { event, result };
}

test("built-in artifact profiles accept title-derived filenames and enforce metadata", () => {
  const profiles = resolveArtifactProfiles();
  assert.deepEqual(
    profiles.map((profile) => [profile.id, profile.deliveryPolicy]),
    [
      ["researcher-export", "auto"],
      ["pptx-generator", "auto"],
      ["pptx-restyle", "auto"],
    ],
  );

  const researcher = evaluateArtifactProfile({
    relativePath: "artifacts/exports/feishu/run-1/nsclc-pd1-response.md",
    fileName: "nsclc-pd1-response.md",
    mimeType: "text/markdown",
    childSessionKey: "agent:researcher:subagent:child",
  });
  assert.equal(researcher.accepted, true);
  assert.equal(researcher.profile.id, "researcher-export");

  const wrongProducer = evaluateArtifactProfile({
    relativePath: "artifacts/exports/feishu/run-1/nsclc-pd1-response.md",
    mimeType: "text/markdown",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(wrongProducer.accepted, false);
  assert.equal(wrongProducer.code, "producer-agent-rejected");

  const titleDeck = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    fileName: "nsclc-pd1-response.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(titleDeck.accepted, true);
  assert.equal(titleDeck.profile.id, "pptx-generator");

  const wrongExtension = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pdf",
    mimeType: "application/pdf",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(wrongExtension.accepted, false);
  assert.equal(wrongExtension.code, "file-extension-rejected");

  const wrongMime = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    mimeType: "application/octet-stream",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(wrongMime.accepted, false);
  assert.equal(wrongMime.code, "mime-type-rejected");

  const nonSlugName = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/NSCLC_response.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(nonSlugName.accepted, false);
  assert.equal(nonSlugName.code, "file-name-rejected");

  const renamedDelivery = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    fileName: "final.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(renamedDelivery.accepted, false);
  assert.equal(renamedDelivery.code, "file-name-rejected");

  const legacyResearcher = evaluateArtifactProfile({
    relativePath: "artifacts/exports/feishu/run-legacy/report.md",
    mimeType: "text/markdown",
    childSessionKey: "agent:researcher:subagent:child",
  });
  assert.equal(legacyResearcher.accepted, true);

  const legacyDeck = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-legacy/final.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(legacyDeck.accepted, true);

  const missingLegacyMime = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-legacy/final.pptx",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(missingLegacyMime.accepted, false);
  assert.equal(missingLegacyMime.code, "mime-type-rejected");

  const missingResearcherMime = evaluateArtifactProfile({
    relativePath: "artifacts/exports/feishu/run-1/nsclc-pd1-response.md",
    childSessionKey: "agent:researcher:subagent:child",
  });
  assert.equal(missingResearcherMime.accepted, false);
  assert.equal(missingResearcherMime.code, "mime-type-rejected");

  const missingDeckMime = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    childSessionKey: "agent:main:subagent:child",
  });
  assert.equal(missingDeckMime.accepted, false);
  assert.equal(missingDeckMime.code, "mime-type-rejected");
});

test("legacy prefix configuration no longer injects a final.pptx basename requirement", () => {
  const [profile] = resolveArtifactProfiles({
    exportPrefixes: ["artifacts/pptx-generator"],
  });
  assert.equal(profile.requiredBasename, "");

  const evaluation = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    childSessionKey: "agent:main:subagent:child",
    config: {
      exportPrefixes: ["artifacts/pptx-generator"],
    },
  });
  assert.equal(evaluation.accepted, true);
});

test("legacy PPTX profile overrides migrate away from requiredBasename final.pptx", () => {
  const config = {
    artifactProfiles: [
      {
        id: "pptx-generator",
        prefix: "artifacts/pptx-generator",
        requiredBasename: "final.pptx",
      },
    ],
  };
  const profile = resolveArtifactProfiles(config).find((item) => item.id === "pptx-generator");
  assert.equal(profile.requiredBasename, "");

  const evaluation = evaluateArtifactProfile({
    relativePath: "artifacts/pptx-generator/run-1/nsclc-pd1-response.pptx",
    fileName: "nsclc-pd1-response.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    childSessionKey: "agent:main:subagent:child",
    config,
  });
  assert.equal(evaluation.accepted, true);
});

test("handoff quality normalization preserves case-insensitive status semantics", () => {
  assert.deepEqual(
    normalizeHandoffQuality({
      gate: "UNMANAGED",
      verificationStatus: "Passed",
      deliveryStatus: "READY",
    }),
    {
      gate: "unmanaged",
      verificationStatus: "passed",
      verificationSummary: "",
      deliveryStatus: "ready",
    },
  );
});

test("delivery policy supports channel overrides", () => {
  const profile = {
    deliveryPolicy: "confirmation",
    channelPolicies: { webchat: "auto" },
  };
  assert.equal(
    resolveDeliveryPolicy(profile, {
      requesterSessionKey: "agent:main:webchat:namespace:chat",
      requesterOrigin: { channel: "internal" },
    }),
    "auto",
  );
  assert.equal(
    resolveDeliveryPolicy(profile, {
      requesterSessionKey: "agent:main:feishu:direct:ou_1",
      requesterOrigin: { channel: "feishu" },
    }),
    "confirmation",
  );
});

test("auto delivery profiles attach metadata without creating confirmation state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ artifactProfiles: DEFAULT_ARTIFACT_PROFILES });
    const relativePath = "artifacts/pptx-generator/run-auto/market-landscape.pptx";
    const result = await stage(h, workspaceDir, {
      runId: "auto-run",
      relativePath,
    });

    assert.deepEqual(result.acceptedArtifacts, [
      {
        sourceRelativePath: relativePath,
        requesterRelativePath: stagedArtifactPath("auto-run", relativePath),
        profileId: "pptx-generator",
        deliveryPolicy: "auto",
      },
    ]);
    await assert.rejects(fs.readFile(path.join(workspaceDir, STATE_PATH)), /ENOENT/);
  });
});

test("profile preflight rejects multiple primary PPTX artifacts", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ artifactProfiles: DEFAULT_ARTIFACT_PROFILES });
    const firstPath = "artifacts/pptx-generator/run-auto/market-landscape.pptx";
    const secondPath = "artifacts/pptx-generator/run-auto/market-landscape-appendix.pptx";
    const handoff = createHandoff(firstPath, "ready", {
      artifacts: [createHandoff(firstPath).artifacts[0], createHandoff(secondPath).artifacts[0]],
    });
    const result = await stage(h, workspaceDir, {
      relativePath: firstPath,
      handoff,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.haltRemainingHandlers, true);
    assert.equal(result.rejections[0].code, "artifact-count-rejected");
  });
});

test("profile preflight rejects primary PPTX artifacts split across profiles", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ artifactProfiles: DEFAULT_ARTIFACT_PROFILES });
    const generatorPath = "artifacts/pptx-generator/run-auto/market-landscape.pptx";
    const restylePath = "artifacts/pptx-restyle/run-auto/market-landscape-restyled.pptx";
    const handoff = createHandoff(generatorPath, "ready", {
      artifacts: [
        createHandoff(generatorPath).artifacts[0],
        createHandoff(restylePath).artifacts[0],
      ],
    });
    const result = await stage(h, workspaceDir, {
      relativePath: generatorPath,
      handoff,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.haltRemainingHandlers, true);
    assert.equal(result.rejections[0].code, "artifact-count-rejected");
  });
});

test("primary PPTX limit is independent of profile overrides and artifact order", async () => {
  await withTempDir(async (workspaceDir) => {
    const profiles = DEFAULT_ARTIFACT_PROFILES.map((profile) => ({
      ...profile,
      maxArtifacts: profile.id === "pptx-generator" ? 2 : profile.maxArtifacts,
    }));
    const h = createHarness({ artifactProfiles: profiles });
    const generatorPath = "artifacts/pptx-generator/run-auto/market-landscape.pptx";
    const restylePath = "artifacts/pptx-restyle/run-auto/market-landscape-restyled.pptx";

    for (const artifacts of [
      [createHandoff(generatorPath).artifacts[0], createHandoff(restylePath).artifacts[0]],
      [createHandoff(restylePath).artifacts[0], createHandoff(generatorPath).artifacts[0]],
    ]) {
      const result = await stage(h, workspaceDir, {
        relativePath: generatorPath,
        handoff: createHandoff(generatorPath, "ready", { artifacts }),
      });

      assert.deepEqual(result.acceptedArtifacts, []);
      assert.equal(result.haltRemainingHandlers, true);
      assert.equal(result.rejections[0].code, "artifact-count-rejected");
    }
  });
});

test("staging rejects empty artifacts", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ artifactProfiles: DEFAULT_ARTIFACT_PROFILES });
    const relativePath = "artifacts/pptx-generator/run-empty/market-landscape.pptx";
    const artifactPath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "");

    const result = await stage(h, workspaceDir, {
      relativePath,
      createArtifact: false,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.failures[0].code, "staging-failed");
  });
});

test("a newer auto handoff supersedes old confirmation state without tombstoning its file", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({
      artifactProfiles: DEFAULT_ARTIFACT_PROFILES.map((profile) => ({
        ...profile,
        deliveryPolicy: profile.id === "researcher-export" ? "confirmation" : "auto",
      })),
    });
    const confirmationPath = "artifacts/exports/feishu/run-confirm/research-report.md";
    const autoPath = "artifacts/pptx-generator/run-auto/market-landscape.pptx";
    const now = Date.now();
    await stage(h, workspaceDir, {
      runId: "confirmation-run",
      handoffAt: now,
      relativePath: confirmationPath,
      deliveryStatus: "unmanaged",
    });
    await stage(h, workspaceDir, {
      runId: "auto-run",
      handoffAt: now + 1,
      relativePath: autoPath,
    });

    const state = await readState(workspaceDir);
    assert.equal(state.deliveryState, "superseded");
    assert.equal(state.runId, "auto-run");
    assert.deepEqual(state.artifactPathHashes, [
      crypto
        .createHash("sha256")
        .update(stagedArtifactPath("confirmation-run", confirmationPath), "utf8")
        .digest("hex"),
    ]);
    assert.ok(
      !state.artifactPathHashes.includes(
        crypto
          .createHash("sha256")
          .update(stagedArtifactPath("auto-run", autoPath), "utf8")
          .digest("hex"),
      ),
    );
  });
});

test("staging consumes event.handoff and returns accepted mappings without staged artifacts", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-generator/run-1/deck-title.pptx";
    const handoffAt = Date.now();
    const result = await stage(h, workspaceDir, {
      runId: "ready-run",
      handoffAt,
      relativePath,
    });
    const requesterRelativePath = stagedArtifactPath("ready-run", relativePath);

    assert.deepEqual(result, {
      policyStatus: "evaluated",
      acceptedArtifacts: [
        {
          sourceRelativePath: relativePath,
          requesterRelativePath,
          profileId: "pptx-generator",
          deliveryPolicy: "confirmation",
        },
      ],
      stagedArtifacts: [
        {
          sourceRelativePath: relativePath,
          relativePath: requesterRelativePath,
          fileName: "deck-title.pptx",
          title: "Demo artifact",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          profileId: "pptx-generator",
          deliveryPolicy: "confirmation",
        },
      ],
      rejections: [],
      failures: [],
    });

    const state = await readState(workspaceDir);
    assert.equal(state.runId, "ready-run");
    assert.equal(state.handoffAt, handoffAt);
    assert.equal(state.expiresAt, handoffAt + 24 * 60 * 60 * 1000);
    assert.equal(state.deliveryState, "pending");
    assert.deepEqual(state.exportPaths, [requesterRelativePath]);
    assert.deepEqual(state.artifactPathHashes, [
      crypto.createHash("sha256").update(requesterRelativePath, "utf8").digest("hex"),
    ]);
    assert.deepEqual(state.supersededArtifactPathHashes, []);
  });
});

test("same-workspace artifact must exist before policy acceptance", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const result = await stage(h, workspaceDir, {
      runId: "missing-artifact-run",
      createArtifact: false,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.failures[0].code, "staging-failed");
    assert.equal((await readState(workspaceDir)).deliveryState, "superseded");
  });
});

test("Feishu requester accepts WebChat, internal, and missing staging channels", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const cases = [
      ["webchat", { channel: "webchat", to: "ou_test" }],
      ["internal", { channel: "internal", to: "ou_test" }],
      ["missing", { to: "ou_test" }],
    ];

    for (const [index, [label, requesterOrigin]] of cases.entries()) {
      const relativePath = `artifacts/pptx-generator/${label}/deck-title.pptx`;
      const result = await stage(h, workspaceDir, {
        runId: `${label}-run`,
        handoffAt: Date.now() + index,
        relativePath,
        requesterSessionKey: "agent:feishu-ou_test:webchat:client-1:chat-1",
        requesterOrigin,
      });
      assert.deepEqual(result.acceptedArtifacts, [
        {
          sourceRelativePath: relativePath,
          requesterRelativePath: stagedArtifactPath(`${label}-run`, relativePath),
          profileId: "pptx-generator",
          deliveryPolicy: "confirmation",
        },
      ]);
      await assert.rejects(fs.readFile(path.join(workspaceDir, STATE_PATH)), /ENOENT/);
    }
  });
});

test("missing channel still persists state for a Feishu direct requester session", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const result = await stage(h, workspaceDir, {
      runId: "missing-direct-run",
      requesterSessionKey: "agent:feishu-ou_test:feishu:direct:ou_test",
      requesterOrigin: { to: "ou_test" },
    });

    assert.equal(result.acceptedArtifacts.length, 1);
    assert.equal((await readState(workspaceDir)).deliveryState, "pending");
  });
});

test("cross-workspace artifact is copied from the child workspace automatically", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspace = path.join(tmpRoot, "workspace-child");
    const requesterWorkspace = path.join(tmpRoot, "workspace-requester");
    const relativePath = "artifacts/exports/feishu/run-1/research-report.md";
    const h = createHarness();
    const event = createStagingEvent(requesterWorkspace, {
      runId: "cross-workspace-run",
      relativePath,
      deliveryStatus: "unmanaged",
    });
    event.childWorkspaceDir = childWorkspace;
    await writeArtifact(childWorkspace, relativePath);
    const result = await h.call("subagent_handoff_staging", event, hookContext(requesterWorkspace));
    assert.equal(result.acceptedArtifacts.length, 1);
    assert.equal(
      await fs.readFile(
        path.join(requesterWorkspace, stagedArtifactPath("cross-workspace-run", relativePath)),
        "utf8",
      ),
      "artifact\n",
    );
  });
});

test("ready, warning, and unmanaged handoffs replace the previous pending state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    let handoffAt = Date.now();
    for (const [index, deliveryStatus] of ["ready", "warning", "unmanaged"].entries()) {
      const relativePath =
        deliveryStatus === "unmanaged"
          ? `artifacts/exports/feishu/run-${index}/research-report.md`
          : `artifacts/pptx-restyle/run-${index}/deck-title.pptx`;
      const result = await stage(h, workspaceDir, {
        runId: `${deliveryStatus}-run`,
        handoffAt: handoffAt + index,
        relativePath,
        deliveryStatus,
      });
      assert.equal(result.acceptedArtifacts.length, 1);
      const state = await readState(workspaceDir);
      assert.equal(state.runId, `${deliveryStatus}-run`);
      assert.equal(state.deliveryState, "pending");
      assert.equal(state.deliveryStatus, deliveryStatus);
      if (index > 0) {
        assert.ok(state.supersedesRunId);
      }
    }
  });
});

test("a newer pending handoff blocks the superseded artifact path", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    const oldPath = "artifacts/pptx-generator/run-old/old-deck.pptx";
    const newPath = "artifacts/pptx-generator/run-new/new-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "old-ready-run",
      handoffAt: now,
      relativePath: oldPath,
    });
    await stage(h, workspaceDir, {
      runId: "new-ready-run",
      handoffAt: now + 1,
      relativePath: newPath,
    });

    const state = await readState(workspaceDir);
    assert.equal(state.deliveryState, "pending");
    assert.deepEqual(state.artifactPathHashes, [
      crypto
        .createHash("sha256")
        .update(stagedArtifactPath("new-ready-run", newPath), "utf8")
        .digest("hex"),
    ]);
    assert.deepEqual(state.supersededArtifactPathHashes, [
      crypto
        .createHash("sha256")
        .update(stagedArtifactPath("old-ready-run", oldPath), "utf8")
        .digest("hex"),
    ]);
    const blocked = await startSend(h, workspaceDir, stagedArtifactPath("old-ready-run", oldPath));
    assert.deepEqual(blocked.result, {
      block: true,
      blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
    });
  });
});

test("policy rejection writes a superseded tombstone without plaintext artifact paths", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-restyle/run-1/Draft.pptx";
    const result = await stage(h, workspaceDir, {
      runId: "rejected-run",
      relativePath,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.rejections[0].code, "file-name-rejected");
    const rawState = await fs.readFile(path.join(workspaceDir, STATE_PATH), "utf8");
    const state = JSON.parse(rawState);
    assert.equal(state.deliveryState, "superseded");
    assert.equal(rawState.includes(relativePath), false);
    assert.equal(state.artifactPathHashes.length, 1);
  });
});

test("new blocked handoff replaces warning pending with a path-free tombstone", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-restyle/run-blocked/restyled-deck.pptx";
    const now = Date.now();
    await stage(h, workspaceDir, {
      runId: "warning-run",
      handoffAt: now,
      relativePath,
      deliveryStatus: "warning",
    });
    const result = await stage(h, workspaceDir, {
      runId: "blocked-run",
      handoffAt: now + 1,
      relativePath,
      deliveryStatus: "blocked",
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.rejections[0].code, "quality-blocked");
    const rawState = await fs.readFile(path.join(workspaceDir, STATE_PATH), "utf8");
    const state = JSON.parse(rawState);
    assert.equal(state.runId, "blocked-run");
    assert.equal(state.deliveryState, "blocked");
    assert.equal(state.supersedesRunId, "warning-run");
    assert.equal(rawState.includes(relativePath), false);
  });
});

test("non-delivery-eligible handoff supersedes old pending state without creating a new send path", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    const oldPath = "artifacts/pptx-restyle/run-old/old-deck.pptx";
    const failedPath = "artifacts/pptx-restyle/run-failed/failed-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "old-warning-run",
      handoffAt: now,
      relativePath: oldPath,
      deliveryStatus: "warning",
    });

    const result = await stage(h, workspaceDir, {
      runId: "failed-run",
      handoffAt: now + 1,
      relativePath: failedPath,
      deliveryEligible: false,
    });

    assert.deepEqual(result.acceptedArtifacts, []);
    assert.equal(result.rejections[0].code, "run-not-delivery-eligible");
    assert.equal(result.haltRemainingHandlers, true);
    const state = await readState(workspaceDir);
    assert.equal(state.runId, "failed-run");
    assert.equal(state.deliveryState, "superseded");
    assert.equal(await h.call("before_prompt_build", {}, hookContext(workspaceDir)), undefined);
    assert.equal(
      (await startSend(h, workspaceDir, stagedArtifactPath("old-warning-run", oldPath))).result
        ?.block,
      true,
    );
    assert.equal(
      (await startSend(h, workspaceDir, stagedArtifactPath("failed-run", failedPath))).result
        ?.block,
      true,
    );
  });
});

test("state reservation failure installs a fallback tombstone that blocks old pending artifacts", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    const oldPath = "artifacts/pptx-generator/run-old/old-deck.pptx";
    const newPath = "artifacts/pptx-generator/run-new/new-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "old-run",
      handoffAt: now,
      relativePath: oldPath,
    });

    const originalRename = fs.rename;
    const statePath = path.join(workspaceDir, STATE_PATH);
    fs.rename = async (sourcePath, destinationPath) => {
      if (destinationPath === statePath) {
        throw new Error("simulated state rename failure");
      }
      return originalRename(sourcePath, destinationPath);
    };
    try {
      const result = await stage(h, workspaceDir, {
        runId: "new-run",
        handoffAt: now + 1,
        relativePath: newPath,
      });
      assert.deepEqual(result.acceptedArtifacts, []);
      assert.equal(result.failures[0].code, "state-persist-failed");
      assert.equal(result.haltRemainingHandlers, true);
      assert.equal(await h.call("before_prompt_build", {}, hookContext(workspaceDir)), undefined);
      assert.equal(
        (await startSend(h, workspaceDir, stagedArtifactPath("old-run", oldPath))).result?.block,
        true,
      );
      assert.equal(
        (await startSend(h, workspaceDir, stagedArtifactPath("new-run", newPath))).result?.block,
        true,
      );
    } finally {
      fs.rename = originalRename;
    }
  });
});

test("inline blocked handoff preserves the superseded pending artifact hash", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-restyle/run-old/old-deck.pptx";
    const now = Date.now();
    await stage(h, workspaceDir, {
      runId: "ready-run",
      handoffAt: now,
      relativePath,
    });
    await stage(h, workspaceDir, {
      runId: "inline-blocked-run",
      handoffAt: now + 1,
      createArtifact: false,
      handoff: createHandoff(null, "blocked", {
        mode: "inline",
        summary: "rendering failed",
      }),
    });

    const state = await readState(workspaceDir);
    assert.equal(state.deliveryState, "blocked");
    assert.deepEqual(state.artifactPathHashes, [
      crypto
        .createHash("sha256")
        .update(stagedArtifactPath("ready-run", relativePath), "utf8")
        .digest("hex"),
    ]);
    const blocked = await startSend(h, workspaceDir, stagedArtifactPath("ready-run", relativePath));
    assert.equal(blocked.result?.block, true);
  });
});

test("older handoff cannot overwrite a newer state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    await stage(h, workspaceDir, {
      runId: "new-run",
      handoffAt: now + 10,
    });
    const stale = await stage(h, workspaceDir, {
      runId: "old-run",
      handoffAt: now,
      relativePath: "artifacts/pptx-generator/old/old-deck.pptx",
    });
    assert.equal(stale.haltRemainingHandlers, true);
    assert.equal(stale.rejections[0].code, "stale-handoff");
    assert.equal((await readState(workspaceDir)).runId, "new-run");
    assert.match(h.logs.info.join("\n"), /ignored stale handoff old-run/);
  });
});

test("equal handoff timestamps use runId as a deterministic ordering tie-breaker", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const handoffAt = Date.now();
    await stage(h, workspaceDir, {
      runId: "run-m",
      handoffAt,
      relativePath: "artifacts/pptx-generator/run-m/middle-deck.pptx",
    });
    const stale = await stage(h, workspaceDir, {
      runId: "run-a",
      handoffAt,
      relativePath: "artifacts/pptx-generator/run-a/alpha-deck.pptx",
    });
    assert.deepEqual(stale.acceptedArtifacts, []);
    assert.equal(stale.rejections[0].code, "stale-handoff");
    assert.equal((await readState(workspaceDir)).runId, "run-m");

    const newer = await stage(h, workspaceDir, {
      runId: "run-z",
      handoffAt,
      relativePath: "artifacts/pptx-generator/run-z/zeta-deck.pptx",
    });
    assert.equal(newer.acceptedArtifacts.length, 1);
    assert.equal((await readState(workspaceDir)).runId, "run-z");
  });
});

test("same run replay cannot downgrade sent to pending", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-generator/run-sent/sent-deck.pptx";
    const event = createStagingEvent(workspaceDir, {
      runId: "handoff-sent",
      relativePath,
    });
    await writeArtifact(workspaceDir, relativePath);
    await h.call("subagent_handoff_staging", event, hookContext(workspaceDir));
    const send = await startSend(h, workspaceDir, relativePath);
    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: {
          details: {
            messageId: "message-1",
            mediaUrl: "https://example.test/file-key",
            mirroredFileNames: ["sent-deck.pptx"],
          },
        },
      },
      hookContext(workspaceDir),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sent");

    const replay = await h.call("subagent_handoff_staging", event, hookContext(workspaceDir));
    assert.equal(replay.acceptedArtifacts.length, 1);
    assert.equal((await readState(workspaceDir)).deliveryState, "sent");
  });
});

test("expired pending state is superseded and cannot enter prompt or sending", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ pendingTtlMs: 10 });
    const relativePath = "artifacts/pptx-generator/run-expired/expired-deck.pptx";
    const staging = await stage(h, workspaceDir, {
      runId: "expired-run",
      handoffAt: Date.now() - 100,
      relativePath,
    });
    assert.deepEqual(staging.acceptedArtifacts, []);
    assert.equal(staging.rejections[0].code, "handoff-expired");
    assert.equal(staging.haltRemainingHandlers, true);
    assert.equal((await readState(workspaceDir)).deliveryState, "superseded");

    const prompt = await h.call("before_prompt_build", {}, hookContext(workspaceDir));
    assert.equal(prompt, undefined);
    const send = await startSend(h, workspaceDir, stagedArtifactPath("expired-run", relativePath));
    assert.deepEqual(send.result, {
      block: true,
      blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
    });
    assert.equal((await readState(workspaceDir)).deliveryState, "superseded");
  });
});

test("old after_tool_call result cannot modify a newer handoff run", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    const firstPath = "artifacts/pptx-generator/run-old/old-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "old-handoff",
      handoffAt: now,
      relativePath: firstPath,
    });
    const oldSend = await startSend(h, workspaceDir, firstPath, {
      toolCallId: "old-call",
      runId: "old-parent-turn",
    });
    await stage(h, workspaceDir, {
      runId: "new-handoff",
      handoffAt: now + 1,
      relativePath: "artifacts/pptx-generator/run-new/new-deck.pptx",
    });

    await h.call(
      "after_tool_call",
      {
        ...oldSend.event,
        result: {
          details: { messageId: "old-message", mediaUrl: "https://example.test/old" },
        },
      },
      hookContext(workspaceDir, "old-parent-turn"),
    );
    const state = await readState(workspaceDir);
    assert.equal(state.runId, "new-handoff");
    assert.equal(state.deliveryState, "pending");
    assert.equal(state.messageId, "");
  });
});

test("blocked tombstone rejects both relative and requester-workspace absolute attachment paths", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-restyle/run-block/blocked-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "blocked-run",
      relativePath,
      deliveryStatus: "blocked",
    });
    const blockedPath = stagedArtifactPath("blocked-run", relativePath);

    for (const filePath of [blockedPath, path.join(workspaceDir, blockedPath)]) {
      const result = await h.call(
        "before_tool_call",
        {
          toolName: "message",
          toolCallId: "blocked-call",
          runId: "parent-turn-1",
          params: { action: "send", target: "ou_test", filePath },
        },
        hookContext(workspaceDir),
      );
      assert.deepEqual(result, {
        block: true,
        blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
      });
    }
  });
});

test("superseded artifacts are blocked through file URLs and MEDIA directives", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    const oldPath = "artifacts/pptx-generator/run-old/old-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "old-run",
      handoffAt: now,
      relativePath: oldPath,
    });
    await stage(h, workspaceDir, {
      runId: "new-run",
      handoffAt: now + 1,
      relativePath: "artifacts/pptx-generator/run-new/new-deck.pptx",
    });
    const supersededPath = stagedArtifactPath("old-run", oldPath);

    for (const params of [
      { filePath: `file://${path.join(workspaceDir, supersededPath)}` },
      { filePath: `/workspace/${supersededPath}` },
      { message: `Send this file\nMEDIA: ${supersededPath}` },
      { message: `Send this file\nMEDIA: /workspace/${supersededPath}` },
      { message: "", caption: `MEDIA: ${supersededPath}` },
    ]) {
      const result = await h.call(
        "before_tool_call",
        {
          toolName: "message",
          toolCallId: "superseded-call",
          runId: "parent-turn-1",
          params: {
            action: "send",
            channel: "feishu",
            target: "ou_test",
            ...params,
          },
        },
        hookContext(workspaceDir),
      );
      assert.deepEqual(result, {
        block: true,
        blockReason: "This subagent artifact is blocked or superseded and cannot be sent",
      });
    }
  });
});

test("workspace-external absolute path cannot match a tombstone and emits an audit log", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    await stage(h, workspaceDir, {
      deliveryStatus: "blocked",
      relativePath: "artifacts/pptx-generator/run-block/blocked-deck.pptx",
    });
    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        toolCallId: "outside-call",
        runId: "parent-turn-1",
        params: { filePath: path.join(path.dirname(workspaceDir), "outside", "final.pptx") },
      },
      hookContext(workspaceDir),
    );
    assert.equal(result, undefined);
    assert.match(h.logs.warn.join("\n"), /workspace-external attachment path/);
  });
});

test("unrelated requester-workspace absolute attachment is unaffected", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    await stage(h, workspaceDir, {
      deliveryStatus: "blocked",
      relativePath: "artifacts/pptx-generator/run-block/blocked-deck.pptx",
    });
    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        toolCallId: "unrelated-call",
        runId: "parent-turn-1",
        params: { filePath: path.join(workspaceDir, "other", "image.png") },
      },
      hookContext(workspaceDir),
    );
    assert.equal(result, undefined);
  });
});

test("message tool failure becomes retryable and success becomes sent", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-generator/run-delivery/delivery-deck.pptx";
    await stage(h, workspaceDir, { relativePath });

    let send = await startSend(h, workspaceDir, relativePath, {
      toolCallId: "failed-call",
    });
    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: { isError: true, error: "upload failed" },
      },
      hookContext(workspaceDir),
    );
    let state = await readState(workspaceDir);
    assert.equal(state.deliveryState, "failed_retryable");
    assert.equal(state.lastError, "upload failed");

    send = await startSend(h, workspaceDir, relativePath, {
      toolCallId: "success-call",
    });
    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: {
          details: {
            messageId: "message-success",
            mediaUrl: "https://example.test/file-key",
            mirroredFileNames: ["delivery-deck.pptx"],
          },
        },
      },
      hookContext(workspaceDir),
    );
    state = await readState(workspaceDir);
    assert.equal(state.deliveryState, "sent");
    assert.equal(state.messageId, "message-success");
  });
});

test("single-artifact delivery ignores unrelated result attachments", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-generator/run-single/single-deck.pptx";
    await stage(h, workspaceDir, { relativePath });

    const send = await startSend(h, workspaceDir, relativePath, {
      toolCallId: "single-call",
    });
    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: {
          details: {
            messageId: "unrelated-message",
            mediaUrl: "https://example.test/unrelated.pdf",
          },
        },
      },
      hookContext(workspaceDir),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sending");

    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: {
          details: {
            messageId: "matching-message",
            mirroredFileNames: ["uuid-single-deck.pptx"],
          },
        },
      },
      hookContext(workspaceDir),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sent");
  });
});

test("single-artifact delivery accepts an opaque result attachment", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-generator/run-opaque/opaque-deck.pptx";
    await stage(h, workspaceDir, { relativePath });

    const send = await startSend(h, workspaceDir, relativePath, {
      toolCallId: "opaque-call",
    });
    await h.call(
      "after_tool_call",
      {
        ...send.event,
        result: {
          details: {
            messageId: "opaque-message",
            mediaUrl: "https://example.test/file-key",
          },
        },
      },
      hookContext(workspaceDir),
    );

    assert.equal((await readState(workspaceDir)).deliveryState, "sent");
  });
});

test("multi-artifact delivery remains sending until every result attachment is present", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createMultiArtifactHarness();
    const firstPath = "artifacts/exports/feishu/demo/a.csv";
    const secondPath = "artifacts/exports/feishu/demo/b.csv";
    await writeArtifact(workspaceDir, firstPath);
    await writeArtifact(workspaceDir, secondPath);
    const event = createStagingEvent(workspaceDir, {
      runId: "multi-run",
      handoff: createHandoff(firstPath, "unmanaged", {
        artifacts: [
          { relativePath: firstPath, fileName: "a.csv", mimeType: "text/csv" },
          { relativePath: secondPath, fileName: "b.csv", mimeType: "text/csv" },
        ],
      }),
    });
    await h.call("subagent_handoff_staging", event, hookContext(workspaceDir));
    const exportPaths = (await readState(workspaceDir)).exportPaths;

    const toolCallId = "multi-call";
    const runId = "parent-multi";
    const params = {
      action: "send",
      channel: "feishu",
      target: "ou_test",
      mediaUrls: exportPaths,
    };
    await h.call(
      "before_tool_call",
      { toolName: "message", toolCallId, runId, params },
      hookContext(workspaceDir, runId),
    );

    const stagedFirst = path.join(workspaceDir, "outbox", "a.csv");
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId,
        runId,
        params,
        result: {
          details: {
            messageId: "partial-message",
            mediaUrls: [stagedFirst],
          },
        },
      },
      hookContext(workspaceDir, runId),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sending");

    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId,
        runId,
        params,
        result: {
          details: {
            messageId: "unrelated-message",
            mediaUrls: [
              path.join(workspaceDir, "outbox", "one.bin"),
              path.join(workspaceDir, "outbox", "two.bin"),
            ],
          },
        },
      },
      hookContext(workspaceDir, runId),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sending");

    const stagedSecond = path.join(workspaceDir, "outbox", "b.csv");
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId,
        runId,
        params,
        result: {
          details: {
            messageId: "complete-message",
            mediaUrls: [stagedFirst, stagedSecond],
          },
        },
      },
      hookContext(workspaceDir, runId),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sent");
  });
});

test("multi-artifact delivery rejects bestEffort sends", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createMultiArtifactHarness();
    const firstPath = "artifacts/exports/feishu/best-effort/a.csv";
    const secondPath = "artifacts/exports/feishu/best-effort/b.csv";
    await writeArtifact(workspaceDir, firstPath);
    await writeArtifact(workspaceDir, secondPath);
    await h.call(
      "subagent_handoff_staging",
      createStagingEvent(workspaceDir, {
        runId: "best-effort-run",
        handoff: createHandoff(firstPath, "unmanaged", {
          artifacts: [
            { relativePath: firstPath, fileName: "a.csv", mimeType: "text/csv" },
            { relativePath: secondPath, fileName: "b.csv", mimeType: "text/csv" },
          ],
        }),
      }),
      hookContext(workspaceDir),
    );
    const exportPaths = (await readState(workspaceDir)).exportPaths;

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        toolCallId: "best-effort-call",
        runId: "parent-best-effort",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test",
          mediaUrls: exportPaths,
          bestEffort: true,
        },
      },
      hookContext(workspaceDir, "parent-best-effort"),
    );

    assert.deepEqual(result, {
      block: true,
      blockReason: "Multi-artifact handoff delivery cannot use bestEffort",
    });
    assert.equal((await readState(workspaceDir)).deliveryState, "pending");
  });
});

test("multi-artifact delivery requires result basenames to match declared file names", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createMultiArtifactHarness();
    const firstPath = "artifacts/exports/feishu/demo/source-a.csv";
    const secondPath = "artifacts/exports/feishu/demo/source-b.csv";
    await writeArtifact(workspaceDir, firstPath);
    await writeArtifact(workspaceDir, secondPath);
    const event = createStagingEvent(workspaceDir, {
      runId: "renamed-multi-run",
      handoff: createHandoff(firstPath, "unmanaged", {
        artifacts: [
          { relativePath: firstPath, fileName: "report-a.csv", mimeType: "text/csv" },
          { relativePath: secondPath, fileName: "report-b.csv", mimeType: "text/csv" },
        ],
      }),
    });
    await h.call("subagent_handoff_staging", event, hookContext(workspaceDir));
    const exportPaths = (await readState(workspaceDir)).exportPaths;

    const toolCallId = "renamed-multi-call";
    const runId = "parent-renamed-multi";
    const params = {
      action: "send",
      channel: "feishu",
      target: "ou_test",
      mediaUrls: exportPaths,
    };
    await h.call(
      "before_tool_call",
      { toolName: "message", toolCallId, runId, params },
      hookContext(workspaceDir, runId),
    );

    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId,
        runId,
        params,
        result: {
          details: {
            messageId: "source-name-message",
            mediaUrls: [firstPath, secondPath],
          },
        },
      },
      hookContext(workspaceDir, runId),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sending");

    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId,
        runId,
        params,
        result: {
          details: {
            messageId: "renamed-message",
            mediaUrls: [
              path.join(workspaceDir, "outbox", "uuid-report-a.csv"),
              path.join(workspaceDir, "outbox", "uuid-report-b.csv"),
            ],
          },
        },
      },
      hookContext(workspaceDir, runId),
    );
    assert.equal((await readState(workspaceDir)).deliveryState, "sent");
  });
});

test("before_prompt_build exposes only a live retryable state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/pptx-restyle/run-warning/warning-deck.pptx";
    await stage(h, workspaceDir, {
      runId: "warning-run",
      relativePath,
      deliveryStatus: "warning",
    });
    const prompt = await h.call("before_prompt_build", {}, hookContext(workspaceDir));
    assert.match(prompt.prependContext, /deliveryState: pending/);
    assert.match(prompt.prependContext, /deliveryStatus: warning/);
    assert.match(prompt.prependContext, /verificationSummary: slide overflow/);
    assert.match(prompt.prependContext, /runId: warning-run/);
  });
});

test("message_sending only strips protocol blocks and path text", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const relativePath = "artifacts/exports/feishu/demo/research-report.md";
    const absolutePath = path.join(workspaceDir, relativePath);
    const event = {
      to: "ou_test",
      content: [
        "研究完成，普通说明保留。",
        `相对路径：\`${relativePath}\`。`,
        `绝对路径：${absolutePath}`,
        "<SUBAGENT_HANDOFF>",
        "{this is not parsed as JSON}",
        "</SUBAGENT_HANDOFF>",
      ].join("\n"),
      filePath: path.join(workspaceDir, "other", "already-attached.png"),
    };
    const result = await h.call("message_sending", event, hookContext(workspaceDir));

    assert.match(result.content, /研究完成，普通说明保留。/);
    assert.doesNotMatch(result.content, /SUBAGENT_HANDOFF/);
    assert.doesNotMatch(result.content, /artifacts\/exports/);
    assert.doesNotMatch(
      result.content,
      new RegExp(workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(event.filePath.endsWith("already-attached.png"), true);
    await assert.rejects(fs.readFile(path.join(workspaceDir, STATE_PATH)), /ENOENT/);
  });
});

test("ordinary Feishu text is not rewritten", async () => {
  const h = createHarness();
  assert.equal(
    await h.call(
      "message_sending",
      { content: "普通消息，没有协议块和路径。", filePath: "/tmp/existing.png" },
      { channelId: "feishu", agentId: "feishu-ou_test" },
    ),
    undefined,
  );
});

test("missing structured staging context reports policy unavailable", async () => {
  const h = createHarness();
  const result = await h.call("subagent_handoff_staging", {
    requesterOrigin: { channel: "feishu", to: "ou_test" },
    requesterSessionKey: "agent:feishu-ou_test:feishu:direct:ou_test",
  });
  assert.equal(result.policyStatus, "unavailable");
  assert.equal(result.failures[0].code, "handoff-unavailable");
});

test("aborted staging does not persist requester state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const controller = new AbortController();
    controller.abort(new Error("timeout"));
    const result = await h.call(
      "subagent_handoff_staging",
      {
        ...createStagingEvent(workspaceDir),
        signal: controller.signal,
      },
      hookContext(workspaceDir),
    );

    assert.equal(result.policyStatus, "unavailable");
    assert.equal(result.failures[0].code, "staging-aborted");
    await assert.rejects(fs.readFile(path.join(workspaceDir, STATE_PATH)), /ENOENT/);
  });
});

test("concurrent staging keeps the highest handoffAt state and valid JSON", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness();
    const now = Date.now();
    await Promise.all([
      stage(h, workspaceDir, {
        runId: "older-run",
        handoffAt: now,
        relativePath: "artifacts/pptx-generator/older/older-deck.pptx",
      }),
      stage(h, workspaceDir, {
        runId: "newer-run",
        handoffAt: now + 1,
        relativePath: "artifacts/pptx-generator/newer/newer-deck.pptx",
      }),
    ]);
    const state = await readState(workspaceDir);
    assert.equal(state.runId, "newer-run");
  });
});

test("extension contains no handoff JSON parser", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "index.js"), "utf8");
  assert.doesNotMatch(source, /analyzeSubagentHandoff|parseHandoff/);
  assert.doesNotMatch(source, /JSON\.parse\([^)]*event\.content/);
});

test("extension entrypoint remains a hook composition root", async () => {
  const source = await fs.readFile(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(source.split("\n").length <= 100);
  assert.doesNotMatch(source, /writeJsonAtomic|canonicalHashes|deliveryState\s*:/);
  assert.doesNotMatch(source, /sanitizeArtifactPathMentions|requesterCanAccessArtifact/);
});
