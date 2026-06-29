const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const register = require("../index.js");

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-file-outbox-router-"));
  try {
    await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function createHarness(pluginConfig, config = {}) {
  const handlers = new Map();
  const api = {
    pluginConfig,
    config,
    logger: { info() {}, warn() {} },
    on(eventName, handler) {
      handlers.set(eventName, handler);
    },
  };
  register(api);
  assert.ok(handlers.get("before_tool_call"), "plugin should register before_tool_call handler");
  return {
    call(name, event, ctx) {
      const fn = handlers.get(name);
      assert.ok(fn, `missing hook: ${name}`);
      return fn(event, ctx);
    },
  };
}

test("stages researcher export files for feishu agent context when explicit target is present", async () => {
  await withTempDir(async (tmpRoot) => {
    const exportRoot = path.join(tmpRoot, "workspace-researcher", "artifacts", "exports", "feishu");
    const handoffDir = path.join(exportRoot, "handoff-123");
    const outboxRoot = path.join(tmpRoot, "workspace");
    const sourceFile = path.join(handoffDir, "report.txt");

    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(sourceFile, "hello researcher export\n", "utf8");

    const h = createHarness({
      outboxRoot,
      exportPrefix: "artifacts/exports/feishu",
      sourcePrefixes: [exportRoot],
      explicitTargetRequiredPrefixes: [exportRoot],
    });

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        params: {
          target: "ou_test123",
          filePath: sourceFile,
        },
      },
      { agentId: "feishu-ou_test123" },
    );

    assert.ok(result);
    assert.ok(result.params);
    assert.notEqual(result.params.filePath, sourceFile);
    assert.match(result.params.filePath, new RegExp(`${path.sep}ou_test123\\.outbox${path.sep}`));
    assert.equal(await fs.readFile(result.params.filePath, "utf8"), "hello researcher export\n");
  });
});

test("stages relative researcher export from configured non-default researcher workspace", async () => {
  await withTempDir(async (openclawRoot) => {
    const researcherWorkspace = path.join(openclawRoot, "custom-researcher-workspace");
    const feishuWorkspace = path.join(openclawRoot, "workspace-feishu-ou_test123");
    const outboxRoot = path.join(openclawRoot, "workspace");
    const relativeFile = path.join(
      "artifacts",
      "exports",
      "feishu",
      "handoff-configured",
      "report.txt",
    );
    const sourceFile = path.join(researcherWorkspace, relativeFile);

    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.mkdir(feishuWorkspace, { recursive: true });
    await fs.writeFile(sourceFile, "hello configured researcher workspace\n", "utf8");

    const h = createHarness(
      {
        outboxRoot,
        openclawRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        agents: {
          list: [{ id: "researcher", workspace: researcherWorkspace }],
        },
      },
    );

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        params: {
          target: "ou_test123",
          filePath: relativeFile,
        },
      },
      { agentId: "feishu-ou_test123", workspaceDir: feishuWorkspace },
    );

    assert.ok(result);
    assert.ok(result.params);
    assert.notEqual(result.params.filePath, relativeFile);
    assert.match(result.params.filePath, new RegExp(`${path.sep}ou_test123\\.outbox${path.sep}`));
    assert.equal(
      await fs.readFile(result.params.filePath, "utf8"),
      "hello configured researcher workspace\n",
    );
  });
});

test("recovers rewritten researcher export absolute paths that incorrectly point at the feishu workspace", async () => {
  await withTempDir(async (tmpRoot) => {
    const exportRoot = path.join(tmpRoot, "workspace-researcher", "artifacts", "exports", "feishu");
    const workspacePrefix = path.join(tmpRoot, "workspace-feishu-");
    const workspaceDir = path.join(tmpRoot, "workspace-feishu-ou_test123");
    const outboxRoot = path.join(tmpRoot, "workspace");
    const relativeFile = path.join("artifacts", "exports", "feishu", "handoff-fixed", "report.txt");
    const sourceFile = path.join(tmpRoot, "workspace-researcher", relativeFile);
    const rewrittenAbsolutePath = path.join(workspaceDir, relativeFile);

    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sourceFile, "hello recovered export\n", "utf8");

    const h = createHarness({
      outboxRoot,
      exportPrefix: "artifacts/exports/feishu",
      sourcePrefixes: [workspacePrefix, exportRoot],
      explicitTargetRequiredPrefixes: [exportRoot],
    });

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        params: {
          target: "ou_test123",
          filePath: rewrittenAbsolutePath,
        },
      },
      { agentId: "feishu-ou_test123", workspaceDir },
    );

    assert.ok(result);
    assert.ok(result.params);
    assert.notEqual(result.params.filePath, rewrittenAbsolutePath);
    assert.match(result.params.filePath, new RegExp(`${path.sep}ou_test123\\.outbox${path.sep}`));
    assert.equal(await fs.readFile(result.params.filePath, "utf8"), "hello recovered export\n");
  });
});

test("stages relative export paths from configured feishu workspace with runtime-shaped context", async () => {
  await withTempDir(async (tmpRoot) => {
    const feishuWorkspace = path.join(tmpRoot, "custom", "workspace-feishu-ou_config");
    const outboxRoot = path.join(tmpRoot, "workspace");
    const relativeFile = path.join(
      "artifacts",
      "exports",
      "feishu",
      "handoff-config",
      "report.txt",
    );
    const sourceFile = path.join(feishuWorkspace, relativeFile);

    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, "hello configured feishu workspace\n", "utf8");

    const h = createHarness(
      {
        outboxRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        agents: {
          list: [{ id: "feishu-ou_config", workspace: feishuWorkspace }],
        },
      },
    );

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        params: {
          filePath: relativeFile,
        },
      },
      {
        toolName: "message",
        agentId: "feishu-ou_config",
        sessionKey: "agent:feishu-ou_config:feishu:direct:ou_config",
      },
    );

    assert.ok(result);
    assert.ok(result.params);
    assert.notEqual(result.params.filePath, relativeFile);
    assert.match(result.params.filePath, new RegExp(`${path.sep}ou_config\\.outbox${path.sep}`));
    assert.equal(
      await fs.readFile(result.params.filePath, "utf8"),
      "hello configured feishu workspace\n",
    );
  });
});

test("stages researcher export files to current feishu direct peer when explicit target is omitted", async () => {
  await withTempDir(async (tmpRoot) => {
    const exportRoot = path.join(tmpRoot, "workspace-researcher", "artifacts", "exports", "feishu");
    const workspacePrefix = path.join(tmpRoot, "workspace-feishu-");
    const workspaceDir = path.join(tmpRoot, "workspace-feishu-ou_test123");
    const outboxRoot = path.join(tmpRoot, "workspace");
    const relativeFile = path.join(
      "artifacts",
      "exports",
      "feishu",
      "handoff-current",
      "report.txt",
    );
    const sourceFile = path.join(tmpRoot, "workspace-researcher", relativeFile);
    const rewrittenAbsolutePath = path.join(workspaceDir, relativeFile);

    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(sourceFile, "hello current peer export\n", "utf8");

    const h = createHarness({
      outboxRoot,
      exportPrefix: "artifacts/exports/feishu",
      sourcePrefixes: [workspacePrefix, exportRoot],
      explicitTargetRequiredPrefixes: [exportRoot],
    });

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "message",
        params: {
          filePath: rewrittenAbsolutePath,
        },
      },
      { agentId: "feishu-ou_test123", workspaceDir },
    );

    assert.ok(result);
    assert.ok(result.params);
    assert.notEqual(result.params.filePath, rewrittenAbsolutePath);
    assert.match(result.params.filePath, new RegExp(`${path.sep}ou_test123\\.outbox${path.sep}`));
    assert.equal(await fs.readFile(result.params.filePath, "utf8"), "hello current peer export\n");
  });
});

test("rejects researcher export staging outside feishu agent context even if channel=feishu is passed", async () => {
  await withTempDir(async (tmpRoot) => {
    const exportRoot = path.join(tmpRoot, "workspace-researcher", "artifacts", "exports", "feishu");
    const handoffDir = path.join(exportRoot, "handoff-456");
    const outboxRoot = path.join(tmpRoot, "workspace");
    const sourceFile = path.join(handoffDir, "report.txt");
    const relativeFile = path.join("artifacts", "exports", "feishu", "handoff-456", "report.txt");

    await fs.mkdir(handoffDir, { recursive: true });
    await fs.writeFile(sourceFile, "hello researcher export\n", "utf8");

    const h = createHarness({
      outboxRoot,
      exportPrefix: "artifacts/exports/feishu",
      sourcePrefixes: [exportRoot],
      explicitTargetRequiredPrefixes: [exportRoot],
    });

    await assert.rejects(
      h.call(
        "before_tool_call",
        {
          toolName: "message",
          params: {
            channel: "feishu",
            target: "ou_test123",
            filePath: relativeFile,
          },
        },
        { agentId: "workspace" },
      ),
      /only be staged from a feishu-\* agent context/,
    );
  });
});
