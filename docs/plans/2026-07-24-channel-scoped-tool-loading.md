# Implementation Plan: 按会话界面裁剪工具与系统提示词

## Overview

本方案减少模型在不同交付界面中看到的无关工具，并让 system prompt 只描述本次运行实际可用的能力。

三条主线：

1. **按 surface 裁剪工具**：核心仓识别父 WebChat 会话并移除 `message`；`webui_artifact_publish` 继续由现有插件工厂按 WebChat 上下文动态注册。
2. **删除 `artifact_jobs`**：该工具无生产调用链，且是本 fork 本地新增（upstream 不存在），整体删除实现、注册、catalog、policy、配置 schema 与测试。
3. **条件化 Tooling 指导**：`## Tooling` 按职责分段，并根据实际工具集合条件化注入；同时删除 `toolNames` 为空时的硬编码 fallback 工具清单，并把 report 的工具清单边界从文本解析改为与 prompt 同源构造（不改 `buildAgentSystemPrompt()` 签名）。

`tts` 通过部署配置 `tools.deny` 移除工具本体（不影响 auto-TTS 能力）。

`## Tool Call Style` 的改写是全局行为调整，**已从本计划移出**，另立独立计划与独立 PR。

## Requirements

- 真实 Feishu 入站会话保留 `message`。
- 父 WebChat 会话不加载 `message`。
- `webui_artifact_publish` 只在父 WebChat 会话加载。
- `subagent_handoff_delivery` 在 `requesterOrigin.channel` 缺失时仍然发布 artifact（现有兼容合同，不得收紧）。
- `artifact_jobs` 从核心仓完全删除：实现、注册、tool catalog、tool policy 别名、配置类型与 zod schema、测试。
- `tts` 工具通过 `openclaw.json` 全局 `tools.deny` 移除；auto-TTS 与 `[[tts:]]` 标签管线保持不变。
- 被禁用或未注册的工具不得出现在 system prompt 工具清单或发送给模型的 tool schema 中。
- Gateway 以 `internal` 执行父 WebChat 会话时，仍应识别为 WebChat。
- 搜索、长等待和子 agent 指导在 `## Tooling` 中分段展示。
- 长等待指导只在 `exec` 或 `process` 可用时出现。
- 子 agent 指导只在 `sessions_spawn` 可用时出现。
- `toolNames` 为空时，工具清单显示真实状态，不得输出硬编码清单。
- system prompt report 的工具清单与 prompt 由同一函数、同一 tools 数组构造，不依赖对生成文本的二次解析。
- 工具构造失败在 `/context`、session export 等命令/导出路径可降级为空工具清单（fail-soft），但必须写日志（含 sessionKey、agentId、channel、provider/model 与错误信息，不含敏感配置值），并在 bundle 的 `warnings` 中显式暴露；诊断信息不得注入生产 system prompt。主运行路径（`pi-embedded-runner`）不做 catch，保持失败即失败。
- 父 WebChat 会话保留 `sessions_spawn`：agent-frontend 用它把子 agent 卡片关联到对应工具调用行（见 Current State 跨仓依赖与 Risks）。
- 保留现有 WebChat `message` 运行时拒绝逻辑，作为旧入口和显式构造场景的纵深保护。

## Non-goals

- 不改写 `## Tool Call Style`（另立计划与 PR）。
- 不删除 `tts` 的核心实现。
- 不改变 auto-TTS 自动模式、`[[tts:]]` 标签管线或 Voice 提示段落的注入条件；用户通过 prefs 开启 auto-TTS 时 Voice 段落照常出现，这是有效能力提示。
- 不条件化 Voice/TTS 提示段落。`tts` 工具被全局 deny 后，开启 auto-TTS 的用户仍会看到 Voice 段落，模型可能尝试调用不可用的 `tts` 工具——接受该暂时矛盾（模型会收到明确的工具不可用错误并可自我纠正），Voice 段落条件化另案处理。当前部署 `tts` / `messages.tts` / `agents.defaults.tts` 均为 null，该矛盾实际不会触发。
- 不裁剪父 WebChat 会话的 `sessions_spawn`，不扩大 WebChat 裁剪范围：agent-frontend 按 `webui_artifact_publish`、`sessions_spawn`、`read`/`read_file` 工具名提供关联展示增强（见 Risks）。
- 不为所有 channel 新增通用 `tools.byChannel` 配置结构。
- 不按 channel 分化 system prompt 文本。
- 不改变 Feishu `message` 的发送、outbox staging 或显式 target 规则。
- 不改变 `webui_artifact_publish` 的上传、鉴权、配额和文件卡协议。
- 不为 cron 引入「触发来源」参数以绕过 WebChat 裁剪（见 Risks）。
- 不删除历史计划与研究文档中对 `artifact_jobs` 的叙述，只在开头加移除标记。
- 不在实现过程中运行完整 `pnpm test`、`pnpm test:fast` 或 `make test`。
- 不在未经明确批准时重启 Gateway。

## Current State

### 工具构造与策略

- `src/agents/openclaw-tools.ts`
  - `message`、`tts` 和 `artifact_jobs` 都在核心工具数组构造阶段创建。
  - `message` 已有 `disableMessageTool` 参数，但当前正常 WebChat 运行没有按 session surface 自动设置。
  - 插件工具在核心工具构造后通过 `resolvePluginTools()` 注册。
- `src/agents/pi-tools.ts:253`
  - 已掌握 `messageProvider`、`sessionKey` 和 `internalExecution`，并已计算 `messageChannelHint`。
  - 工具经过 owner、profile、global、provider、agent、group、sandbox 和 subagent policy pipeline 后才交给模型。
- `src/agents/pi-tools.policy.ts:314`
  - `isToolAllowedByPolicies()` 用 `.every()` 串联各层 policy，因此全局 `tools.deny` 会压过 profile `allow`。
- `src/agents/pi-tools.policy.ts:66`
  - `SUBAGENT_TOOL_DENY_LEAF = ["sessions_list", "sessions_history", "sessions_spawn"]`，叶子 subagent 当前仍会收到「spawn a sub-agent」与「Do not poll `sessions_list`」指导。
- `src/agents/tool-policy-shared.ts`
  - `"group:artifacts": ["artifact_jobs"]` 别名；`artifact_jobs` 同时出现在 `TOOL_PROFILES.coding.allow` 与 `group:openclaw`。

### Channel 与 session 判定

- `src/utils/message-channel.ts:96`
  - `resolveGatewayClientMessageChannel()` 分三档：control-ui / webchat / internal。
  - agent-server BFF 默认以 `client_id='gateway-client'`、`mode='backend'` 连接，两个 UI 判定都不命中，因此其 `chat.send` 运行的 `messageChannel` 为 `internal`。部署可通过 `OPENCLAW__GATEWAY_CLIENT_ID` 覆盖 client id，Phase 6 需核对实际非敏感配置值。
  - `control-ui` 是独立的第三个 channel（见 `docs/plans/2026-07-16-control-ui-webchat-channel-separation.md`），不属于本方案的父 WebChat surface。
- `extensions/webui-artifacts/index.ts:21`
  - `isParentWebchatToolContext()` 要求 channel ∈ {webchat, internal} **且** 五段 webchat session key；channel 缺失返回 false。
- `extensions/webui-artifacts/index.ts:69`
  - `subagent_handoff_delivery` 的 channel 条件是 `!messageChannel || webchat || internal`，**允许缺失**。
  - `requesterOrigin` 在事件类型上是可选的（`src/agents/subagent-announce.ts:116`），旧持久化记录与 handoff 传递链都允许缺失，该兼容合同真实存在。
- `src/agents/tools/message-tool.ts:619`
  - `isParentWebchatMessageContext()` 使用较宽松的 `sessionKey.includes(":webchat:")` 判断。
  - `assertWebchatMessageBoundary()` 已拒绝把 WebChat 当作可投递 channel，并拒绝没有显式 Feishu target 的 WebChat 文件发送。

### System prompt

- `src/agents/system-prompt.ts:451`
  - 工具清单来源于过滤后的 `toolNames`。
  - 搜索、长等待和子 agent 指导当前连续排列，且长等待和子 agent 指导没有检查相关工具是否存在。
- `src/agents/system-prompt.ts:456`
  - `toolNames` 为空时输出一份**硬编码**工具清单（`exec`/`process`/`browser`/`canvas`/`nodes`/`cron`/`sessions_*`/`subagents`/`session_status`），完全不看策略。
  - 该分支可由命令路径触发：`src/auto-reply/reply/commands-system-prompt.ts` 在工具创建抛错时捕获异常并返回空数组，服务 `/context`、session export 等估算/导出用途。注意主运行路径（`src/agents/pi-embedded-runner/run/attempt.ts`）直接调用 `createOpenClawCodingTools()`，没有 catch 成空数组——「模型实际收到无工具 prompt 并继续跑」不是主链路现状。
  - 该 catch 路径当前**静默**：`tools=[]` 不可区分「真实无工具」与「工具构造失败」，`listChars = 0` 只是结果字段而非告警；排障材料（`/context`、export HTML、debug 报告）会看起来像「策略正常关闭了工具」。
- `src/agents/system-prompt.ts:147`
  - `### message tool` 子段已按 `availableTools.has("message")` 条件化，移除 `message` 后会正确消失。
- `src/agents/system-prompt-report.ts:112`
  - 当前通过固定的 `TOOLS.md` 文本定位工具清单结束位置；搜索指导位于工具清单与结束标记之间，报告可能把指导文本计入 `toolListChars`。
- `buildAgentSystemPrompt()` 有三个调用方：`src/agents/pi-embedded-runner/system-prompt.ts:55`、`src/agents/cli-runner/helpers.ts:88`、`src/auto-reply/reply/commands-system-prompt.ts:115`。

### `artifact_jobs` 现状

- 本 fork 本地新增，由 `f06a953496e (#39)` 引入；upstream（`/Users/jiaoguo/github/openclaw`）不存在该文件。删除**减少**分叉成本。
- 无生产调用链，且部署侧主动劝阻：`openclaw-workspace/workspace/AGENTS.md:366` 与 `workspace/skills/otr-pptx-restyle/SKILL.md:20` 均写有「Do not use `artifact_jobs`」。
- 引用面（本仓）：`src/agents/tools/artifact-jobs-tool.ts`、同名 `.test.ts`、`src/agents/tool-catalog.ts:221`、`src/agents/tool-policy-shared.ts:36/50/76`、`src/agents/openclaw-tools.ts`、`src/config/types.tools.ts:602`、`src/config/zod-schema.agent-runtime.ts:792`。
- 文档引用（保留内容，加移除标记）：`docs/plans/2026-05-28-otr-pptx-same-workspace-subagent.md`、`docs/research/openclaw-frontend-integration/openclaw-frontend-integration-research.md`。
- 无 checked-in 的 config JSON schema 产物需要重新生成。

### 部署配置

- `../openclaw-workspace/openclaw.json`
  - 全局 `tools.deny` 当前为 `["gateway"]`。
  - 已配置 `tools.artifactJobs`，但 workspace 和生产源码中没有实际调用链。
  - **没有任何 agent 设置 `tools.profile` / `allow` / `deny`**，唯一工具策略是全局 deny。
  - `tts`、`messages.tts`、`agents.defaults.tts` 均为 null。
  - 已启用 `webui-artifacts` 插件。
- 配置校验：`ToolsSchema` 是 `.strict()`（`src/config/zod-schema.agent-runtime.ts:736`）。运行时 `loadConfig()` 走 JSON5 解析、**不做 zod 校验**（`src/config/io.ts:631`），因此残留的 `tools.artifactJobs` 不会导致 Gateway 启动失败；但 `validateConfig()`（`src/config/validation.ts:98`）会判为 unrecognized key，影响 `config.apply`、`openclaw doctor` 和 Control UI 改配置。

### 跨仓依赖（agent-server / agent-frontend）

- `agent-frontend` 硬编码三个工具名（不读 available tools 清单，按名字匹配）：
  - `webui_artifact_publish`（`OpenClawAssistantThread.tsx:746`）：渲染 artifact 文件卡——本计划保留。
  - `sessions_spawn`（`OpenClawAssistantThread.tsx:750`、`subagent-state.ts`、`useOpenClawSubagents.ts`）：spawn anchor → 子 agent 业务卡片——本计划不触及。
  - `read` / `read_file`（`skill-invocation.ts:3`）：技能回显——本计划不触及。
  - 这些依赖按工具名提供关联增强：`webui_artifact_publish` 缺失时 artifact 降级到 unlinked 区域，`sessions_spawn` 缺失时已发现的 child 降级到「其他子任务」，`read` / `read_file` 缺失时技能标签降级为普通工具名。均不会抛错，因此核心仓测试无法覆盖这类前端体验退化。
  - `message` 在两个仓的命中均为无关语义（前端聊天条目类型 `kind: 'message'`、后端 `error.message` 字段），无耦合。
- `agent-server` BFF 不消费工具清单：`hello.features` 来自 BFF 自身绑定状态（`openclaw_bridge_controller.py:327`——`features['subagents']` 来自 RPC 方法白名单、`features['artifacts']` 来自绑定配置），`openclaw_protocol_translator.py` 与 bridge controller 中没有 availableTools / tool_names 概念。无需同步改动。

## Architecture Changes

### 1. 双层 session surface 判定

> 决策记录：[ADR-0005](../adr/0005-two-level-parent-webchat-predicate.md)

新增 `src/agents/session-surface.ts`，导出**两个层次**的判定，把「session 身份」与「调用点 channel 策略」分开：

```ts
// 纯 session key 形状判定
export function isParentWebchatSessionKey(sessionKey?: string): boolean;

// 形状 + channel 准入；channel 缺失返回 false
export function isParentWebchatSessionContext(params: {
  channel?: string;
  sessionKey?: string;
}): boolean;
```

- 第二个参数使用中性的 `channel`：`pi-tools` 传入 `messageProvider`，插件传入 `messageChannel`，避免把某个调用方的命名带入共享 API。
- `isParentWebchatSessionKey()` 严格解析五段 `agent:<agentId>:webchat:<namespace>:<sessionId>`，各段非空。
- `isParentWebchatSessionContext()` 使用 `normalizeMessageChannel()` 规范 channel，只放行 `webchat` 与 `internal`。
- **不提供** `allowMissingChannel` 之类的参数。显式组合更容易看出 handoff 的兼容策略，降低其他调用方误用宽松模式的概率。

调用关系：

| 调用点                                  | 使用                                              | channel 缺失 |
| --------------------------------------- | ------------------------------------------------- | ------------ |
| 核心工具裁剪（`pi-tools.ts`）           | `isParentWebchatSessionContext()`                 | `false`      |
| `message` 纵深保护（`message-tool.ts`） | `isParentWebchatSessionContext()`                 | `false`      |
| `webui_artifact_publish` 工具注册       | `isParentWebchatSessionContext()`                 | `false`      |
| `subagent_handoff_delivery`             | `isParentWebchatSessionKey()` + 本地 channel 组合 | **允许**     |

handoff 处显式写出兼容策略：

```ts
isParentWebchatSessionKey(event.requesterSessionKey) &&
  (!channel || channel === "webchat" || channel === "internal");
```

**显式决策**：`control-ui` 不属于父 WebChat surface。Control UI 与 WebChat 已在 `2026-07-16-control-ui-webchat-channel-separation.md` 中明确区分，现有 `webui-artifacts` 也拒绝该 channel。本方案维持排除，并以负例测试固化。

### 2. 在工具构造阶段移除 WebChat `message`

`createOpenClawCodingTools()` 根据 `isParentWebchatSessionContext()` 计算当前 surface。父 WebChat 会话向 `createOpenClawTools()` 传入 `disableMessageTool=true`，使 `message` 在进入 policy pipeline、system prompt 和 provider schema 之前消失。

调用方显式传入的 `disableMessageTool` 继续生效。组合规则使用逻辑或，避免 cron 等现有调用方恢复已禁用工具。

### 3. 删除 `artifact_jobs`

> 决策记录：[ADR-0004](../adr/0004-remove-artifact-jobs-tool.md)

整体移除，不保留恢复入口：

- 删除 `src/agents/tools/artifact-jobs-tool.ts` 与 `src/agents/tools/artifact-jobs-tool.test.ts`。
- 从 `src/agents/openclaw-tools.ts` 移除构造与注册。
- 从 `src/agents/tool-catalog.ts` 移除条目。
- 从 `src/agents/tool-policy-shared.ts` 移除 `TOOL_PROFILES.coding.allow`、`group:openclaw` 中的条目，并**连同 `"group:artifacts"` 别名一起删除**（留空数组会让 `tools.allow: ["group:artifacts"]` 静默变成「什么都不允许」，比报 unknown group 更难排查；本仓与 workspace 配置均无引用）。
- 从 `src/config/types.tools.ts` 与 `src/config/zod-schema.agent-runtime.ts` 移除 `artifactJobs` 类型与 schema。
- 在两份历史文档开头加移除标记，正文保留供历史参考。

删除后**不需要**把 `artifact_jobs` 加入 `tools.deny`。

### 4. 部署配置移除 `tts` 工具

`../openclaw-workspace/openclaw.json` 的全局 `tools.deny` 变为：

```json
["gateway", "tts"]
```

同时删除 `tools.artifactJobs` 配置块，以及 workspace 中因删除而失效的死指令。

作用域限定为「模型显式调用的 `tts` 工具」。auto-TTS 自动模式与 `[[tts:]]` 标签管线是独立链路（`src/tts/tts.ts:334`、`src/tts/tts.ts:350`），不受 `tools.deny` 影响，也不在本方案改动范围内。

### 5. 条件化构建 Tooling 指导

`buildAgentSystemPrompt()` 将 Tooling 内容拆为：

1. 实际工具清单；
2. shell 搜索与 `TOOLS.md` 指导；
3. 长等待指导；
4. 子 agent 指导。

每一段由实际 `availableTools` 决定：

- 没有 `exec` 时不注入 shell 搜索指导。
- 同时没有 `exec` 和 `process` 时不注入长等待指导。
- 没有 `sessions_spawn` 时不注入 spawn 和 push-based completion 指导。
- 没有 `subagents`、`sessions_list` 时，轮询禁止文本只引用实际存在的状态工具；两者都不存在时省略该句。

对当前部署的实际效果：普通 Feishu / WebChat 会话（无 agent 级 policy）几乎不变；**叶子 subagent 的 prompt 会修正**——这些会话被 `SUBAGENT_TOOL_DENY_LEAF` 拿掉了 `sessions_spawn` 与 `sessions_list`，却仍在被要求 spawn 子 agent、被告知不要轮询不存在的工具。

prompt cache 影响：分歧点在工具清单（各 surface 的工具集合本就不同），而工具清单位于指导文本**之前**；条件化只改变其后的指导文本，不把分歧点提前，边际缓存代价为零。易变内容集中在 prompt 末尾的现有缓存设计不受影响。

### 6. 删除硬编码 fallback 工具清单

- `toolNames` 参数由可选改为**必填** `string[]`；三个生产调用方已显式传入，测试需明确填写 `[]` 或实际工具名。
- 运行时仍使用 `params.toolNames ?? []` 做防御。
- 空数组时输出真实状态：

  ```text
  ## Tooling

  Tool availability (filtered by policy):
  No tools are available in this runtime.
  ```

保留 fallback 会直接违反「提示词只描述实际可用工具」这条核心合同，且在 Phase 4 条件化之后会自相矛盾：该分支触发时 `availableTools` 为空集，工具清单声称 `exec`/`process`/`subagents` 可用，而所有对应指导都被条件化掉。

### 7. 工具清单边界改为同源构造，**不改 `buildAgentSystemPrompt()` 签名**

`buildSystemPromptReport()` 已经收到 `tools: AgentTool[]`（`src/agents/system-prompt-report.ts:135`），并不需要从 prompt 文本里挖工具清单。让两边**从同一输入各自构造**，而不是让一边解析另一边的输出：

- 从 `src/agents/system-prompt.ts` 导出纯函数 `buildToolListText(toolNames, toolSummaries)`。
- `buildAgentSystemPrompt()` 内部改用它渲染工具清单，**返回值仍是 `string`**，三个调用方不动。
- `buildSystemPromptReport()` 用 `params.tools` 自行调用：`tools.map(t => t.name)` 给出同样的名字与大小写，`buildToolSummaryMap(tools)`（`src/agents/tool-summaries.ts:3`）是 tools 数组的纯函数，给出 external summary 输入。
- 空工具集合时：`listChars = 0`、`schemaChars = 0`、`entries = []`。

**「字符级一致」的成立条件**：`buildToolListText()` 必须把以下三件事全部封装在函数内部，调用方只传 `toolNames` 与 external summaries：

1. `toolOrder` 排序（`src/agents/system-prompt.ts:339`）；
2. `extraTools.toSorted()` 追加（`:345`）；
3. **`coreToolSummaries` 优先于传入的 summaries**（`:341` 与 `:346` 均为 `coreToolSummaries[tool] ?? externalToolSummaries.get(tool)`）。

第 3 点最容易漏：核心工具在 prompt 里用的是硬编码短描述，而 `buildToolSummaryMap()` 从 `tool.description` 派生完整描述。若 `buildToolListText()` 只做「拼接传入的 summaries」，两侧字符数会显著偏离，测试中的一致性断言必然失败。

满足以上条件后结果是**字符级一致**：`src/agents/pi-embedded-runner/run/attempt.ts` 喂给 prompt 构造（907 行）和喂给 report（936 行）的是同一个 `tools` 变量。

被否决的两个方案：

- **改返回值为 `{ text, sections }`**：能消除文本解析，但要改三个调用方、连锁影响省略 `toolNames` 的既有用例，且在 upstream diff 中表现为签名变更。纯函数导出是纯新增，在任何合并策略下都更容易处理。
- **「第一个空段落」作为文本锚点**：Phase 4 恰好要给每段都加空行，该锚点与新增段落之间不再有结构差异；条件化后工具清单之后还可能什么段落都没有。

额外收益：现状下 report 的 `tools.entries` 来自工具数组、`toolListChars` 来自 prompt 文本，两者可能不一致；同源构造后该不一致消失。

### 8. 工具构造失败的诊断告警

`commands-system-prompt.ts` 的 catch → 空数组路径服务 `/context`、session export 等估算/导出用途，当前是静默降级（见 Current State）。处理策略：

- catch 保留，**仅限命令/报告路径 fail-soft**；主运行路径（`pi-embedded-runner`）不做 catch，失败即失败。直接失败对命令路径太硬——`/context` 或 export 因工具构造失败完全不可用，排障时反而少了一份上下文材料。
- catch 后必须 `log.warn` / `log.error`，带 `sessionKey`、`agentId`、`channel`、`provider/model`、错误类型与 message，避免敏感配置值。
- `CommandsSystemPromptBundle` 增加 `warnings`，例如 `[{ code: "tools.create_failed", message: "Tool construction failed; report uses empty tool list." }]`。
- `/context json` 原样输出 warnings；`/context list` / `detail` 显示一行明显警告；export HTML 显示 warning banner。
- 警告**不注入**真正的生产 system prompt——该 bundle 是估算/导出用途，诊断信息属于 report metadata/UI，不能伪装成模型指令。

## Runtime Flow

```text
inbound / Gateway agent request
  -> channel + sessionKey
  -> isParentWebchatSessionContext()
  -> create core tools
       -> parent WebChat: omit message
       -> Feishu: keep message
  -> resolve plugin tools
       -> parent WebChat: register webui_artifact_publish
       -> Feishu / control-ui / other: return null
  -> apply tools.deny
       -> omit tts
  -> normalize schema + hooks
  -> build system prompt from filtered tool names
       -> conditional Tooling guidance
       -> tool list rendered via shared buildToolListText()
          (report calls the same helper with the same tools array)
  -> send matching tool schemas and prompt to model
```

子 agent 交付（独立路径）：

```text
subagent completion
  -> runSubagentAnnounceFlow()
  -> subagent_handoff_delivery hook
  -> isParentWebchatSessionKey(requesterSessionKey)
       && (channel missing | webchat | internal)
  -> publish artifact
```

## Implementation Steps

所有 `openclaw-integration` 侧改动合入**同一个 PR**。`openclaw-workspace` 是独立仓库，配置改动为另一个 PR。

### Phase 1: 建立双层 session surface 判定

1. **新增 helper**
   File: `src/agents/session-surface.ts`
   - Action:
     - 新增 `isParentWebchatSessionKey(sessionKey?)`：严格解析五段 agent session key，各段非空。
     - 新增 `isParentWebchatSessionContext({ channel, sessionKey })`：`normalizeMessageChannel()` 规范 channel，只放行 `webchat` 与 `internal`，缺失返回 `false`。
     - 不提供 `allowMissingChannel` 之类参数。
   - Why: Gateway 的 WebChat 请求以 `internal` 执行，单看 channel 会误判；单看 `:webchat:` 又过宽。拆两层是因为 handoff 与工具注册的 channel 准入规则本就不同。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Medium. 判定过严会丢失 WebUI artifact 工具，判定过宽会错误移除 `message`。

2. **补齐 helper 单元测试**
   File: `src/agents/session-surface.test.ts`
   - Action:
     - `isParentWebchatSessionKey`：五段合法、缺段、空段、额外段、subagent key。
     - `isParentWebchatSessionContext`：`webchat` 正例、`internal` 正例、`feishu` 负例、`control-ui` 负例、**channel 缺失负例**、大小写 channel。
     - `internal + main/subagent session` 负例。
   - Why: 将两层判定的边界固化为独立合同。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low.

### Phase 2: 按 surface 构造工具

1. **父 WebChat 会话自动禁用 `message`**
   File: `src/agents/pi-tools.ts`
   - Action:
     - 在已规范化 `messageChannelHint` 后调用 `isParentWebchatSessionContext({ channel: messageChannelHint, sessionKey: options?.sessionKey })`。
     - 调用 `createOpenClawTools()` 时传入：

       ```ts
       disableMessageTool: options?.disableMessageTool === true || isParentWebchatSession;
       ```

     - 保持其他 policy pipeline 顺序不变。

   - Why: 工具应在 prompt 和 schema 生成前消失，工具内部报错只能作为第二道防线。
   - Dependencies: Phase 1.
   - Complexity: Low.
   - Risk: Medium. 需要确认内部 WebChat 调用和真实后台 internal run 的区分。

2. **`message` 纵深保护复用 helper**
   File: `src/agents/tools/message-tool.ts`
   - Action:
     - 用 `isParentWebchatSessionContext()` 替换本地 `isParentWebchatMessageContext()` 的宽松判断。
     - 保留 `assertWebchatMessageBoundary()`。
     - 保留显式外部 channel target 的拒绝文本，供旧入口、测试和直接工具构造使用。
   - Why: 动态隐藏减少误调用，运行时拒绝防止旁路调用。
   - Dependencies: Phase 1.
   - Complexity: Low.
   - Risk: Low.

3. **WebUI artifact 插件按调用点分别复用**
   File: `extensions/webui-artifacts/index.ts`
   - Action:
     - `isParentWebchatToolContext()` 改用 `isParentWebchatSessionContext({ channel: ctx.messageChannel, sessionKey: ctx.sessionKey })`。
     - `subagent_handoff_delivery` **只复用 `isParentWebchatSessionKey()`**，channel 组合保持原样：

       ```ts
       isParentWebchatSessionKey(event.requesterSessionKey) &&
         (!channel || channel === "webchat" || channel === "internal");
       ```

     - 保持 workspace、endpoint 和 apiKey 条件不变。

   - Why: 两个调用点共享的是 session 形状，不是 channel 准入规则。
   - Dependencies: Phase 1.
   - Complexity: Low.
   - Risk: **High（实施约束，非可选风险）**。若把 handoff 判定也换成 `isParentWebchatSessionContext()`，hook 会在 `requesterOrigin.channel` 缺失时静默返回，researcher 导出文件不会发布到 WebChat，且无错误可见。

4. **补齐核心和插件工具矩阵测试**
   Files:
   - `src/agents/pi-tools.message-provider.test.ts`
   - `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`
   - `src/agents/tools/message-tool.test.ts`
   - `extensions/webui-artifacts/index.test.ts`
   - Action:
     - Feishu：包含 `message`。
     - WebChat：不包含 `message`。
     - `internal + parent WebChat session`：不包含 `message`，插件返回 `webui_artifact_publish`。
     - `internal + 非 WebChat session`：不套用 WebChat 工具规则。
     - Feishu、`control-ui`：插件继续返回 `null`。
     - **handoff 正例：合法 WebChat session key + `requesterOrigin` 缺失时仍发布 artifact。**
     - handoff 正例：`webchat`、`internal`；负例：`feishu`、畸形 key。
     - WebChat message 旁路调用继续触发稳定错误。
   - Why: 同时覆盖构造期能力矩阵和执行期纵深保护。
   - Dependencies: Steps 1-3.
   - Complexity: Medium.
   - Risk: Low.

### Phase 3: 删除 `artifact_jobs`

1. **删除实现与注册**
   Files:
   - `src/agents/tools/artifact-jobs-tool.ts`（删除）
   - `src/agents/tools/artifact-jobs-tool.test.ts`（删除）
   - `src/agents/openclaw-tools.ts`
   - `src/agents/tool-catalog.ts`
   - Action: 移除工具构造、注册与 catalog 条目。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low.

2. **删除 policy 别名与 profile 条目**
   File: `src/agents/tool-policy-shared.ts`
   - Action:
     - 删除 `"group:artifacts"` 别名（不留空数组）。
     - 从 `TOOL_PROFILES.coding.allow` 与 `group:openclaw` 移除 `artifact_jobs`。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low.

3. **删除配置类型与 schema**
   Files:
   - `src/config/types.tools.ts`
   - `src/config/zod-schema.agent-runtime.ts`
   - Action: 移除 `ArtifactJobsConfig` 与 `ToolsSchema.artifactJobs`。
   - Why: `ToolsSchema` 是 `.strict()`，保留 schema 会让已删除的能力继续出现在配置补全与 Control UI。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Medium. 见 Risks 的跨仓顺序条目。

4. **标记历史文档**
   Files:
   - `docs/plans/2026-05-28-otr-pptx-same-workspace-subagent.md`
   - `docs/research/openclaw-frontend-integration/openclaw-frontend-integration-research.md`
   - Action: 在开头加一行标注 `artifact_jobs` 已于本次移除、相关链路仅供历史参考；正文不改。
   - Dependencies: Step 1.
   - Complexity: Low.
   - Risk: Low.

### Phase 4: 条件化 Tooling 与工具清单同源构造

1. **拆分并条件化 Tooling 指导**
   File: `src/agents/system-prompt.ts`
   - Action:
     - 把搜索、`TOOLS.md`、长等待和子 agent 文本构造成独立数组。
     - 每组末尾添加空行，形成独立 Markdown 段落。
     - 根据 `availableTools` 条件化注入。
     - 保留动态 `execToolName` 和 `processToolName` casing。
   - Why: 工具使用指导应与实际能力一致。叶子 subagent 当前确实收到了引用不存在工具的指导。
   - Dependencies: None.
   - Complexity: Medium.
   - Risk: Medium. prompt 文本变化会影响 stability 测试和报告统计。

2. **删除硬编码 fallback 工具清单**
   File: `src/agents/system-prompt.ts`
   - Action:
     - 删除 `toolNames` 为空时的硬编码清单分支。
     - `toolNames` 改为必填 `string[]`，运行时保留 `?? []` 防御。
     - 空数组时输出 `No tools are available in this runtime.`。
     - 更新所有省略 `toolNames` 的既有用例，改为显式传入。
   - Why: 该分支在生产可触发（`commands-system-prompt.ts` 工具创建失败时返回空数组），且与 Step 1 的条件化直接矛盾。
   - Dependencies: Step 1.
   - Complexity: Medium.
   - Risk: Medium. 编译期破坏面较大，靠 `pnpm typecheck` 兜底。

3. **工具清单同源构造与 report 边界**
   Files:
   - `src/agents/system-prompt.ts`
   - `src/agents/system-prompt-report.ts`
   - `src/agents/system-prompt-report.test.ts`
   - Action:
     - 从 `system-prompt.ts` 导出纯函数 `buildToolListText(toolNames, toolSummaries)`；`buildAgentSystemPrompt()` 内部改用它。
     - `buildToolListText()` 必须内含 `toolOrder` 排序、`extraTools.toSorted()` 追加与 `coreToolSummaries` 优先级（见 Architecture Changes 7 的成立条件），否则一致性断言无法通过。
     - **不改 `buildAgentSystemPrompt()` 返回类型**，三个调用方不动。
     - `buildSystemPromptReport()` 用已有的 `params.tools` 派生 `toolNames` 与 `buildToolSummaryMap(tools)`，调用同一函数得到 `toolListText`，删除 `extractToolListText()` 的文本解析。
     - 断言 `toolListChars` 只覆盖工具行；空工具集合时 `listChars = 0`、`schemaChars = 0`、`entries = []`。
     - 断言过滤后的 `tools.entries` 与 schema 统计不含 `artifact_jobs`、`tts` 或 WebChat `message`。
     - 增加一条断言：同一 tools 数组下，report 的 `toolListText` 与 prompt 中实际渲染的工具清单字符级一致。
   - Why: Langfuse system prompt 报告必须反映真实工具成本。同源构造优于对自身输出的二次解析，且顺带消除 `tools.entries` 与 `toolListChars` 各有来源导致的不一致。
   - Dependencies: Steps 1-2.
   - Complexity: Low.
   - Risk: Low.

4. **工具构造失败的诊断告警**
   Files:
   - `src/auto-reply/reply/commands-system-prompt.ts`（catch 在 `:70`）
   - `src/auto-reply/reply/commands-context-report.ts`（`/context list` / `detail` / `deep` / `json` 四个分支）
   - `src/auto-reply/reply/commands-export-session.ts`（`:152` 目前是 `const { systemPrompt, tools } = ...`，需一并取 `warnings`）
   - `src/auto-reply/reply/export-html/template.js`（从 session data 读取并渲染 warnings banner）
   - Action:
     - catch 保留为 fail-soft，但补 `log.warn` / `log.error`（sessionKey、agentId、channel、provider/model、错误类型与 message，不含敏感配置值）。
     - `CommandsSystemPromptBundle`（`commands-system-prompt.ts:19`）增加 `warnings: [{ code: "tools.create_failed", message: "Tool construction failed; report uses empty tool list." }]`。
     - `resolveContextReport()` 内部返回 `{ report, warnings }`；已有 `source="run"` report 不重新构造工具，warnings 为空。
     - `/context json` 原样输出 warnings；`/context list` / `detail` 显示警告行；export session data 与模板脚本共同渲染 warning banner。
     - 警告不注入生产 system prompt；主运行路径保持失败即失败，不新增 catch。
   - Why: `tools=[]` 必须可区分「真实无工具」与「构造失败」。`/context` 会直接显示 `report.tools.listChars`（`commands-context-report.ts:127`），静默的 `0` 看起来就像「策略正常关闭了工具」。
   - Dependencies: Step 2.
   - Complexity: Medium.
   - Risk: Low.
   - **覆盖缺口（显式声明）**：bundle `warnings` 由 `commands-system-prompt.test.ts` 覆盖，`/context` 渲染由 `commands-context-report.test.ts` 覆盖；**export HTML banner 没有测试文件**（`commands-export-session.test.ts` 不存在），本次不新建，改为人工核对一次导出产物，并记入上线门槛。

5. **补齐 system prompt 条件测试**
   Files:
   - `src/agents/system-prompt.test.ts`
   - `src/agents/system-prompt-stability.test.ts`
   - `src/agents/system-prompt-params.test.ts`
   - Action:
     - `exec` 存在时显示 `rg` 指导，不存在时省略。
     - `process` 存在时显示长等待指导。
     - `sessions_spawn` 存在时显示 spawn 和 push-based completion 指导。
     - `sessions_spawn` 不存在时不要求模型创建子 agent。
     - `subagents`、`sessions_list` 的轮询文本只引用可用工具。
     - Tooling 各职责之间存在空行。
     - `toolNames: []` 时输出 `No tools are available in this runtime.`。
     - `commands-system-prompt` 工具构造失败时：bundle 带 `warnings`、日志落盘、prompt 文本不含诊断内容。
     - `commands-context-report`：bundle 带 `warnings` 时，`/context json` 输出该字段、`list` / `detail` 显示警告行。
   - Why: 将提示词能力一致性和排版合同固定为回归测试。
   - Dependencies: Steps 1-4.
   - Complexity: Medium.
   - Risk: Low.

### Phase 5: 部署配置（`openclaw-workspace`，独立 PR）

1. **更新配置与清理死指令**
   Files:
   - `../openclaw-workspace/openclaw.json`
   - `../openclaw-workspace/workspace/AGENTS.md`
   - `../openclaw-workspace/workspace/skills/otr-pptx-restyle/SKILL.md`
   - Action:
     - `tools.deny` 改为 `["gateway", "tts"]`。
     - 删除 `tools.artifactJobs` 配置块。
     - 删除 `AGENTS.md:366` 与 `SKILL.md:20` 的「Do not use `artifact_jobs`」死指令。
     - `jq empty openclaw.json` 验证。
   - Why: `artifact_jobs` 删除后，这些指令变成引用不存在工具的死文本。
   - Dependencies: 与核心 PR 的顺序见 Risks。
   - Complexity: Low.
   - Risk: Low.

### Phase 6: 运行态验收

1. **核对运行态 system prompt**
   Repository: deployed OpenClaw environment
   - Action:
     - 先在不重启 Gateway 的前提下确认部署使用的 config truth source。
     - 若配置或构建产物需要重启才生效，先取得 owner 明确批准。
     - 分别触发一条真实 Feishu 入站和一条父 WebChat 请求。
     - 在 Langfuse observation 中核对 available tool names 和 system prompt。
   - Expected:
     - Feishu 包含 `message`，不含 `webui_artifact_publish`、`artifact_jobs`、`tts`。
     - WebChat 包含 `webui_artifact_publish`，不含 `message`、`artifact_jobs`、`tts`。
     - WebChat trace 使用 `internal` 时结果不变。
     - Tooling 指导只引用实际存在的工具。
   - Why: 单元测试无法证明 Gateway、session key 和部署配置组合后的最终 provider payload。
   - Dependencies:
     - 核心 PR 与 `openclaw-workspace` 配置 PR 均已部署。
     - **父 WebChat 产品请求还要求 `agent-server` BFF 与 `agent-frontend` 同时在线且 target binding 可用**——这是正常产品链路触发 `internal + 五段 webchat key` 会话的入口，需在申请部署窗口前确认，避免验收当天才发现 BFF 未启动。
   - Complexity: Medium.
   - Risk: Medium. 需要真实登录态、Langfuse 访问和受控部署窗口。

## Testing Strategy

验收分两层。**上线门槛不阻塞 PR 合入，只阻塞「宣布本计划完成」。**

### 合入门槛（本 PR 必须全绿，全部本地可验证）

1. `pnpm typecheck`

   唯一能覆盖本次编译期破坏面的一步：`toolNames` 改必填、`artifact_jobs` 类型引用移除、`CommandsSystemPromptBundle.warnings` 字段增补。定向 vitest 不会编译未被选中的测试文件。

2. 核心定向测试：

   ```bash
   pnpm vitest run --config vitest.config.ts \
     src/agents/session-surface.test.ts \
     src/agents/pi-tools.message-provider.test.ts \
     src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts \
     src/agents/tools/message-tool.test.ts \
     src/agents/system-prompt.test.ts \
     src/agents/system-prompt-report.test.ts \
     src/agents/system-prompt-stability.test.ts \
     src/agents/system-prompt-params.test.ts \
     src/agents/pi-tools-agent-config.test.ts \
     src/auto-reply/reply/commands-system-prompt.test.ts \
     src/auto-reply/reply/commands-context-report.test.ts
   ```

3. 工具策略回归：`src/agents/tool-policy.test.ts`

4. 配置 schema 回归：`src/config/config.schema-regressions.test.ts`

5. 扩展定向测试：

   ```bash
   pnpm vitest run --config vitest.extensions.config.ts \
     extensions/webui-artifacts/index.test.ts
   ```

6. `git diff --check`

7. `src/agents/tools/artifact-jobs-tool.ts` 及其测试已随实现删除

### 上线门槛（需部署与 owner 批准）

8. `openclaw-workspace` 配置 PR 合入，`jq empty openclaw.json` 通过
9. 查询近 30 天 Langfuse called tool names，确认无 `artifact_jobs` 未记录调用（删除不可逆，部署前完成）
10. 真实 Feishu 请求、真实父 WebChat 请求、Gateway `internal` 执行的 WebChat 请求
11. Langfuse available tools、system prompt 和 tool schema 三方一致
12. 人工核对一次 session export HTML 的 warning banner（无自动化覆盖，见 Phase 4 Step 4）

### 排除

- 不运行完整主测试套件。
- 不运行不相关 UI、native app、live provider 测试。

## Risks & Mitigations

- **Risk: handoff 判定被错误替换（最高优先级实施约束）**
  - `subagent_handoff_delivery` 允许 `requesterOrigin.channel` 缺失。正常 WebChat spawn 通常会捕获 `webchat` 或 `internal`，但事件类型、旧持久化记录和 handoff 传递链都明确允许缺失，该兼容合同真实存在。
  - 若换成 `isParentWebchatSessionContext()`，hook 会静默返回，researcher 文件不会发布到 WebChat，且无错误可见。
  - Mitigation: 只复用 `isParentWebchatSessionKey()`；增加「合法 key + channel 缺失仍发布」的正例测试。

- **Risk: 把普通 internal run 误判为 WebChat**
  - Mitigation: channel 与严格五段 session key 必须同时匹配；增加畸形和后台 session 负例。

- **Risk: WebChat 父会话中的 main-session cron 失去主动投递**
  - `sessionTarget="main"` 的 WebChat cron 会向保存的 WebChat session key 注入 system event，再以 `internal` 触发 heartbeat。移除 `message` 后，这类任务**不保证主动即时投递**——WebChat 不是 deliverable channel，没有可靠的即时推送出口；但结果仍会写入会话 transcript。
  - `sessionTarget="isolated"` **不受影响**：运行 key 是 `agent:<id>:cron:...`，且 cron 有独立的 announce / webhook delivery 链路。
  - Mitigation: 已确认接受该收窄，不做事先部署核查，记录为已知收窄。需要定时外部投递时应使用 isolated agentTurn，并配置明确的 announce 外部 channel 或 webhook。暂不为 cron 引入触发来源参数——当前证据不足以支撑破坏纯 `(channel, sessionKey)` 判定；若未来产品明确要求 main-session WebChat cron 主动跨 channel 投递，再单独设计 cron delivery 合约。

- **Risk: WebChat 失去显式向 Feishu 主动发送文件的能力**
  - Mitigation: 本方案按已确认需求从 WebChat 完全移除 `message`，这是**最终状态而非过渡**；在 PR 正文中明确这是有意收窄。若未来恢复跨渠道发送，应增加独立、显式授权的跨渠道工具，不能重新暴露完整 `message`。

- **Risk: 前端按工具名提供关联展示增强（跨仓）**
  - `agent-frontend` 硬编码 `webui_artifact_publish`（artifact 就地卡片锚点）、`sessions_spawn`（子 agent 调用行锚点）、`read`/`read_file`（技能回显）。工具从父 WebChat 消失时不会报错：artifact 会降级到 unlinked 区域，已发现的 child 会降级到「其他子任务」，技能标签会降级为普通工具名；但调用行内的关联体验会退化，且核心仓测试仍可全绿。本计划保住这三个；后续扩大裁剪范围前必须重新核对前端降级语义。
  - Mitigation: Non-goal 明确不裁剪 `sessions_spawn`；任何扩大 WebChat 裁剪范围的后续改动必须先核对 agent-frontend 的工具名依赖。agent-server BFF 不消费工具清单（`hello.features` 来自 RPC 方法白名单与绑定配置），无需同步改动。

- **Risk: 跨仓顺序——残留的 `tools.artifactJobs` 键**
  - 核心 PR 删除 schema 后，若 `openclaw.json` 仍有 `tools.artifactJobs`：**不会**导致 Gateway 启动失败（运行时 `loadConfig()` 不做 zod 校验），但**会**被 `validateConfig()` 判为 unrecognized key，影响 `config.apply`、`openclaw doctor` 和 Control UI 改配置。
  - Mitigation: workspace 配置 PR 先合并并部署；核心 PR 正文写明该依赖与部署顺序。

- **Risk: `artifact_jobs` 存在未记录的模型自主调用**
  - Mitigation: 查询近 30 天 Langfuse called tool names。该核查**不阻塞核心 PR 合入**（当前证据充分：upstream 无此工具、部署侧主动劝阻、无生产调用链），但作为上线门槛在部署前完成；若发现未记录调用，在部署前回退或恢复，避免「代码已合入 main 才发现调用」的被动局面。

- **Risk: 编译期破坏漏到 CI**
  - `toolNames` 改必填会破坏所有省略该参数的既有用例的类型，定向 vitest 覆盖不到。
  - Mitigation: `pnpm typecheck` 作为合入门槛第一项。
  - 备选（若要进一步收窄破坏面）：保持 `toolNames?: string[]` + `?? []`，只删 fallback 分支。代价是失去「强制审计每个调用点」的编译期保证。本计划维持必填。

- **Risk: fork 与 upstream 在 prompt 相关文件上的分叉**
  - `src/agents/system-prompt.ts` 本仓 727 行、upstream 1458 行，且 upstream 已做模块重组；`system-prompt-report.ts` 同样已实质分叉；`git log --merges` 中没有一次 upstream 合并。两个文件已不是「差一个签名」的关系。
  - Mitigation: 本方案对这两个文件只做**纯新增导出**（`buildToolListText`）与内部实现调整，不改 `buildAgentSystemPrompt()` 签名，使未来任何合并策略下的冲突形态最简单。

- **Risk: 删除 fallback 后极端配置下 prompt 无工具清单**
  - Mitigation: 空数组输出明确的 `No tools are available in this runtime.`，并在 report 中如实体现为 `listChars = 0`，而不是伪装成有工具可用。

- **Risk: Gateway 仍使用旧构建或旧配置**
  - Mitigation: 运行态核对实际入口、构建 commit 和 config truth source；重启必须单独批准。

## Implementation Order

1. Phase 1：session surface 双层 helper 与单元测试。
2. Phase 2：WebChat 工具构造去 `message`，纵深保护与插件按调用点分别复用。
3. Phase 3：删除 `artifact_jobs` 全量实现、policy 别名、配置 schema，标记历史文档。
4. Phase 4：条件化 Tooling、删除 fallback、工具清单同源构造与 report 边界、命令路径诊断告警。
5. 跑完合入门槛 1-7，提交 `openclaw-integration` 单个 PR。
6. 在 `openclaw-workspace` 提交配置 PR（Phase 5），先于核心 PR 部署。
7. 取得部署及必要重启批准。
8. Phase 6：用真实 Feishu、WebChat 和 Langfuse trace 验收。

`## Tool Call Style` 的全局改写另立计划，不在本序列内。

## Success Criteria

### 合入门槛

- [ ] Feishu 最终工具集合包含 `message`。
- [ ] Feishu 最终工具集合不包含 `webui_artifact_publish`、`artifact_jobs` 和 `tts`。
- [ ] 父 WebChat 最终工具集合包含 `webui_artifact_publish`。
- [ ] 父 WebChat 最终工具集合保留 `sessions_spawn`。
- [ ] 父 WebChat 最终工具集合不包含 `message`、`artifact_jobs` 和 `tts`。
- [ ] `internal + parent WebChat session` 使用 WebChat 工具矩阵。
- [ ] 普通 internal、subagent、`control-ui` 和畸形 session 不误用 WebChat 工具矩阵。
- [ ] `subagent_handoff_delivery` 在 `requesterOrigin.channel` 缺失时仍发布 artifact。
- [ ] 被过滤工具的名称、描述和 schema 均不进入 provider 请求。
- [ ] `artifact_jobs` 在源码、catalog、policy 别名和配置 schema 中均无残留。
- [ ] Tooling 指导按职责分段，且只引用实际存在的工具。
- [ ] `toolNames: []` 时输出真实状态，不输出硬编码清单。
- [ ] system prompt report 的 `toolListChars` 只统计工具清单，且与 prompt 中实际渲染的工具清单字符级一致。
- [ ] `buildAgentSystemPrompt()` 返回类型未变，三个调用方未改动。
- [ ] 命令路径工具构造失败时写日志且 bundle 带 `warnings`；生产 system prompt 不含诊断文本；主运行路径无新增 catch。
- [ ] `pnpm typecheck` 通过。
- [ ] 合入门槛列出的核心、策略、schema 与扩展定向测试全部通过。
- [ ] `git diff --check` 通过。

### 上线门槛

- [ ] `openclaw-workspace` 配置 PR 合入，`jq empty openclaw.json` 通过。
- [ ] 近 30 天 Langfuse called tool names 中无 `artifact_jobs` 调用记录（删除不可逆，部署前完成）。
- [ ] `agent-server` BFF 与 `agent-frontend` 在线且 target binding 可用，父 WebChat 请求可触发。
- [ ] 真实 Feishu、WebChat 和 Langfuse 验收结果与测试矩阵一致。
- [ ] 人工核对 session export HTML 的 warning banner（无自动化覆盖）。
