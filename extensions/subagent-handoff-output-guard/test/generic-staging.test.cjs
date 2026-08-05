const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const register = require("../index.js");
const { mimeMatchesExtension, resolveExpectedMimeTypes } = require("../lib/artifact-mime.js");
const { createOoxmlBuffer, createRuntime } = require("./runtime-harness.cjs");

const STAGING_PREFIX = "artifacts/imports/subagent";

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "generic-subagent-staging-"));
  try {
    await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function createConfig(overrides = {}) {
  return {
    stagingPrefix: STAGING_PREFIX,
    maxArtifactsPerHandoff: 1,
    artifactProfiles: [
      {
        id: "generic-subagent-artifact",
        prefix: STAGING_PREFIX,
        allowedExtensions: [".md", ".png"],
        allowedMimeTypes: ["text/markdown", "image/png"],
        maxArtifacts: 1,
        maxBytes: 1024,
        requireFileNameMatchPath: true,
        deliveryPolicy: "auto",
      },
    ],
    ...overrides,
  };
}

function createHarness(pluginConfig = createConfig()) {
  const handlers = [];
  register({
    pluginConfig,
    config: {},
    runtime: createRuntime(),
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler, options = {}) {
      if (name === "subagent_handoff_staging") {
        handlers.push({ handler, priority: options.priority || 0 });
      }
    },
  });
  handlers.sort((left, right) => right.priority - left.priority);
  return {
    async stage(event) {
      let merged;
      for (const entry of handlers) {
        const next = await entry.handler(event, {});
        if (!next) continue;
        const accepted = new Map(
          (merged?.acceptedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.acceptedArtifacts || []) {
          const current = accepted.get(artifact.sourceRelativePath);
          accepted.set(
            artifact.sourceRelativePath,
            current ? { ...artifact, ...current } : artifact,
          );
        }
        const staged = new Map(
          (merged?.stagedArtifacts || []).map((artifact) => [
            artifact.sourceRelativePath,
            artifact,
          ]),
        );
        for (const artifact of next.stagedArtifacts || []) {
          const current = staged.get(artifact.sourceRelativePath);
          staged.set(artifact.sourceRelativePath, current ? { ...artifact, ...current } : artifact);
        }
        const haltRemainingHandlers = Boolean(
          merged?.haltRemainingHandlers || next.haltRemainingHandlers,
        );
        if (haltRemainingHandlers) {
          accepted.clear();
          staged.clear();
        }
        merged = {
          policyStatus:
            merged?.policyStatus === "evaluated" || next.policyStatus === "evaluated"
              ? "evaluated"
              : "unavailable",
          acceptedArtifacts: [...accepted.values()],
          stagedArtifacts: [...staged.values()],
          rejections: [...(merged?.rejections || []), ...(next.rejections || [])],
          failures: [...(merged?.failures || []), ...(next.failures || [])],
          ...(haltRemainingHandlers ? { haltRemainingHandlers: true } : {}),
        };
        if (next.haltRemainingHandlers) break;
      }
      return merged;
    },
  };
}

function createEvent(params) {
  const artifacts = params.artifacts || [
    {
      relativePath: params.relativePath || "reports/report.md",
      fileName: path.posix.basename(params.relativePath || "reports/report.md"),
      title: "Report",
      mimeType: params.mimeType || "text/markdown",
    },
  ];
  return {
    runId: params.runId || "run-1",
    handoffAt: Date.now(),
    childSessionKey: "agent:worker:subagent:child-1",
    requesterSessionKey: "agent:main:webchat:client-1:chat-1",
    requesterOrigin: { channel: "webchat" },
    childWorkspaceDir: params.childWorkspaceDir,
    requesterWorkspaceDir: params.requesterWorkspaceDir,
    content: "done",
    handoff: {
      mode: "export-file",
      summary: "done",
      quality: {
        gate: "unmanaged",
        verificationStatus: "unknown",
        deliveryStatus: "unmanaged",
      },
      artifacts,
      omittedArtifactCount: 0,
    },
    deliveryEligible: true,
    outcome: "ok",
    completionDelivery: "direct",
  };
}

async function writeSource(workspaceDir, relativePath, content = "# report\n") {
  const sourcePath = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, content);
  return sourcePath;
}

test("additional image extensions have explicit MIME whitelist entries", () => {
  const cases = [
    [".gif", ["image/gif"]],
    [".bmp", ["image/bmp"]],
    [".tif", ["image/tiff"]],
    [".tiff", ["image/tiff"]],
    [".svg", ["image/svg+xml"]],
    [".ico", ["image/x-icon", "image/vnd.microsoft.icon"]],
  ];

  for (const [extension, mimeTypes] of cases) {
    assert.deepEqual(resolveExpectedMimeTypes(`artifact${extension}`), mimeTypes);
    for (const mimeType of mimeTypes) {
      assert.equal(mimeMatchesExtension(`artifact${extension}`, mimeType), true);
    }
  }
});

test("stages an arbitrary safe child path into the requester import directory", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "reports/report.md");

    const result = await createHarness().stage(
      createEvent({ childWorkspaceDir, requesterWorkspaceDir }),
    );
    const requesterRelativePath = "artifacts/imports/subagent/run-1/report.md";

    assert.deepEqual(result.acceptedArtifacts, [
      {
        sourceRelativePath: "reports/report.md",
        requesterRelativePath,
        profileId: "generic-subagent-artifact",
        deliveryPolicy: "auto",
      },
    ]);
    assert.equal(
      await fs.readFile(path.join(requesterWorkspaceDir, requesterRelativePath), "utf8"),
      "# report\n",
    );
  });
});

test("staging defaults to the requester import directory when stagingPrefix is omitted", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "output/default.md");
    const config = createConfig();
    delete config.stagingPrefix;

    const result = await createHarness(config).stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "output/default.md",
      }),
    );
    const requesterRelativePath = "artifacts/imports/subagent/run-1/default.md";

    assert.equal(result.acceptedArtifacts[0].requesterRelativePath, requesterRelativePath);
    assert.equal(
      await fs.readFile(path.join(requesterWorkspaceDir, requesterRelativePath), "utf8"),
      "# report\n",
    );
  });
});

test("same-workspace staging creates an independent snapshot", async () => {
  await withTempDir(async (workspaceDir) => {
    const sourcePath = await writeSource(workspaceDir, "output/report.md", "version one\n");
    const result = await createHarness().stage(
      createEvent({
        childWorkspaceDir: workspaceDir,
        requesterWorkspaceDir: workspaceDir,
        relativePath: "output/report.md",
      }),
    );
    const stagedPath = path.join(workspaceDir, result.acceptedArtifacts[0].requesterRelativePath);

    await fs.writeFile(sourcePath, "version two\n", "utf8");
    assert.equal(await fs.readFile(stagedPath, "utf8"), "version one\n");
  });
});

test("same-run replay reuses the existing immutable staged file", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "reports/report.md", "version one\n");
    const harness = createHarness();
    const event = createEvent({ childWorkspaceDir, requesterWorkspaceDir });

    const first = await harness.stage(event);
    const stagedPath = path.join(
      requesterWorkspaceDir,
      first.acceptedArtifacts[0].requesterRelativePath,
    );
    const firstStat = await fs.stat(stagedPath);
    const replay = await harness.stage(event);
    const replayStat = await fs.stat(stagedPath);

    assert.equal(replay.acceptedArtifacts.length, 1);
    assert.equal(await fs.readFile(stagedPath, "utf8"), "version one\n");
    assert.equal(replayStat.ino, firstStat.ino);
  });
});

test("same-run replay rejects changed source content without replacing the staged file", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    const sourcePath = await writeSource(childWorkspaceDir, "reports/report.md", "version one\n");
    const harness = createHarness();
    const event = createEvent({ childWorkspaceDir, requesterWorkspaceDir });
    const first = await harness.stage(event);
    const stagedPath = path.join(
      requesterWorkspaceDir,
      first.acceptedArtifacts[0].requesterRelativePath,
    );

    await fs.writeFile(sourcePath, "version two\n", "utf8");
    const replay = await harness.stage(event);

    assert.equal(replay.failures[0].code, "staging-failed");
    assert.match(replay.failures[0].message, /different content/);
    assert.equal(await fs.readFile(stagedPath, "utf8"), "version one\n");
  });
});

test("concurrent same-run staging publishes one immutable file", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "reports/report.md", "concurrent snapshot\n");
    const event = createEvent({ childWorkspaceDir, requesterWorkspaceDir });

    const [first, second] = await Promise.all([
      createHarness().stage(event),
      createHarness().stage(event),
    ]);
    const stagedPath = path.join(requesterWorkspaceDir, STAGING_PREFIX, "run-1", "report.md");

    assert.equal(first.acceptedArtifacts.length, 1);
    assert.equal(second.acceptedArtifacts.length, 1);
    assert.equal(await fs.readFile(stagedPath, "utf8"), "concurrent snapshot\n");
  });
});

test("rejects unsafe paths, source symlinks, and destination directory symlinks", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    const outsidePath = await writeSource(tmpRoot, "outside.md");
    await fs.mkdir(childWorkspaceDir, { recursive: true });
    await fs.symlink(outsidePath, path.join(childWorkspaceDir, "linked.md"));

    let result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "../outside.md",
      }),
    );
    assert.equal(result.rejections[0].code, "unsafe-artifact-path");

    result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "linked.md",
      }),
    );
    assert.equal(result.failures[0].code, "staging-failed");

    await fs.mkdir(path.join(requesterWorkspaceDir, "artifacts"), { recursive: true });
    await fs.symlink(tmpRoot, path.join(requesterWorkspaceDir, "artifacts", "imports"));
    await writeSource(childWorkspaceDir, "reports/report.md");
    result = await createHarness().stage(createEvent({ childWorkspaceDir, requesterWorkspaceDir }));
    assert.equal(result.failures[0].code, "staging-failed");
  });
});

test("rejects empty, oversized, and multiple artifacts without a deliverable copy", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "empty.md", "");

    let result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "empty.md",
      }),
    );
    assert.equal(result.failures[0].code, "staging-failed");

    await writeSource(childWorkspaceDir, "large.md", Buffer.alloc(1025, 0x61));
    result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "large.md",
      }),
    );
    assert.equal(result.rejections[0].code, "file-size-rejected");

    await writeSource(childWorkspaceDir, "a.md");
    await writeSource(childWorkspaceDir, "b.md");
    result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        artifacts: [
          { relativePath: "a.md", fileName: "a.md", mimeType: "text/markdown" },
          { relativePath: "b.md", fileName: "b.md", mimeType: "text/markdown" },
        ],
      }),
    );
    assert.equal(result.rejections[0].code, "artifact-count-rejected");
    await assert.rejects(
      fs.readFile(path.join(requesterWorkspaceDir, STAGING_PREFIX, "run-1", "a.md")),
      /ENOENT/,
    );
  });
});

test("rejects multiple source paths that resolve to the same staged filename", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "reports/report.md");
    await writeSource(childWorkspaceDir, "output/report.md");
    const config = createConfig({
      maxArtifactsPerHandoff: 2,
      artifactProfiles: [
        {
          id: "generic-subagent-artifact",
          prefix: STAGING_PREFIX,
          allowedExtensions: [".md"],
          allowedMimeTypes: ["text/markdown"],
          maxArtifacts: 2,
          maxBytes: 1024,
          requireFileNameMatchPath: true,
          deliveryPolicy: "auto",
        },
      ],
    });

    const result = await createHarness(config).stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        artifacts: [
          {
            relativePath: "reports/report.md",
            fileName: "report.md",
            mimeType: "text/markdown",
          },
          {
            relativePath: "output/report.md",
            fileName: "report.md",
            mimeType: "text/markdown",
          },
        ],
      }),
    );

    assert.equal(result.rejections[0].code, "file-name-rejected");
    await assert.rejects(
      fs.readFile(path.join(requesterWorkspaceDir, STAGING_PREFIX, "run-1", "report.md")),
      /ENOENT/,
    );
  });
});

test("rejects declared and detected MIME mismatches", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    await writeSource(childWorkspaceDir, "report.md");

    let result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "report.md",
        mimeType: "image/png",
      }),
    );
    assert.equal(result.rejections[0].code, "mime-type-rejected");

    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await writeSource(childWorkspaceDir, "fake.md", pngHeader);
    result = await createHarness().stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "fake.md",
      }),
    );
    assert.equal(result.rejections[0].code, "mime-type-rejected");

    const binaryConfig = createConfig({
      artifactProfiles: [
        {
          ...createConfig().artifactProfiles[0],
          allowedExtensions: [".pdf", ".pptx"],
          allowedMimeTypes: [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ],
        },
      ],
    });
    await writeSource(childWorkspaceDir, "fake.pdf", "not a pdf");
    result = await createHarness(binaryConfig).stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "fake.pdf",
        mimeType: "application/pdf",
      }),
    );
    assert.equal(result.rejections[0].code, "mime-type-rejected");

    const genericZip = await new (require("jszip"))()
      .file("hello.txt", "hello")
      .generateAsync({ type: "nodebuffer" });
    await writeSource(childWorkspaceDir, "fake.pptx", genericZip);
    result = await createHarness(binaryConfig).stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "fake.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );
    assert.equal(result.rejections[0].code, "mime-type-rejected");

    await writeSource(childWorkspaceDir, "valid.pptx", await createOoxmlBuffer(".pptx"));
    result = await createHarness(binaryConfig).stage(
      createEvent({
        childWorkspaceDir,
        requesterWorkspaceDir,
        relativePath: "valid.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );
    assert.equal(result.acceptedArtifacts.length, 1);
  });
});

test("rejects a source that changes while it is copied", async () => {
  await withTempDir(async (tmpRoot) => {
    const childWorkspaceDir = path.join(tmpRoot, "child");
    const requesterWorkspaceDir = path.join(tmpRoot, "requester");
    const sourcePath = await writeSource(
      childWorkspaceDir,
      "reports/report.md",
      Buffer.alloc(128 * 1024, 0x61),
    );
    const originalOpen = fs.open;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) !== path.resolve(sourcePath)) return handle;
      const originalRead = handle.read.bind(handle);
      let readCount = 0;
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        readCount += 1;
        if (readCount === 1) {
          await fs.appendFile(sourcePath, "changed");
        }
        return result;
      };
      return handle;
    };

    try {
      const result = await createHarness(
        createConfig({
          artifactProfiles: [
            {
              id: "generic-subagent-artifact",
              prefix: STAGING_PREFIX,
              allowedExtensions: [".md"],
              allowedMimeTypes: ["text/markdown"],
              maxArtifacts: 1,
              maxBytes: 1024 * 1024,
              requireFileNameMatchPath: true,
              deliveryPolicy: "auto",
            },
          ],
        }),
      ).stage(createEvent({ childWorkspaceDir, requesterWorkspaceDir }));
      assert.equal(result.failures[0].code, "staging-failed");
      await assert.rejects(
        fs.readFile(path.join(requesterWorkspaceDir, STAGING_PREFIX, "run-1", "report.md")),
        /ENOENT/,
      );
    } finally {
      fs.open = originalOpen;
    }
  });
});
