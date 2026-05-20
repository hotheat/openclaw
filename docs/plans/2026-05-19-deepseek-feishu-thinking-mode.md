# Implementation Plan: DeepSeek Feishu Thinking Mode

## Overview

在 Feishu channel 中复用现有 `/think <level>` 指令链路，不新增 Feishu 私有命令解析。
新增 DeepSeek provider 级请求参数映射，让 Feishu 用户可以通过 `/think off|medium|high|xhigh`
切换 DeepSeek API 思考模式。

DeepSeek 官方参考：

- https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- https://api-docs.deepseek.com/zh-cn/quick_start/pricing

## Requirements

- Feishu 私聊和群聊中，已授权用户可发送 `/think <level>` 或 `/think:<level>`。
- 只要求支持 `medium`、`high`、`xhigh`，同时保留现有 `off` 用于关闭。
- `/think` 状态继续写入当前会话的 `sessionEntry.thinkingLevel`。
- DeepSeek OpenAI-compatible 请求按官方参数切换思考模式。
- 不改变其他 provider 的 `/think` 行为。

## Current State

- Feishu 入站链路在 `extensions/feishu/src/bot.ts` 中构造 `CommandBody: ctx.content`，
  再调用通用 `dispatchReplyFromConfig`。因此 `/think` 已经会进入通用 directive pipeline。
- 通用 directive pipeline 已支持 `/think`、`/think:<level>`、`/thinking`、`/t`，并持久化
  `thinkingLevel`。
- 当前缺口在 DeepSeek provider 请求参数映射：现有 OpenAI-compatible 默认只会写
  `reasoning_effort`，DeepSeek 还需要 `thinking: { type: "enabled" | "disabled" }`。

## Architecture Changes

### DeepSeek provider

在 `src/agents/models-config.providers.ts` 增加一等 DeepSeek provider：

- provider id: `deepseek`
- baseUrl: `https://api.deepseek.com`
- api: `openai-completions`
- api key: `DEEPSEEK_API_KEY` 或 auth profile `deepseek`
- models:
  - `deepseek-v4-flash`
  - `deepseek-v4-pro`
- model metadata:
  - `reasoning: true`
  - `input: ["text"]`
  - `contextWindow: 1000000`
  - `maxTokens: 384000`
  - `cost` 暂设为 0，避免把 DeepSeek 文档中的人民币价格误记为 USD。

### Thinking level mapping

在 `src/agents/pi-embedded-runner/extra-params.ts` 新增 DeepSeek stream wrapper。
识别条件：

- `provider === "deepseek"`，或
- runtime model `baseUrl` 包含 `api.deepseek.com`

映射规则：

| OpenClaw level                        | DeepSeek payload                                            |
| ------------------------------------- | ----------------------------------------------------------- |
| `off`                                 | `thinking: { type: "disabled" }`                            |
| `minimal` / `low` / `medium` / `high` | `thinking: { type: "enabled" }`, `reasoning_effort: "high"` |
| `xhigh`                               | `thinking: { type: "enabled" }`, `reasoning_effort: "max"`  |

实现要点：

- 在 `applyExtraParamsToAgent` 中，在通用 extra params wrapper 之后套 DeepSeek wrapper。
- `/think` 的 runtime level 优先于 `agents.defaults.models[...].params` 中已有的
  `thinking` 或 `reasoning_effort`。
- 若没有 runtime `thinkingLevel`，不额外注入 DeepSeek 参数，保持当前配置行为。

### `/think` level list

在 `src/auto-reply/thinking.ts` 中让 DeepSeek 支持 `xhigh`：

- `listThinkingLevels("deepseek", "deepseek-v4-pro")` 包含 `xhigh`。
- 非 DeepSeek provider 不受影响。

## Feishu Reasoning Behavior

默认不向 Feishu channel 发送 reasoning 内容。只有用户发送 `/reasoning on`，或配置
`agents.defaults.reasoningDefault: "on"` / `agents.list[].reasoningDefault: "on"` 后，reasoning
内容才会发送到 Feishu channel。

链路：

1. Feishu 收到消息后调用 `dispatchReplyFromConfig`。
2. `dispatchReplyFromConfig` 注入 `onBlockReply`。
3. `subscribeEmbeddedPiSession` 在 `reasoningMode === "on"` 时设置 `includeReasoning`。
4. 模型返回 thinking block 后，`formatReasoningMessage` 格式化为 `Reasoning:\n...`。
5. `onBlockReply({ text: formattedReasoning })` 触发。
6. Feishu reply dispatcher 把该 `ReplyPayload` 当普通 block reply 发到 Feishu。

边界：

- `/reasoning on`：会作为单独消息或 block reply 发到 Feishu。
- `/reasoning off`：不会发送 reasoning 内容。
- `reasoningDefault`：可在 `openclaw.json` 中设置默认 reasoning 可见性；未配置时默认等价于
  `/reasoning off`。
- `/reasoning stream`：需要 channel 提供 `onReasoningStream` 专用回调；Feishu 当前没有专用
  reasoning lane，因此不应承诺实时 reasoning 流式展示。

## GPT-5.4 And Cross-Provider Compatibility

OpenAI 官方模型页显示 `gpt-5.4` 支持 `none`、`low`、`medium`、`high`、`xhigh`
reasoning levels。Responses API 中，GPT-5 和 o 系列 reasoning models 使用
`reasoning: { effort: "<level>" }` 配置思考强度。

当前项目内的兼容状态：

- `gpt-5.4` 不需要 DeepSeek 的 `thinking: { type: ... }` 字段。
- 对 `api: "openai-responses"` 且 `model.reasoning === true` 的模型，底层会把
  runtime thinking level 透传为 `reasoning.effort`。
- 对 OpenAI-compatible Chat Completions 模型，如果 `model.reasoning === true` 且
  `compat.supportsReasoningEffort === true`，底层会写入 `reasoning_effort`。
- 当前 `/think xhigh` 入口仍受 `src/auto-reply/thinking.ts` 中 `XHIGH_MODEL_REFS`
  静态 allowlist 限制；该列表目前没有 `openai/gpt-5.4`，因此需要补充能力判断或更新
  allowlist，才能让 Feishu 中的 `/think xhigh` 对 `gpt-5.4` 生效。

建议把 `/think` 能力判断收敛为 provider/model capability 层，避免每个 provider 各自维护
不一致的静态规则：

| Provider family                    | Payload mapping                      | Compatibility rule                                                      |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| OpenAI Responses                   | `reasoning.effort`                   | `model.reasoning === true`；`xhigh` 按模型能力放开                      |
| OpenAI-compatible Chat Completions | `reasoning_effort`                   | `model.reasoning === true` 且 `compat.supportsReasoningEffort === true` |
| DeepSeek                           | `thinking.type` + `reasoning_effort` | 需要 provider/baseUrl 专用 wrapper                                      |
| Z.AI                               | `thinking.type`                      | 当前是二值开关，非 `off` 视为开启                                       |
| Qwen                               | `enable_thinking`                    | 取决于模型和 provider compat                                            |
| OpenRouter                         | `reasoning.effort` wrapper           | 取决于目标模型能力                                                      |

边界：

- 不能假设所有模型都兼容 `reasoning_effort`。
- 未知模型应安全降级为不展示 `xhigh`，或在发送请求前给出不支持提示。
- `medium`、`high` 可作为 reasoning models 的通用优先支持级别；`xhigh` 必须按模型能力显式确认。

## Implementation Steps

### Phase 1: Provider registration

1. 在 `src/agents/models-config.providers.ts` 增加 DeepSeek 常量和 `buildDeepseekProvider()`。
2. 在 `resolveImplicitProviders()` 中读取 `DEEPSEEK_API_KEY` 或 auth profile `deepseek` 后注册 provider。
3. 增加 provider 注册测试，覆盖 env key 和模型列表。

### Phase 2: Request payload mapping

1. 在 `src/agents/pi-embedded-runner/extra-params.ts` 增加：
   - `isDeepseekProviderOrBaseUrl(...)`
   - `mapDeepseekThinkingPayload(...)`
   - `createDeepseekThinkingWrapper(...)`
2. 在 `applyExtraParamsToAgent(...)` 中按 provider/model baseUrl 套 wrapper。
3. 增加 payload 测试，断言 `thinking` 与 `reasoning_effort` 注入结果。

### Phase 3: Directive capability

1. 在 `src/auto-reply/thinking.ts` 增加 DeepSeek xhigh 支持判断。
2. 增加 `listThinkingLevels` 测试，确认 DeepSeek 包含 `xhigh`。
3. 保持 `normalizeThinkLevel` 不变，继续让 `on` 映射到 `low`。

### Phase 3.5: Reasoning visibility defaults

1. 在 `agents.defaults` 和 `agents.list[]` 中新增 `reasoningDefault: "off" | "on" | "stream"`。
2. 解析顺序为 `/reasoning` 指令、session `reasoningLevel`、agent `reasoningDefault`、global
   `reasoningDefault`、`off`。
3. 默认不再因为模型 `reasoning: true` 自动展示 reasoning；模型能力只表示能否思考，展示行为由
   `/reasoning` 或配置显式控制。

### Phase 4: Feishu coverage

1. 增加 Feishu bot 测试，验证 `/think xhigh` 的 `CommandBody` 原样进入通用 dispatch。
2. 增加或复用 directive-only 测试，确认 `/think high` 会产生 ack 并更新 session。
3. 不在 Feishu channel 内新增 `/think` 专用分支。

## Testing Strategy

- Unit:
  - DeepSeek provider 自动注册。
  - DeepSeek thinking payload mapping。
  - `xhigh` level list。
- Integration:
  - Feishu DM 输入 `/think high`，进入通用 directive pipeline。
  - Feishu 群聊沿用现有 mention 和 allowlist 策略。
- Regression:
  - OpenRouter `reasoning.effort` 注入不变。
  - Z.AI `thinking.type` 注入不变。
  - 非 DeepSeek OpenAI-compatible provider 不新增 DeepSeek `thinking` 字段。

## Risks & Mitigations

- Risk: DeepSeek API 参数被错误放入 SDK options 而不是 HTTP payload。
  - Mitigation: 使用 `onPayload` wrapper 直接修改最终 payload，并用单元测试捕获。
- Risk: `xhigh` 在非 DeepSeek provider 被误放开。
  - Mitigation: 只在 DeepSeek provider 或已列入 xhigh allowlist 的模型中返回 `xhigh`。
- Risk: `/reasoning on` 把内部 reasoning 发到 Feishu 造成信息暴露。
  - Mitigation: 保持默认 `off`，支持 `reasoningDefault: "off"` 配置，文档明确 `/reasoning on` 会发送 reasoning 内容。

## Success Criteria

- Feishu 中发送 `/think high` 后，DeepSeek 请求包含 `thinking.enabled` 和 `reasoning_effort=high`。
- Feishu 中发送 `/think xhigh` 后，DeepSeek 请求包含 `thinking.enabled` 和 `reasoning_effort=max`。
- Feishu 中发送 `/think off` 后，DeepSeek 请求包含 `thinking.disabled`。
- `/reasoning on` 当前行为被明确记录：reasoning 内容会发送到 Feishu。
- 相关单元测试和 Feishu 回归测试通过。
