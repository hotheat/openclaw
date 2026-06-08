# Implementation Plan: Langfuse Native Agent Trace

## Overview

为 OpenClaw 增加原生 Langfuse trace 插件，用于记录 agent run、LLM generation、tool call
的树状业务链路。现有 `diagnostics-otel` 继续负责 OTel/OTLP 系统观测，Langfuse 插件负责接近
LangGraph + Langfuse 的 agent 调试体验。

该方案默认使用 `captureMode: "safe"`，只记录结构、指标和摘要，不默认保存完整 prompt、工具参数、
工具结果。需要更接近 LangGraph 默认调试效果时，可以显式切换到 `llm_text` 或 `full`。

## Requirements

- 新增原生 Langfuse trace 插件，不把现有 `diagnostics-otel` 作为 Langfuse 主接入路径。
- Langfuse 连接变量从 `~/.openclaw/.env` 读取，并通过 `openclaw.json` 的 `${VAR}` 引用。
- 缺少 Langfuse host/public key/secret key 时直接报错，避免静默降级。
- 默认 `captureMode: "safe"`，不保存完整 prompt、工具参数、工具结果。
- 支持 `captureMode: "llm_text"` 记录 prompt 和 assistant output，但工具 payload 仍摘要。
- 支持 `captureMode: "full"` 记录完整 LLM 和 tool payload，且所有 payload 仍经过统一 mask。
- 保留 `diagnostics-otel` 发往 OTel collector/SigNoz 的能力。
- 在 Langfuse trace metadata 中写入 `runId`、`sessionId`、`sessionKey`、model、channel，以及可用时的
  `otel_trace_id`。
- Feishu 主 agent 通过 `sessions_spawn` 调 researcher/subagent，或通过 `sessions_send` 触发
  agent-to-agent run 时，Langfuse 中必须能关联父子 run。
- Langfuse 写入失败不能中断 agent run；配置缺失和认证失败应在启动阶段暴露。

## Current State

- `extensions/diagnostics-otel` 已能把 OpenClaw diagnostics events 导出为 OTLP/HTTP traces、
  metrics、logs。
- `diagnostics-otel` 的数据来源是 message、queue、session、webhook、model usage 等运行时诊断事件，
  不具备完整 agent run、generation、tool span 层级。
- `src/agents/pi-embedded-runner/run/attempt.ts` 已在 prompt 前后触发 `llm_input`、`llm_output`、
  `agent_end` typed hooks。
- `src/agents/pi-embedded-subscribe.handlers.tools.ts` 已能拿到 tool start/end、tool name、tool call id、
  args、sanitized result、duration、error。
- `sessions_spawn` 通过 `spawnSubagentDirect` 再调用 gateway `agent` 方法启动子 agent run，并在
  subagent registry 中登记 `runId`、`childSessionKey`、`requesterSessionKey`。
- `sessions_send` 和 agent-to-agent announce/reply flow 通过 gateway `agent` 方法启动嵌套 run，并携带
  `inputProvenance.kind/sourceSessionKey/sourceChannel/sourceTool`。
- 当前 hook 足够实现近似 trace，但缺少一个面向 tracing 的稳定 core API，也缺少 generation 级
  stream wrapper。
- 配置加载已会读取当前工作目录 `.env` 与 `~/.openclaw/.env`，且不会覆盖已有环境变量。

## Architecture Changes

### Config schema

在 `src/config/types.base.ts`、`src/config/zod-schema.ts`、`src/config/schema.help.ts`、
`src/config/schema.labels.ts`、`src/config/schema.tags.ts` 增加：

- `diagnostics.langfuse.enabled`
- `diagnostics.langfuse.host`
- `diagnostics.langfuse.publicKey`
- `diagnostics.langfuse.secretKey`
- `diagnostics.langfuse.serviceName`
- `diagnostics.langfuse.captureMode`: `"safe" | "llm_text" | "full"`
- `diagnostics.langfuse.flushIntervalMs`
- `diagnostics.langfuse.timeoutMs`

### Runtime configuration

`~/.openclaw/.env` 示例：

```dotenv
LANGFUSE__ENABLED=true
LANGFUSE__HOST=http://localhost:3005
LANGFUSE__PUBLIC_KEY=pk-lf-...
LANGFUSE__SECRET_KEY=sk-lf-...
```

`openclaw.json` 示例：

```json5
{
  plugins: {
    allow: ["diagnostics-langfuse", "diagnostics-otel"],
    entries: {
      "diagnostics-langfuse": {
        enabled: true,
      },
      "diagnostics-otel": {
        enabled: true,
      },
    },
  },
  diagnostics: {
    enabled: true,
    langfuse: {
      enabled: true,
      host: "${LANGFUSE__HOST}",
      publicKey: "${LANGFUSE__PUBLIC_KEY}",
      secretKey: "${LANGFUSE__SECRET_KEY}",
      serviceName: "openclaw-gateway",
      captureMode: "safe",
      flushIntervalMs: 5000,
      timeoutMs: 10000,
    },
    otel: {
      enabled: true,
      endpoint: "http://localhost:4318",
      protocol: "http/protobuf",
      serviceName: "openclaw-gateway",
      traces: true,
      metrics: true,
      logs: true,
    },
  },
}
```

### Agent trace sink API

在 core 增加通用 trace sink 注册面，避免 core 直接依赖 Langfuse SDK。

新增建议位置：

- `src/agents/tracing/types.ts`
- `src/agents/tracing/runner.ts`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`

核心类型：

- `AgentTraceSink`
  - `startRun(event): AgentTraceRunHandle | Promise<AgentTraceRunHandle | void>`
- `AgentTraceRunHandle`
  - `startGeneration(event): AgentTraceObservationHandle | void`
  - `startTool(event): AgentTraceObservationHandle | void`
  - `recordSubagentLifecycle(event): void | Promise<void>`
  - `end(event): void | Promise<void>`
- `AgentTraceObservationHandle`
  - `end(event): void | Promise<void>`

插件 API 新增：

- `api.registerAgentTraceSink(sink, opts?)`

registry 新增：

- `registry.agentTraceSinks`

### Langfuse plugin

新增 `extensions/diagnostics-langfuse`：

- `openclaw.plugin.json`
- `package.json`
- `index.ts`
- `src/config.ts`
- `src/service.ts`
- `src/capture.ts`
- `src/mask.ts`
- `src/service.test.ts`

插件职责：

- 解析并校验 `diagnostics.langfuse`。
- 初始化 Langfuse JS/TS SDK。
- 启动时执行 auth check；失败时记录明确错误。
- 注册 `AgentTraceSink`。
- stop 时 flush/shutdown。
- 统一执行 capture policy 和 mask。

### Trace data model

root trace:

- name: `openclaw.agent.run`
- deterministic trace id: 使用 Langfuse SDK 从 `runId` 派生，便于跨日志定位。
- metadata:
  - `runId`
  - `sessionId`
  - `sessionKey`
  - `agentId`
  - `channel`
  - `lane`
  - `provider`
  - `model`
  - `workspaceDir`
  - `otel_trace_id`
  - `spawnedBy`
  - `inputProvenance.kind`
  - `inputProvenance.sourceSessionKey`
  - `inputProvenance.sourceChannel`
  - `inputProvenance.sourceTool`
  - `parentRunId`
  - `parentTraceId`

generation observation:

- name: `openclaw.llm.generation`
- model: 当前 provider/model
- input/output: 按 `captureMode` 决定
- metadata:
  - prompt length
  - history role counts
  - history text chars
  - image count
  - usage
  - error

tool observation:

- name: `openclaw.tool.<toolName>`
- input/output: 按 `captureMode` 决定
- metadata:
  - `toolName`
  - `toolCallId`
  - duration
  - params keys
  - result type
  - result length
  - isError
  - error summary

subagent lifecycle event/span:

- name: `openclaw.subagent.<phase>`
- phase: `spawning`、`spawned`、`ended`
- metadata:
  - `parentRunId`
  - `parentSessionKey`
  - `childRunId`
  - `childSessionKey`
  - `targetAgentId`
  - `label`
  - `mode`
  - `threadRequested`
  - `outcome`
  - `reason`
  - `error`

## Subagent Trace Correlation

Feishu 调 researcher/subagent 的主要链路：

1. Feishu message 进入主 agent。
2. 主 agent 调用 `sessions_spawn`。
3. `sessions_spawn` 调 `spawnSubagentDirect`。
4. `spawnSubagentDirect` 调 gateway `agent` 启动子 agent run。
5. 子 agent 进入同一个 `runEmbeddedAttempt` 链路。

因此第一版必须保证两层能力：

- 子 agent 自身生成完整 root trace、generation、tool span。
- 父子 run 通过 metadata 可互查。

P0 最小实现：

- `sessions_spawn` tool span 在 `safe` 模式也保留：
  - `childRunId`
  - `childSessionKey`
  - `targetAgentId`
  - `mode`
  - `label`
  - `status`
- 子 agent root trace metadata 保留：
  - `lane: "subagent"`
  - `spawnedBy`
  - `requesterSessionKey`
  - `parentRunId`，如果调用端能提供
  - `inputProvenance`，如果是 `sessions_send`/agent-to-agent run
- `subagent_spawned` 与 `subagent_ended` 生命周期写入父 trace 或作为可关联 event。

P1 同 trace 嵌套实现：

- gateway `agent` params 增加可选 `traceParent`：
  - `parentTraceId`
  - `parentRunId`
  - `parentSessionKey`
  - `parentObservationId`
- `sessions_spawn`、`sessions_send`、`runAgentStep` 在二次调用 gateway `agent` 时传入 `traceParent`。
- Langfuse 插件在子 agent run 启动时复用 `parentTraceId`，并把子 run 创建为
  `openclaw.subagent.run` observation。
- 子 agent 的 generation/tool observation 挂在 `openclaw.subagent.run` 下。
- 如果父 agent 已经结束，只要 Langfuse SDK 支持用已有 `traceId` 和 parent observation id 创建后续
  observation，仍可追加到同一个 trace。
- 如果 SDK 限制无法跨异步边界追加子 observation，则退化为独立 trace + 双向 metadata link。

目标同 trace 结构：

```text
openclaw.agent.run
  openclaw.llm.generation
  openclaw.tool.sessions_spawn
    openclaw.subagent.run
      openclaw.llm.generation
      openclaw.tool.read
      openclaw.tool.exec
```

第一阶段默认采用“双向 metadata link”，避免强依赖 SDK 的嵌套 trace 能力；实现时保留
`traceParent` 类型，后续可升级为同 trace 嵌套。

## Capture Policy

### `captureMode: "safe"`

默认模式。目标是可定位问题，同时降低隐私和存储风险。

- LLM input:
  - 保存 prompt 字符数
  - 保存 history role counts
  - 保存 history text chars
  - 保存 image count
  - 不保存 prompt 全文
  - 不保存 history message 全文
- LLM output:
  - 保存 assistant text 字符数
  - 保存 usage
  - 保存 error/finish 状态
  - 不保存 assistant output 全文
- Tool:
  - 保存 tool name、tool call id、duration
  - 保存 params key 列表
  - 保存 result 类型和长度
  - 保存 error 摘要
  - 不保存完整 params/result

### `captureMode: "llm_text"`

用于更接近 LangGraph 调试体验，但仍控制 tool 泄露面。

- 保存 prompt 和 assistant output。
- history message 可保存摘要，不默认保存完整历史。
- tool params/result 仍按 `safe` 摘要。

### `captureMode: "full"`

用于显式排障。

- 保存 prompt、history、assistant output、tool params、tool result。
- 所有数据进入 Langfuse SDK 前必须经过统一 mask。

### Mask rules

`src/capture.ts` 与 `src/mask.ts` 负责：

- 删除常见 secret 字段：`apiKey`、`token`、`password`、`authorization`、`secret`。
- 对长文本设置最大长度，超出部分截断并记录原始长度。
- 对 media/base64 只记录类型、大小、数量，不保存原始内容。
- mask 失败时 fail closed：该字段落为 `[masked]`，不发送原始值。

## Execution Flow

链路：

1. gateway 启动并加载 `~/.openclaw/.env`。
2. `openclaw.json` 解析 `${LANGFUSE__...}`，缺失变量直接报错。
3. plugin loader 加载 `diagnostics-langfuse`。
4. 插件初始化 Langfuse client，执行 auth check，注册 `AgentTraceSink`。
5. `runEmbeddedAttempt` 创建 agent trace run。
6. `runEmbeddedAttempt` 包装 Pi `streamFn`，每次模型调用创建 generation observation。
7. `subscribeEmbeddedPiSession` 把 trace run handle 传入 tool handlers。
8. tool start/end 创建并结束 tool observation。
9. `sessions_spawn` 返回 child run 后，父 trace 的 tool span 补写 child run/session metadata。
10. 子 agent run 启动时把 `lane/spawnedBy/traceParent/inputProvenance` 写入 root trace metadata。
11. `subagent_spawned/subagent_ended` 写入 lifecycle event。
12. agent run 完成或失败时结束 root trace。
13. gateway stop 时插件 flush/shutdown。

## Implementation Steps

### Phase 1: Config schema and docs

1. **Add Langfuse config types** (File: `src/config/types.base.ts`)
   - Action: 增加 `DiagnosticsLangfuseConfig`，并挂到 `DiagnosticsConfig.langfuse`。
   - Why: 让 `OpenClawConfig` 一等支持 Langfuse 配置。
   - Dependencies: None
   - Risk: Low

2. **Add zod validation** (File: `src/config/zod-schema.ts`)
   - Action: 校验 `enabled`、`host`、`publicKey`、`secretKey`、`captureMode`、flush/timeout。
   - Why: 非法配置在启动前暴露。
   - Dependencies: Step 1
   - Risk: Low

3. **Update schema metadata** (Files: `src/config/schema.help.ts`, `src/config/schema.labels.ts`, `src/config/schema.tags.ts`)
   - Action: 增加 Langfuse 字段说明、标签和 UI label。
   - Why: 保持配置帮助和 UI 元数据完整。
   - Dependencies: Step 1
   - Risk: Low

4. **Update logging docs** (Files: `docs/logging.md`, `docs/zh-CN/logging.md`)
   - Action: 增加 Langfuse 与 `diagnostics-otel` 的职责区别、配置示例、captureMode 说明。
   - Why: 避免用户把 OTel collector endpoint 当成 Langfuse endpoint。
   - Dependencies: Step 1
   - Risk: Low

### Phase 2: Trace sink API

1. **Create trace sink types** (File: `src/agents/tracing/types.ts`)
   - Action: 定义 `AgentTraceSink`、`AgentTraceRunHandle`、`AgentTraceObservationHandle` 和事件类型。
   - Why: 给 core 与插件之间建立稳定边界。
   - Dependencies: None
   - Risk: Medium

2. **Create trace runner** (File: `src/agents/tracing/runner.ts`)
   - Action: 从 registry 聚合 sinks，提供 `startAgentTraceRun(...)`。
   - Why: 多个 tracing 插件可以并存，且单个 sink 失败不影响其他 sink。
   - Dependencies: Step 1
   - Risk: Medium

3. **Extend plugin API** (Files: `src/plugins/types.ts`, `src/plugins/registry.ts`)
   - Action: 增加 `registerAgentTraceSink`、registry 存储结构和 plugin record 统计字段。
   - Why: 让 `diagnostics-langfuse` 能注册 trace sink。
   - Dependencies: Step 1
   - Risk: Medium

4. **Add trace parent types** (Files: `src/agents/tracing/types.ts`, `src/gateway/protocol/schema/agent.ts`)
   - Action: 定义 `TraceParent`，并允许 gateway `agent` params 接收 `traceParent`。
   - Why: 为 subagent 和 agent-to-agent run 传递父子 trace 关系。
   - Dependencies: Step 1
   - Risk: Medium

5. **Add registry tests** (File: `src/plugins/registry.agent-trace-sink.test.ts`)
   - Action: 覆盖 sink 注册、plugin record 统计、disabled plugin 不注册。
   - Why: 保护新插件扩展面。
   - Dependencies: Step 3
   - Risk: Low

### Phase 3: Agent runtime instrumentation

1. **Start and end root trace** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 在模型和 session 上下文确定后启动 root trace；写入 run/session/model/lane/spawnedBy/inputProvenance/traceParent metadata；在 success/error/timeout/abort 路径结束 trace。
   - Why: root trace 表示一次完整 OpenClaw agent run。
   - Dependencies: Phase 2
   - Risk: Medium

2. **Wrap Pi stream function** (File: `src/agents/pi-embedded-runner/run/attempt.ts`)
   - Action: 在最终 `activeSession.agent.streamFn` 上套 generation tracing wrapper。
   - Why: 每次模型调用对应 Langfuse generation，接近 LangGraph 的 LLM observation。
   - Dependencies: Step 1
   - Risk: High

3. **Propagate trace handle into subscription** (Files: `src/agents/pi-embedded-subscribe.ts`, `src/agents/pi-embedded-subscribe.handlers.types.ts`)
   - Action: 在 `SubscribeEmbeddedPiSessionParams` 与 handler context 中增加可选 `traceRun`。
   - Why: tool handler 能在同一个 root trace 下记录 tool span。
   - Dependencies: Step 1
   - Risk: Medium

4. **Trace tool lifecycle** (File: `src/agents/pi-embedded-subscribe.handlers.tools.ts`)
   - Action: tool start 调用 `traceRun.startTool`，tool end 调用 handle.end。
   - Why: 展示 agent 的工具调用树。
   - Dependencies: Step 3
   - Risk: Medium

5. **Trace subagent spawn tool result** (Files: `src/agents/pi-embedded-subscribe.handlers.tools.ts`, `extensions/diagnostics-langfuse/src/capture.ts`)
   - Action: 对 `sessions_spawn` 的 result 做 safe-mode 特例，保留 `runId`、`childSessionKey`、`mode`、`status`、`agentId/targetAgentId`、`label`。
   - Why: 即使不保存完整 tool payload，也能从父 trace 跳到子 trace。
   - Dependencies: Step 4
   - Risk: Medium

6. **Trace subagent lifecycle hooks** (Files: `src/agents/subagent-spawn.ts`, `src/agents/subagent-registry-completion.ts`)
   - Action: 在 `subagent_spawned`、`subagent_ended` 生命周期同时通知 trace runner。
   - Why: 让 Langfuse 中能看到子 agent 开始、完成、失败、kill、timeout。
   - Dependencies: Phase 2
   - Risk: Medium

7. **Preserve existing hooks** (Files: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-subscribe.handlers.tools.ts`)
   - Action: 保留 `llm_input`、`llm_output`、`agent_end`、`after_tool_call` 行为不变。
   - Why: 避免破坏现有插件和测试。
   - Dependencies: Steps 1 to 6
   - Risk: Medium

### Phase 3.5: Subagent and agent-to-agent correlation

1. **Pass trace parent through subagent spawn** (File: `src/agents/subagent-spawn.ts`)
   - Action: 在 `callGateway({ method: "agent" })` 的 params 中传 `traceParent`，包含父 run/session 和 `sessions_spawn` observation id。
   - Why: 子 agent root trace 能关联回 Feishu 主 agent trace。
   - Dependencies: Phase 2
   - Risk: Medium

2. **Pass trace parent through sessions_send** (Files: `src/agents/tools/sessions-send-tool.ts`, `src/agents/tools/agent-step.ts`)
   - Action: 对 `sessions_send` 和 A2A announce/reply run 传递 `traceParent` 与现有 `inputProvenance`。
   - Why: agent-to-agent run 需要和发起 agent 互查。
   - Dependencies: Phase 2
   - Risk: Medium

3. **Extend gateway agent params** (Files: `src/gateway/protocol/schema/agent.ts`, `src/gateway/server-methods/agent.ts`, `src/agents/pi-embedded-runner/run/params.ts`)
   - Action: 接收并传递 `traceParent` 到 `runEmbeddedPiAgent` / `runEmbeddedAttempt`。
   - Why: 保持 gateway 控制面到 runner 的 trace 关系不断链。
   - Dependencies: Step 1
   - Risk: Medium

4. **Keep metadata-link fallback** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 如果 Langfuse SDK 不支持把子 run 嵌到同一 trace，创建独立 trace，并写入 `parentTraceId/parentRunId/childRunId` 双向 metadata。
   - Why: 第一版必须稳定可查，不依赖特定 SDK 嵌套能力。
   - Dependencies: Steps 1 to 3
   - Risk: Low

5. **Implement same-trace nested subagent observation** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 当 `traceParent.parentTraceId` 和 `traceParent.parentObservationId` 存在且 SDK 支持时，子 run 不创建独立 root trace，而是在父 trace 下创建 `openclaw.subagent.run` observation，并把子 generation/tool observation 挂到其下。
   - Why: 这是最接近 LangGraph trace 树的效果。
   - Dependencies: Steps 1 to 4
   - Risk: High

6. **Gate same-trace mode behind capability detection** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 启动时或首次写入时检测 SDK 是否支持跨异步边界复用 trace/parent observation；不支持时自动使用 P0 metadata link。
   - Why: 保证 P0 稳定，不让 P1 兼容性风险影响主链路。
   - Dependencies: Step 5
   - Risk: Medium

### Phase 4: Langfuse plugin

1. **Create extension package** (Directory: `extensions/diagnostics-langfuse`)
   - Action: 增加 plugin manifest、package、entrypoint。
   - Why: 遵守插件依赖隔离，Langfuse SDK 不进 root dependencies。
   - Dependencies: Phase 2
   - Risk: Low

2. **Implement config parser** (File: `extensions/diagnostics-langfuse/src/config.ts`)
   - Action: 从 `ctx.config.diagnostics.langfuse` 读取配置；enabled 时要求 host/publicKey/secretKey 非空。
   - Why: 明确缺失配置，避免静默无 trace。
   - Dependencies: Phase 1
   - Risk: Low

3. **Implement service lifecycle** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 初始化 Langfuse client，执行 auth check，注册 sink，stop 时 flush/shutdown。
   - Why: 统一管理 SDK 生命周期和错误边界。
   - Dependencies: Steps 1 and 2
   - Risk: Medium

4. **Implement capture policy** (File: `extensions/diagnostics-langfuse/src/capture.ts`)
   - Action: 实现 `safe`、`llm_text`、`full` 三种输入输出转换。
   - Why: 将安全策略集中在插件内，core 只传递事件。
   - Dependencies: Step 3
   - Risk: High

5. **Implement mask** (File: `extensions/diagnostics-langfuse/src/mask.ts`)
   - Action: 脱敏 secret 字段、长文本、media/base64、authorization header。
   - Why: 即使 `full` 模式也避免直接发送明显敏感内容。
   - Dependencies: Step 4
   - Risk: High

6. **Generate trace URL metadata** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 使用 deterministic trace id 关联 `runId`，必要时把 trace URL 写入 debug log。
   - Why: 方便从 OpenClaw 日志跳转 Langfuse。
   - Dependencies: Step 3
   - Risk: Low

7. **Generate subagent link metadata** (File: `extensions/diagnostics-langfuse/src/service.ts`)
   - Action: 对父 trace 写 child trace link，对子 trace 写 parent trace link；`safe` 模式也保留链接字段。
   - Why: Feishu researcher/subagent 调用必须可从任意一端跳转定位。
   - Dependencies: Phase 3.5
   - Risk: Medium

### Phase 5: Workspace configuration plan

1. **Prepare global env values** (File: `~/.openclaw/.env`)
   - Action: 写入 `LANGFUSE__HOST`、`LANGFUSE__PUBLIC_KEY`、`LANGFUSE__SECRET_KEY`。
   - Why: 当前方案规定只从全局 env 取 Langfuse 凭据。
   - Dependencies: Langfuse self-hosted project keys
   - Risk: Low

2. **Enable plugins in runtime config** (File: `../openclaw-workspace/openclaw.json`)
   - Action: 增加 `diagnostics-langfuse` 到 `plugins.allow` 与 `plugins.entries`，增加 `diagnostics.langfuse`。
   - Why: 让当前 OpenClaw runtime 启用原生 Langfuse trace。
   - Dependencies: Phases 1 to 4
   - Risk: Medium

3. **Keep OTel collector config separate** (File: `../openclaw-workspace/openclaw.json`)
   - Action: 如需系统观测，继续保留 `diagnostics.otel.endpoint: "http://localhost:4318"`。
   - Why: Langfuse host 是 `http://localhost:3005`，OTel collector 是 `http://localhost:4318`。
   - Dependencies: Existing `diagnostics-otel`
   - Risk: Low

## Testing Strategy

- Unit tests:
  - `src/config/zod-schema.test.ts` 或现有 config schema 测试覆盖 `diagnostics.langfuse`。
  - `src/plugins/registry.agent-trace-sink.test.ts` 覆盖 trace sink 注册。
  - `extensions/diagnostics-langfuse/src/capture.test.ts` 覆盖三种 `captureMode`。
  - `extensions/diagnostics-langfuse/src/mask.test.ts` 覆盖 secret、长文本、media/base64。
  - `extensions/diagnostics-langfuse/src/service.test.ts` 覆盖 enabled/disabled、缺失配置、flush/shutdown。

- Integration tests:
  - `src/agents/pi-embedded-runner/run/attempt.langfuse-trace.test.ts` 覆盖普通回复生成 root trace + generation。
  - `src/agents/pi-embedded-subscribe.handlers.tools.langfuse-trace.test.ts` 覆盖 tool start/end span。
  - tool error case 覆盖 error 摘要和 root trace 正常结束。
  - `src/agents/openclaw-tools.subagents.sessions-spawn.langfuse-trace.test.ts` 覆盖 Feishu 主 agent 调
    `sessions_spawn` 后，父 tool span 保留 `childRunId/childSessionKey`，子 root trace 保留
    `parentRunId/requesterSessionKey`。
  - `src/agents/tools/sessions-send-tool.langfuse-trace.test.ts` 覆盖 `inputProvenance` 与 `traceParent`
    传入嵌套 run。

- Regression tests:
  - 现有 `wired-hooks-llm`、`wired-hooks-after-tool-call` 测试不变。
  - 现有 `diagnostics-otel` service 测试不变。
  - `pnpm test:fast`。
  - `vitest run --config vitest.extensions.config.ts extensions/diagnostics-langfuse`。

- Manual verification:
  - 启动 `../deploy-addons` 的 Langfuse，确认 `http://localhost:3005` 可访问。
  - 在 `~/.openclaw/.env` 写入 Langfuse keys。
  - 启动 OpenClaw gateway，发送一次普通消息和一次触发工具的消息。
  - 在 Langfuse UI 中确认 trace 层级为 run -> generation/tool。
  - 在 safe 模式检查没有完整 prompt、tool params、tool result。

## Risks & Mitigations

- **Risk**: generation wrapper 破坏 Pi stream semantics。
  - Mitigation: wrapper 必须保留原 stream 对象行为和 `.result()` 语义；增加流式与非流式测试。

- **Risk**: safe 模式泄露 tool payload。
  - Mitigation: capture policy 单独测试，默认不发送 params/result 原文，mask fail closed。

- **Risk**: Langfuse SDK 异常影响 agent run。
  - Mitigation: trace runner 捕获并隔离 sink 异常；agent runtime 只记录 warning。

- **Risk**: 用户混淆 Langfuse host 和 OTel collector endpoint。
  - Mitigation: 文档明确 `LANGFUSE__HOST=http://localhost:3005`，`diagnostics.otel.endpoint=http://localhost:4318`。

- **Risk**: `full` 模式存储量过大。
  - Mitigation: 长文本截断，media/base64 摘要化，文档标注只用于显式排障。

- **Risk**: auth check 对 self-hosted Langfuse 版本兼容性不稳定。
  - Mitigation: 优先 SDK auth check，失败时用 `/api/public/projects` basic auth fallback。

- **Risk**: 子 agent run 被记录成孤立 trace，Feishu 主任务无法串到 researcher trace。
  - Mitigation: 第一版强制写入 `traceParent` 与双向 metadata link；同 trace 嵌套作为后续增强。

- **Risk**: 父 agent 的 `sessions_spawn` tool span 已结束，子 agent 后台异步运行时无法挂到同一个 parent observation。
  - Mitigation: P1 先做 SDK capability detection；不支持跨异步追加时使用同 trace id + metadata link，或退化为独立 trace link。

- **Risk**: `safe` 模式把 `sessions_spawn` result 全部摘要化，丢失 child run 定位字段。
  - Mitigation: 对 `sessions_spawn` result 设置 allowlist，保留 `runId/childSessionKey/status/mode/label/targetAgentId`。

## Success Criteria

- [x] `diagnostics-langfuse` 插件可以被 plugin loader 发现并启用。
- [x] 缺失 `LANGFUSE__HOST`、`LANGFUSE__PUBLIC_KEY`、`LANGFUSE__SECRET_KEY` 时启动失败。
- [x] 普通 agent 回复在 Langfuse 中生成 root trace 和 generation。
- [x] 工具调用在同一 root trace 下生成 tool span。
- [x] Feishu 主 agent 调 `sessions_spawn` 后，父子 run 通过 `traceParent` 进入同一 trace seed，并保留 metadata link。
- [x] researcher/subagent root trace 能看到 `lane= subagent`、`spawnedBy` 或 `parentRunId`。
- [x] `sessions_send` 触发的 agent-to-agent run 能记录 `inputProvenance` 和父子 trace metadata。
- [x] P0：SDK 不支持同 trace 嵌套时，父子 run 通过 metadata link 可互查。
- [ ] P1：SDK 支持同 trace 嵌套时，子 agent run 作为 `openclaw.subagent.run` 挂到父 trace 下。
- [x] `safe` 模式不包含完整 prompt、tool params、tool result。
- [x] `safe` 模式仍保留 `sessions_spawn` 的 child run 定位字段。
- [x] `llm_text` 模式包含 prompt 和 assistant output，但不包含完整 tool payload。
- [x] `full` 模式发送完整 payload 前经过统一 mask。
- [x] `diagnostics-otel` 仍可独立向 OTel collector/SigNoz 导出。
- [x] Langfuse 写入失败不会中断 agent run。
- [x] 相关 unit、extension、typecheck 通过。
