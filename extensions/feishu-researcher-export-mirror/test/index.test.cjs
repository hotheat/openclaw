const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const register = require("../index.js");

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-export-mirror-"));
  try {
    await fn(tmpRoot);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function createHarness(pluginConfig, config) {
  const handlers = new Map();
  const api = {
    pluginConfig,
    config,
    logger: { info() {}, warn() {} },
    on(name, handler, opts) {
      handlers.set(name, { handler, opts });
    },
  };
  register(api);
  return {
    call(name, event, ctx) {
      const record = handlers.get(name);
      const fn = record && record.handler;
      assert.ok(fn, `missing hook: ${name}`);
      return fn(event, ctx);
    },
    get(name) {
      return handlers.get(name);
    },
  };
}

test("subagent_ended mirrors researcher export into requester feishu workspace", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_test");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-1";
    const requesterSessionKey = "agent:feishu-ou_test:feishu:direct:ou_test";
    const sessionId = "research-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(requesterWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# subagent\n", "utf8");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "已完成",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: exportPath.replace(/\\/g, "/"),
                    title: "Demo",
                    mime: "text/markdown",
                  },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness({
      openclawRoot: tmpRoot,
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });
    assert.ok(h.get("subagent_ended"), "plugin should register subagent_ended");

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# subagent\n");
  });
});

test("subagent_ended mirrors researcher export into configured requester workspace", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspace = path.join(tmpRoot, "custom", "feishu-workspace");
    const defaultRequesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_custom");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-custom";
    const requesterSessionKey = "agent:feishu-ou_custom:feishu:direct:ou_custom";
    const sessionId = "research-custom-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "custom-report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(requesterWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# configured workspace\n", "utf8");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "openclaw.json"),
      `${JSON.stringify(
        {
          agents: {
            list: [{ id: "feishu-ou_custom", workspace: requesterWorkspace }],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "已完成",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: exportPath.replace(/\\/g, "/"),
                    title: "Configured",
                    mime: "text/markdown",
                  },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness({
      openclawRoot: tmpRoot,
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# configured workspace\n");
    await assert.rejects(
      fs.readFile(path.join(defaultRequesterWorkspace, exportPath), "utf8"),
      /ENOENT/,
    );
  });
});

test("mirrors researcher export from configured researcher workspace without explicit plugin root", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "custom", "researcher-workspace");
    const requesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_researcher_cfg");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-researcher-config";
    const requesterSessionKey = "agent:feishu-ou_researcher_cfg:feishu:direct:ou_researcher_cfg";
    const sessionId = "researcher-config-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "configured-root.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(requesterWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# configured researcher root\n", "utf8");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: exportPath.replace(/\\/g, "/"),
                    title: "Configured Researcher",
                    mime: "text/markdown",
                  },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness(
      {
        openclawRoot: tmpRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        agents: {
          list: [{ id: "researcher", workspace: researcherRoot }],
        },
      },
    );

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# configured researcher root\n");
  });
});

test("subagent_ended resolves configured session store and sessionFile override", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_store");
    const storePath = path.join(tmpRoot, "custom", "stores", "researcher-sessions.json");
    const transcriptFile = "handoff.custom.jsonl";
    const transcriptPath = path.join(path.dirname(storePath), transcriptFile);
    const childSessionKey = "agent:researcher:subagent:child-store";
    const requesterSessionKey = "agent:feishu-ou_store:feishu:direct:ou_store";
    const sessionId = "researcher-store-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "store-report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(requesterWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# custom session store\n", "utf8");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          [childSessionKey]: {
            sessionId,
            sessionFile: transcriptFile,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: exportPath.replace(/\\/g, "/"),
                    title: "Store",
                    mime: "text/markdown",
                  },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness(
      {
        openclawRoot: tmpRoot,
        researcherWorkspaceRoot: researcherRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        session: {
          store: storePath,
        },
      },
    );

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# custom session store\n");
  });
});

test("subagent_ended mirrors researcher export from string transcript content", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_text");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-text";
    const requesterSessionKey = "agent:feishu-ou_text:feishu:direct:ou_text";
    const sessionId = "research-string-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "string-report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(requesterWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# string transcript\n", "utf8");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            "已完成",
            "<SUBAGENT_HANDOFF>",
            JSON.stringify({
              mode: "export-file",
              export: {
                path: exportPath.replace(/\\/g, "/"),
                title: "String Demo",
                mime: "text/markdown",
              },
            }),
            "</SUBAGENT_HANDOFF>",
          ].join("\n"),
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness({
      openclawRoot: tmpRoot,
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# string transcript\n");
  });
});

test("subagent_ended ignores non-feishu requesters", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const nonFeishuWorkspace = path.join(tmpRoot, "workspace-main");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-1";
    const sessionId = "research-session";
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "report.md");
    const sourcePath = path.join(researcherRoot, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# subagent\n", "utf8");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: { path: exportPath.replace(/\\/g, "/") },
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness({
      openclawRoot: tmpRoot,
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey: "agent:main:cli",
      },
    );

    await assert.rejects(fs.readFile(path.join(nonFeishuWorkspace, exportPath), "utf8"), /ENOENT/);
  });
});

test("message_sending mirrors researcher export into current feishu workspace", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const feishuWorkspace = path.join(tmpRoot, "workspace-feishu-ou_test");
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(feishuWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# demo\n", "utf8");

    const h = createHarness({
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });
    assert.equal(h.get("message_sending").opts.priority, 100);
    await h.call(
      "message_sending",
      {
        to: "user:ou_test",
        content: [
          "任务已完成",
          "<SUBAGENT_HANDOFF>",
          JSON.stringify({
            mode: "export-file",
            export: {
              path: exportPath.replace(/\\/g, "/"),
              title: "Demo",
              mime: "text/markdown",
            },
          }),
          "</SUBAGENT_HANDOFF>",
        ].join("\n"),
        metadata: {},
      },
      {
        agentId: "feishu-ou_test",
        channelId: "feishu",
        workspaceDir: feishuWorkspace,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# demo\n");
  });
});

test("message_sending mirrors researcher export into configured feishu workspace with runtime-shaped context", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const feishuWorkspace = path.join(tmpRoot, "custom", "workspace-feishu-ou_runtime");
    const fallbackWorkspace = path.join(tmpRoot, "workspace-feishu-ou_runtime");
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "runtime-report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(feishuWorkspace, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# runtime message_sending\n", "utf8");

    const h = createHarness(
      {
        openclawRoot: tmpRoot,
        researcherWorkspaceRoot: researcherRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        agents: {
          list: [{ id: "feishu-ou_runtime", workspace: feishuWorkspace }],
        },
      },
    );

    await h.call(
      "message_sending",
      {
        to: "user:ou_runtime",
        content: [
          "任务已完成",
          "<SUBAGENT_HANDOFF>",
          JSON.stringify({
            mode: "export-file",
            export: {
              path: exportPath.replace(/\\/g, "/"),
              title: "Runtime",
              mime: "text/markdown",
            },
          }),
          "</SUBAGENT_HANDOFF>",
        ].join("\n"),
        metadata: {},
      },
      {
        agentId: "feishu-ou_runtime",
        channelId: "feishu",
        sessionKey: "agent:feishu-ou_runtime:feishu:direct:ou_runtime",
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# runtime message_sending\n");
    await assert.rejects(fs.readFile(path.join(fallbackWorkspace, exportPath), "utf8"), /ENOENT/);
  });
});

test("before_tool_call mirrors researcher export before read using relative path", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const workspaceDir = path.join(tmpRoot, "workspace-custom");
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(workspaceDir, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# relative\n", "utf8");

    const h = createHarness({
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });
    assert.ok(h.get("before_tool_call"), "plugin should register before_tool_call");

    await h.call(
      "before_tool_call",
      {
        toolName: "read",
        params: {
          path: exportPath,
        },
      },
      {
        agentId: "workspace",
        workspaceDir,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# relative\n");
  });
});

test("before_tool_call mirrors researcher export before read in configured workspace with runtime-shaped context", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const workspaceDir = path.join(tmpRoot, "custom", "workspace-feishu-ou_read");
    const fallbackWorkspace = path.join(tmpRoot, "workspace-feishu-ou_read");
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "runtime-read.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(workspaceDir, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# runtime read\n", "utf8");

    const h = createHarness(
      {
        openclawRoot: tmpRoot,
        researcherWorkspaceRoot: researcherRoot,
        exportPrefix: "artifacts/exports/feishu",
      },
      {
        agents: {
          list: [{ id: "feishu-ou_read", workspace: workspaceDir }],
        },
      },
    );

    await h.call(
      "before_tool_call",
      {
        toolName: "read",
        params: {
          path: exportPath,
        },
      },
      {
        toolName: "read",
        agentId: "feishu-ou_read",
        sessionKey: "agent:feishu-ou_read:feishu:direct:ou_read",
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# runtime read\n");
    await assert.rejects(fs.readFile(path.join(fallbackWorkspace, exportPath), "utf8"), /ENOENT/);
  });
});

test("before_tool_call mirrors researcher export before read using file_path alias and workspace absolute path", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const workspaceDir = path.join(tmpRoot, "workspace-feishu-ou_test");
    const exportPath = path.join("artifacts", "exports", "feishu", "demo", "report.md");
    const sourcePath = path.join(researcherRoot, exportPath);
    const destinationPath = path.join(workspaceDir, exportPath);

    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "# alias\n", "utf8");

    const h = createHarness({
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    await h.call(
      "before_tool_call",
      {
        toolName: "read",
        params: {
          file_path: destinationPath,
        },
      },
      {
        agentId: "feishu-ou_test",
        workspaceDir,
      },
    );

    const mirrored = await fs.readFile(destinationPath, "utf8");
    assert.equal(mirrored, "# alias\n");
  });
});

test("before_tool_call leaves missing researcher exports untouched", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const workspaceDir = path.join(tmpRoot, "workspace-feishu-ou_test");
    const exportPath = path.join("artifacts", "exports", "feishu", "missing", "report.md");
    const destinationPath = path.join(workspaceDir, exportPath);

    const h = createHarness({
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    const result = await h.call(
      "before_tool_call",
      {
        toolName: "read",
        params: {
          path: exportPath,
        },
      },
      {
        agentId: "feishu-ou_test",
        workspaceDir,
      },
    );

    assert.equal(result, undefined);
    await assert.rejects(fs.readFile(destinationPath, "utf8"), /ENOENT/);
  });
});

test("subagent_ended mirrors every exports[] researcher file into requester workspace", async () => {
  await withTempDir(async (tmpRoot) => {
    const researcherRoot = path.join(tmpRoot, "workspace-researcher");
    const requesterWorkspace = path.join(tmpRoot, "workspace-feishu-ou_multi");
    const sessionsDir = path.join(tmpRoot, "agents", "researcher", "sessions");
    const childSessionKey = "agent:researcher:subagent:child-multi";
    const requesterSessionKey = "agent:feishu-ou_multi:feishu:direct:ou_multi";
    const sessionId = "research-multi-session";
    const resultPath = path.join("artifacts", "exports", "feishu", "demo", "results.csv");
    const summaryPath = path.join("artifacts", "exports", "feishu", "demo", "summary.md");
    const rawPath = path.join("artifacts", "exports", "feishu", "demo", "raw.csv");
    const exportPaths = [resultPath, summaryPath, rawPath];

    for (const exportPath of exportPaths) {
      const sourcePath = path.join(researcherRoot, exportPath);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, `source:${path.basename(exportPath)}\n`, "utf8");
    }
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      `${JSON.stringify({ [childSessionKey]: { sessionId } }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "已完成",
                "<SUBAGENT_HANDOFF>",
                JSON.stringify({
                  mode: "export-file",
                  export: {
                    path: resultPath.replace(/\\/g, "/"),
                    title: "结果 CSV",
                    mime: "text/csv",
                  },
                  exports: [
                    {
                      path: resultPath.replace(/\\/g, "/"),
                      title: "结果 CSV",
                      mime: "text/csv",
                    },
                    {
                      path: summaryPath.replace(/\\/g, "/"),
                      title: "摘要说明",
                      mime: "text/markdown",
                    },
                    {
                      path: rawPath.replace(/\\/g, "/"),
                      title: "原始数据",
                      mime: "text/csv",
                    },
                    {
                      path: "../blocked.csv",
                      title: "非法路径",
                      mime: "text/csv",
                    },
                  ],
                }),
                "</SUBAGENT_HANDOFF>",
              ].join("\n"),
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const h = createHarness({
      openclawRoot: tmpRoot,
      researcherWorkspaceRoot: researcherRoot,
      exportPrefix: "artifacts/exports/feishu",
    });

    await h.call(
      "subagent_ended",
      {
        targetSessionKey: childSessionKey,
        targetKind: "subagent",
        reason: "completion-announced",
        outcome: "ok",
      },
      {
        childSessionKey,
        requesterSessionKey,
      },
    );

    for (const exportPath of exportPaths) {
      const mirrored = await fs.readFile(path.join(requesterWorkspace, exportPath), "utf8");
      assert.equal(mirrored, `source:${path.basename(exportPath)}\n`);
    }
    await assert.rejects(
      fs.readFile(path.join(requesterWorkspace, "blocked.csv"), "utf8"),
      /ENOENT/,
    );
  });
});
