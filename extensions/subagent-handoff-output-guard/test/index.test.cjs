const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const register = require("../index.js");

async function withTempDir(fn) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-output-guard-"));
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
    logger: {
      info() {},
      warn() {},
    },
    on(eventName, handler, opts) {
      handlers.set(eventName, { handler, opts });
    },
  };
  register(api);
  assert.ok(handlers.get("message_sending"), "plugin should register message_sending handler");
  return {
    call(name, event, ctx) {
      const entry = handlers.get(name);
      assert.ok(entry, `missing hook: ${name}`);
      return entry.handler(event, ctx);
    },
  };
}

test("strips non-researcher export-file handoff and keeps confirmation prompt", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({
      enabledChannels: ["feishu"],
      confirmationPromptTemplate:
        "研究已完成并已生成文件《{title}》。如果需要我现在发送文件，请回复“**发送文件**”。",
    });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    await fs.mkdir(path.dirname(path.join(workspaceDir, exportPath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, exportPath), "# demo\n", "utf8");
    const content = [
      "研究已完成，文件路径：`artifacts/exports/feishu/demo/report.md`",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成研究。",
        export: {
          path: exportPath,
          title: "Demo Report",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_test123",
        content,
        metadata: {},
      },
      { channelId: "feishu", sessionKey: "feishu:ou_test123", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.equal(result.content.includes(exportPath), false);
    assert.match(result.content, /《Demo Report》/);
    assert.match(result.content, /请回复“\*\*发送文件\*\*”/);
  });
});

test("uses researcher handoff summary with confirmation prompt when no visible conclusion remains", async () => {
  const h = createHarness({ enabledChannels: ["feishu"] });
  const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
  const summary = "已完成 pan-RAS 抑制剂深度报告，覆盖研究进展、竞争格局、BD交易和未来展望。";
  const content = [
    "<SUBAGENT_HANDOFF>",
    JSON.stringify({
      mode: "export-file",
      summary,
      export: {
        path: exportPath,
        title: "pan-RAS 抑制剂深度研究报告",
        mime: "text/markdown",
      },
    }),
    "</SUBAGENT_HANDOFF>",
  ].join("\n");

  const result = await h.call(
    "message_sending",
    {
      to: "ou_summary_append",
      content,
      metadata: {
        channel: "feishu",
      },
    },
    { channelId: "feishu", agentId: "feishu-ou_summary_append" },
  );

  assert.ok(result);
  assert.match(result.content, new RegExp(summary));
  assert.match(result.content, /请回复“\*\*发送文件\*\*”/);
});

test("strips researcher handoff from visible conclusion with confirmation prompt", async () => {
  const h = createHarness({ enabledChannels: ["feishu"] });
  const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
  const content = [
    "老板，pan-RAS / pan-KRAS 抑制剂深度研究报告已完成，Markdown 版见附件。",
    "<SUBAGENT_HANDOFF>",
    JSON.stringify({
      mode: "export-file",
      summary: "已完成 pan-RAS 深度研究报告。",
      export: {
        path: exportPath,
        title: "pan-RAS 抑制剂深度研究报告",
        mime: "text/markdown",
      },
    }),
    "</SUBAGENT_HANDOFF>",
  ].join("\n");

  const result = await h.call(
    "message_sending",
    {
      to: "ou_summary_append",
      content,
      metadata: { channel: "feishu" },
    },
    { channelId: "feishu", agentId: "feishu-ou_summary_append" },
  );

  assert.ok(result);
  assert.match(result.content, /Markdown 版见附件/);
  assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
  assert.equal(result.content.includes(exportPath), false);
  assert.match(result.content, /请回复“\*\*发送文件\*\*”/);
});

test("strips researcher handoff and prompts before mirrored export exists", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    const content = [
      "老板，报告已完成。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        metadata: { channel: "feishu" },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.match(result.content, /老板，报告已完成。/);
    assert.match(result.content, /请回复“\*\*发送文件\*\*”/);
  });
});

test("strips handoff without prompt when outgoing message already has media", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    await fs.mkdir(path.dirname(path.join(workspaceDir, exportPath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, exportPath), "# researcher\n", "utf8");
    const content = [
      "报告已发送，路径：`artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md`",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        metadata: {
          channel: "feishu",
          mediaUrls: [path.join(workspaceDir, exportPath)],
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.equal(result.content.includes(exportPath), false);
    assert.match(result.content, /报告已发送/);
    assert.doesNotMatch(result.content, /发送文件/);
  });
});

test("strips handoff without prompt when outgoing message already has filePath", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    const sentPath = path.join(workspaceDir, "ou_summary_append.outbox", "report.md");
    const content = [
      "报告已发送，路径：`artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md`",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        filePath: sentPath,
        metadata: { channel: "feishu" },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.equal(result.content.includes(exportPath), false);
    assert.match(result.content, /报告已发送/);
    assert.doesNotMatch(result.content, /发送文件/);
  });
});

test("strips handoff without prompt when outgoing message already has top-level mediaUrls", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    const sentPath = path.join(workspaceDir, "ou_summary_append.outbox", "report.md");
    const content = [
      "报告已发送，路径：`artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md`",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "hybrid",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        mediaUrls: [sentPath],
        metadata: { channel: "feishu" },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.equal(result.content.includes(exportPath), false);
    assert.match(result.content, /报告已发送/);
    assert.doesNotMatch(result.content, /发送文件/);
  });
});

test("strips researcher handoff and prompts when mirrored export exists", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    await fs.mkdir(path.dirname(path.join(workspaceDir, exportPath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, exportPath), "# researcher\n", "utf8");
    const content = [
      "老板，报告已完成。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        metadata: { channel: "feishu" },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.match(result.content, /老板，报告已完成。/);
    assert.match(result.content, /请回复“\*\*发送文件\*\*”/);
  });
});

test("persists pending researcher export and injects follow-up prompt context", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const content = [
      "研究完成。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成研究。",
        export: {
          path: exportPath,
          title: "Demo Report",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    await h.call(
      "message_sending",
      {
        to: "ou_test123",
        content,
        metadata: { channel: "feishu" },
      },
      {
        channelId: "feishu",
        sessionKey: "agent:feishu-ou_test123:feishu:direct:ou_test123",
        agentId: "feishu-ou_test123",
        workspaceDir,
      },
    );

    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.exportPath, exportPath);
    assert.equal(state.title, "Demo Report");
    assert.equal(state.mime, "text/markdown");
    assert.equal(state.deliveryState, "pending");
    assert.equal(state.lastTarget, "ou_test123");

    const prompt = await h.call(
      "before_prompt_build",
      {},
      {
        channelId: "feishu",
        agentId: "feishu-ou_test123",
        workspaceDir,
      },
    );
    assert.ok(prompt);
    assert.match(prompt.prependContext, /Pending Researcher Export/);
    assert.match(prompt.prependContext, /filePath: artifacts\/exports\/feishu\/demo\/report\.md/);
    assert.match(prompt.prependContext, /instead of using `sessions_history`/);
  });
});

test("persists pending export into Feishu peer workspace when sending ctx is researcher", async () => {
  await withTempDir(async (openclawRoot) => {
    const feishuWorkspace = path.join(openclawRoot, "workspace-feishu-ou_test123");
    const researcherWorkspace = path.join(openclawRoot, "workspace-researcher");
    await fs.mkdir(feishuWorkspace, { recursive: true });
    await fs.mkdir(researcherWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(openclawRoot, "openclaw.json"),
      `${JSON.stringify(
        {
          agents: {
            list: [
              { id: "researcher", workspace: researcherWorkspace },
              { id: "feishu-ou_test123", workspace: feishuWorkspace },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const h = createHarness({ enabledChannels: ["feishu"], openclawRoot });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const content = [
      "研究完成。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成研究。",
        export: {
          path: exportPath,
          title: "Demo Report",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    await h.call(
      "message_sending",
      {
        to: "ou_test123",
        content,
        metadata: { channel: "feishu" },
      },
      {
        channelId: "feishu",
        sessionKey: "agent:researcher:subagent:worker",
        agentId: "researcher",
      },
    );

    const feishuStatePath = path.join(
      feishuWorkspace,
      ".artifacts/state/pending-researcher-export.json",
    );
    const researcherStatePath = path.join(
      researcherWorkspace,
      ".artifacts/state/pending-researcher-export.json",
    );
    const state = JSON.parse(await fs.readFile(feishuStatePath, "utf8"));
    assert.equal(state.exportPath, exportPath);
    assert.equal(state.lastTarget, "ou_test123");
    await assert.rejects(fs.readFile(researcherStatePath, "utf8"), /ENOENT/);

    const prompt = await h.call(
      "before_prompt_build",
      {},
      {
        channelId: "feishu",
        agentId: "feishu-ou_test123",
        workspaceDir: feishuWorkspace,
      },
    );
    assert.ok(prompt);
    assert.match(prompt.prependContext, /filePath: artifacts\/exports\/feishu\/demo\/report\.md/);
  });
});

test("persists pending export into Feishu peer workspace from runtime config", async () => {
  await withTempDir(async (openclawRoot) => {
    const feishuWorkspace = path.join(openclawRoot, "custom", "feishu-workspace");
    const fallbackFeishuWorkspace = path.join(openclawRoot, "workspace-feishu-ou_runtimecfg");
    const researcherWorkspace = path.join(openclawRoot, "workspace-researcher");
    await fs.mkdir(feishuWorkspace, { recursive: true });
    await fs.mkdir(researcherWorkspace, { recursive: true });

    const h = createHarness(
      { enabledChannels: ["feishu"], openclawRoot },
      {
        agents: {
          list: [
            { id: "researcher", workspace: researcherWorkspace },
            { id: "feishu-ou_runtimecfg", workspace: feishuWorkspace },
          ],
        },
      },
    );
    const exportPath = "artifacts/exports/feishu/demo/runtime-config-report.md";
    const content = [
      "研究完成。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成研究。",
        export: {
          path: exportPath,
          title: "Runtime Config Report",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    await h.call(
      "message_sending",
      {
        to: "ou_runtimecfg",
        content,
        metadata: { channel: "feishu" },
      },
      {
        channelId: "feishu",
        sessionKey: "agent:researcher:subagent:worker",
        agentId: "researcher",
      },
    );

    const statePath = path.join(feishuWorkspace, ".artifacts/state/pending-researcher-export.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.exportPath, exportPath);
    assert.equal(state.lastTarget, "ou_runtimecfg");
    await assert.rejects(
      fs.readFile(
        path.join(fallbackFeishuWorkspace, ".artifacts/state/pending-researcher-export.json"),
        "utf8",
      ),
      /ENOENT/,
    );

    const prompt = await h.call(
      "before_prompt_build",
      {},
      {
        channelId: "feishu",
        agentId: "feishu-ou_runtimecfg",
      },
    );
    assert.ok(prompt);
    assert.match(prompt.prependContext, /Runtime Config Report/);
  });
});

test("pending state writes use unique temp files under concurrent hook activity", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const makeContent = (index) =>
      [
        `研究完成 ${index}。`,
        "<SUBAGENT_HANDOFF>",
        JSON.stringify({
          mode: "export-file",
          summary: "已完成研究。",
          export: {
            path: `artifacts/exports/feishu/demo/concurrent-${index}.md`,
            title: `Concurrent ${index}`,
            mime: "text/markdown",
          },
        }),
        "</SUBAGENT_HANDOFF>",
      ].join("\n");

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        h.call(
          "message_sending",
          {
            to: "ou_concurrent",
            content: makeContent(index),
            metadata: { channel: "feishu" },
          },
          {
            channelId: "feishu",
            agentId: "feishu-ou_concurrent",
            workspaceDir,
          },
        ),
      ),
    );

    const stateDir = path.join(workspaceDir, ".artifacts/state");
    const statePath = path.join(stateDir, "pending-researcher-export.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.match(state.exportPath, /^artifacts\/exports\/feishu\/demo\/concurrent-\d+\.md$/);
    assert.equal(state.deliveryState, "pending");

    const leftovers = (await fs.readdir(stateDir)).filter(
      (name) => name.includes("pending-researcher-export.json.") && name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);
  });
});

test("marks pending researcher export as sent after message tool result contains messageId", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath,
          title: "Demo Report",
          mime: "text/markdown",
          mode: "export-file",
          deliveryState: "pending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "",
          stagedPath: "",
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await h.call(
      "before_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_file",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: exportPath,
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    let state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sending");
    assert.equal(state.lastToolCallId, "call_send_file");

    const stagedPath = path.join(
      workspaceDir,
      "ou_test123.outbox",
      "1782285937519-55990de9-report.md",
    );
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_file",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: stagedPath,
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedPath,
            mediaUrls: [stagedPath],
            mirroredFileNames: ["1782285937519-55990de9-report.md"],
            result: {
              messageId: "om_test_message",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sent");
    assert.equal(state.messageId, "om_test_message");
    assert.equal(state.stagedPath, stagedPath);
    assert.equal(state.lastError, "");

    const prompt = await h.call(
      "before_prompt_build",
      {},
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );
    assert.equal(prompt, undefined);
  });
});

test("does not mark pending export sent for unrelated same-basename attachment", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath,
          title: "Demo Report",
          mime: "text/markdown",
          mode: "export-file",
          deliveryState: "pending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "",
          stagedPath: "",
          stagedPaths: [],
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const unrelatedPath = path.join(workspaceDir, "other", "report.md");
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_unrelated_file",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: unrelatedPath,
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: unrelatedPath,
            mediaUrls: [unrelatedPath],
            mirroredFileNames: ["report.md"],
            result: {
              messageId: "om_unrelated",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "pending");
    assert.equal(state.messageId, "");
    assert.equal(state.stagedPath, "");
  });
});

test("marks pending export as sent from message tool result without hook workspace ctx", async () => {
  await withTempDir(async (openclawRoot) => {
    const feishuWorkspace = path.join(openclawRoot, "workspace-feishu-ou_test123");
    await fs.mkdir(feishuWorkspace, { recursive: true });
    await fs.writeFile(
      path.join(openclawRoot, "openclaw.json"),
      `${JSON.stringify(
        {
          agents: {
            list: [{ id: "feishu-ou_test123", workspace: feishuWorkspace }],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const h = createHarness({ enabledChannels: ["feishu"], openclawRoot });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const statePath = path.join(feishuWorkspace, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath,
          title: "Demo Report",
          mime: "text/markdown",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "",
          stagedPath: "",
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stagedPath = path.join(
      feishuWorkspace,
      "ou_test123.outbox",
      "1782285937519-55990de9-report.md",
    );
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: exportPath,
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedPath,
            mediaUrls: [stagedPath],
            mirroredFileNames: ["1782285937519-55990de9-report.md"],
            result: {
              messageId: "om_test_message",
            },
          },
        },
      },
      { toolName: "message" },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sent");
    assert.equal(state.messageId, "om_test_message");
    assert.equal(state.stagedPath, stagedPath);
  });
});

test("does not mark pending export as sent without post-send attachment evidence", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath,
          title: "Demo Report",
          mime: "text/markdown",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "call_send_file",
          stagedPath: "",
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_file",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: exportPath,
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            result: {
              messageId: "om_text_only",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sending");
    assert.equal(state.messageId, "");
  });
});

test("marks pending researcher export as retryable when message tool fails", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/demo/report.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath,
          title: "Demo Report",
          mime: "text/markdown",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "call_send_file",
          stagedPath: "",
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_file",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          filePath: exportPath,
        },
        result: {
          status: "failed",
          error: "gateway timeout",
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "failed_retryable");
    assert.equal(state.lastError, "gateway timeout");
  });
});

test("strips handoff without prompt when outgoing message already has media", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const exportPath = "artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md";
    await fs.mkdir(path.dirname(path.join(workspaceDir, exportPath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, exportPath), "# researcher\n", "utf8");
    const content = [
      "报告已发送，路径：`artifacts/exports/feishu/researcher-20260530-120000-abcd/report.md`",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成 pan-RAS 深度研究报告。",
        export: {
          path: exportPath,
          title: "pan-RAS 抑制剂深度研究报告",
          mime: "text/markdown",
        },
      }),
      "</SUBAGENT_HANDOFF>",
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_summary_append",
        content,
        metadata: {
          channel: "feishu",
          mediaUrls: [path.join(workspaceDir, exportPath)],
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_summary_append", workspaceDir },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.equal(result.content.includes(exportPath), false);
    assert.match(result.content, /报告已发送/);
    assert.doesNotMatch(result.content, /发送文件/);
  });
});

test("ignores regular Feishu messages without handoff tags", async () => {
  const h = createHarness({ enabledChannels: ["feishu"] });
  const result = await h.call(
    "message_sending",
    {
      to: "ou_non_researcher",
      content: "报告见附件。",
      metadata: { channel: "feishu" },
    },
    { channelId: "feishu", agentId: "feishu-ou_non_researcher" },
  );

  assert.equal(result, undefined);
});

test("persists multi-export researcher handoff and injects mediaUrls prompt context", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const csvPath = "artifacts/exports/feishu/demo/results.csv";
    const summaryPath = "artifacts/exports/feishu/demo/summary.md";
    const rawPath = "artifacts/exports/feishu/demo/raw.csv";
    const content = [
      "研究完成，已生成多个产物。",
      "<SUBAGENT_HANDOFF>",
      JSON.stringify({
        mode: "export-file",
        summary: "已完成研究。",
        export: {
          path: csvPath,
          title: "结果 CSV",
          mime: "text/csv",
        },
        exports: [
          {
            path: csvPath,
            title: "结果 CSV",
            mime: "text/csv",
          },
          {
            path: summaryPath,
            title: "摘要说明",
            mime: "text/markdown",
          },
          {
            path: rawPath,
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
    ].join("\n");

    const result = await h.call(
      "message_sending",
      {
        to: "ou_test123",
        content,
        metadata: { channel: "feishu" },
      },
      {
        channelId: "feishu",
        agentId: "feishu-ou_test123",
        workspaceDir,
      },
    );

    assert.ok(result);
    assert.equal(result.content.includes("<SUBAGENT_HANDOFF>"), false);
    assert.match(result.content, /发送文件/);

    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.exportPath, csvPath);
    assert.deepEqual(state.exportPaths, [csvPath, summaryPath, rawPath]);
    assert.equal(state.exports.length, 3);

    const prompt = await h.call(
      "before_prompt_build",
      {},
      {
        channelId: "feishu",
        agentId: "feishu-ou_test123",
        workspaceDir,
      },
    );

    assert.ok(prompt);
    assert.match(
      prompt.prependContext,
      /mediaUrls: \["artifacts\/exports\/feishu\/demo\/results\.csv","artifacts\/exports\/feishu\/demo\/summary\.md","artifacts\/exports\/feishu\/demo\/raw\.csv"\]/,
    );
    assert.doesNotMatch(prompt.prependContext, /filePath:/);
  });
});

test("tracks multi-export mediaUrls delivery state", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const csvPath = "artifacts/exports/feishu/demo/results.csv";
    const summaryPath = "artifacts/exports/feishu/demo/summary.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath: csvPath,
          exportPaths: [csvPath, summaryPath],
          title: "结果 CSV",
          mime: "text/csv",
          mode: "export-file",
          deliveryState: "pending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "",
          stagedPath: "",
          stagedPaths: [],
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await h.call(
      "before_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_files",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          mediaUrls: [csvPath, summaryPath],
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    let state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sending");
    assert.equal(state.lastToolCallId, "call_send_files");

    const stagedCsv = path.join(workspaceDir, "ou_test123.outbox", "results.csv");
    const stagedSummary = path.join(workspaceDir, "ou_test123.outbox", "summary.md");
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_files",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          mediaUrls: [stagedCsv, stagedSummary],
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedCsv,
            mediaUrls: [stagedCsv, stagedSummary],
            result: {
              messageId: "om_multi_file",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sent");
    assert.equal(state.messageId, "om_multi_file");
    assert.deepEqual(state.stagedPaths, [stagedCsv, stagedSummary]);
  });
});

test("marks multi-export sent from original params plus staged result mediaUrls", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const csvPath = "artifacts/exports/feishu/demo/results.csv";
    const summaryPath = "artifacts/exports/feishu/demo/summary.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath: csvPath,
          exportPaths: [csvPath, summaryPath],
          title: "结果 CSV",
          mime: "text/csv",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "",
          stagedPath: "",
          stagedPaths: [],
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stagedCsv = path.join(
      workspaceDir,
      "ou_test123.outbox",
      "1782285937519-abcd-results.csv",
    );
    const stagedSummary = path.join(
      workspaceDir,
      "ou_test123.outbox",
      "1782285937519-efgh-summary.md",
    );
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          mediaUrls: [csvPath, summaryPath],
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedCsv,
            mediaUrls: [stagedCsv, stagedSummary],
            result: {
              messageId: "om_multi_file_params",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sent");
    assert.equal(state.messageId, "om_multi_file_params");
    assert.deepEqual(state.stagedPaths, [stagedCsv, stagedSummary]);
  });
});

test("keeps multi-export pending when message result only includes part of mediaUrls", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const csvPath = "artifacts/exports/feishu/demo/results.csv";
    const summaryPath = "artifacts/exports/feishu/demo/summary.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath: csvPath,
          exportPaths: [csvPath, summaryPath],
          title: "结果 CSV",
          mime: "text/csv",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "call_send_files",
          stagedPath: "",
          stagedPaths: [],
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stagedCsv = path.join(workspaceDir, "ou_test123.outbox", "results.csv");
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_files",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          mediaUrls: [stagedCsv],
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedCsv,
            mediaUrls: [stagedCsv],
            result: {
              messageId: "om_partial_file",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sending");
    assert.equal(state.messageId, "");
    assert.equal(state.stagedPath, stagedCsv);
    assert.deepEqual(state.stagedPaths, [stagedCsv]);
  });
});

test("keeps multi-export pending when message result duplicates one mediaUrl", async () => {
  await withTempDir(async (workspaceDir) => {
    const h = createHarness({ enabledChannels: ["feishu"] });
    const csvPath = "artifacts/exports/feishu/demo/results.csv";
    const summaryPath = "artifacts/exports/feishu/demo/summary.md";
    const statePath = path.join(workspaceDir, ".artifacts/state/pending-researcher-export.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          peer: "direct ou_test123",
          exportPath: csvPath,
          exportPaths: [csvPath, summaryPath],
          title: "结果 CSV",
          mime: "text/csv",
          mode: "export-file",
          deliveryState: "sending",
          updatedAt: Date.now(),
          lastTarget: "ou_test123",
          lastToolCallId: "call_send_files",
          stagedPath: "",
          stagedPaths: [],
          messageId: "",
          lastError: "",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stagedCsv = path.join(
      workspaceDir,
      "ou_test123.outbox",
      "1782285937519-abcd-results.csv",
    );
    await h.call(
      "after_tool_call",
      {
        toolName: "message",
        toolCallId: "call_send_files",
        params: {
          action: "send",
          channel: "feishu",
          target: "ou_test123",
          mediaUrls: [stagedCsv, stagedCsv],
        },
        result: {
          details: {
            channel: "feishu",
            to: "ou_test123",
            mediaUrl: stagedCsv,
            mediaUrls: [stagedCsv, stagedCsv],
            result: {
              messageId: "om_duplicate_file",
            },
          },
        },
      },
      { channelId: "feishu", agentId: "feishu-ou_test123", workspaceDir },
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.deliveryState, "sending");
    assert.equal(state.messageId, "");
    assert.deepEqual(state.stagedPaths, [stagedCsv, stagedCsv]);
  });
});
