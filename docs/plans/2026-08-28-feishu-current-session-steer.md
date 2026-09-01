# Implementation Plan: Feishu 当前会话 `/steer` 引导

## Overview

将 `/steer <message>` 从子 Agent 简写命令调整为当前会话运行引导命令，使 Feishu 用户可以像 WebChat 一样，把补充指令注入正在执行的主 Agent。实现放在通用自动回复命令层，复用运行器 steer API，Feishu 渠道只继续负责标准消息上下文构造。

子 Agent 引导收敛到唯一标准入口 `/subagents steer <id|#> <message>`。`/tell` alias 一并删除，不保留旧子 Agent 简写的兼容路径（评审已确认无需考虑该兼容场景）。

## Requirements

- Feishu 中支持 `/steer <message>`，消息目标固定为当前 Feishu 会话正在运行的主 Agent。
- 成功引导时，把完整消息注入当前活动运行，不中止运行，不创建新的 Agent turn。
- run 处于启动排队（pending）状态且该会话恰好只有一个 pending run 时，消息缓冲进 pending run，注册时注入，命令立即返回，不做任何轮询等待。
- run 活动期间发送的 `/steer` 必须被即时处理，不得进入 collect 队列等 run 结束后才消费。
- 当前运行不存在、尚未进入可引导状态、正在 compacting 时，返回明确结果。
- 成功回复文案区分两种注入方式：立即注入（"已注入当前运行"）与 pending 缓冲（"已排队，将在运行启动时注入"），后者投递保证更弱，文案不许诺同等强度。
- 保持命令授权检查，未授权发送者不能引导会话。
- `/subagents steer <id|#> <message>` 行为保持不变。
- 命令解析必须保留中文、大小写、标点和多词消息，不把消息首词解释为子 Agent ID。
- 不修改 `steerEmbeddedPiRun()` 无 runId 调用的默认语义；现有调用方在 pending-only 会话下继续得到 `run_inactive`。
- 不修改 Feishu 路由、会话键生成、全局 `messages.queue` 默认值。
- 不调用 `make test`。验证使用聚焦测试和 `make lint`。

## Assumptions And Constraints

- `/steer` 是全局命令注册表中的命令。为保持各渠道语义一致，新语义应用于所有启用文本命令的渠道，Feishu 是本次需求的首要使用场景。
- Feishu 已把 `route.sessionKey` 写入 `MsgContext.SessionKey`（`extensions/feishu/src/bot.ts:977`），通用命令处理器可通过 `params.sessionEntry.sessionId` 精确定位当前会话。
- **命令处理先于队列拦截（本功能成立的隐含前提）**：命令经 `handleInlineActions()` 在 `getReply()` 早期执行（`src/auto-reply/reply/get-reply.ts:386`），队列判定发生在其后的 run 派发阶段（`src/auto-reply/reply/get-reply-run.ts:413`）。因此 run 活动期间入站的 `/steer` 会被即时处理，不会先入 collect 队列。此顺序必须由 Phase 3 的集成断言固化，防止队列管线将来重构时静默破坏本功能。
- **pending 窗口覆盖整个 lane 排队期**：`registerPendingEmbeddedRun()` 在 `runEmbeddedPiAgent()` 顶部调用（`src/agents/pi-embedded-runner/run.ts:497`），先于任务进入 session lane / global lane 排队。全局 lane 拥挤时窗口为秒级甚至更长。"用户发完任务、几秒内追一条 `/steer` 补充约束"是聊天场景的日常路径，不是边缘竞态，因此 pending 缓冲进入 v1。
- 每个 session 在嵌入式运行器中最多有一个可接受引导的活动 run。Feishu 不持有 WebChat 的 `runId`，因此按 `sessionId` 调用运行器 steer API。
- 显式 `/steer` 只负责引导当前运行（含 pending 缓冲）。运行不存在时不降级为 followup，避免用户以为消息已经改变正在执行的任务。
- 现有企业级步骤注释和日志规范仅用于复杂新逻辑。简单解析函数保持项目现有风格，关键状态转换增加结构化日志。

## Architecture Review

当前链路：

```text
Feishu event
  -> extensions/feishu/src/bot.ts 构造 MsgContext
  -> src/auto-reply/reply/get-reply-inline-actions.ts
  -> src/auto-reply/reply/commands-core.ts
  -> src/auto-reply/reply/commands-subagents.ts
  -> /steer 被解释为子 Agent steer
```

WebChat 引导链路：

```text
chat.steer
  -> src/gateway/server-methods/chat.ts
  -> steerEmbeddedPiRunById(sessionId, runId, message)
  -> active run queueMessage(message)（或 pending token 缓冲，注册时重放）
```

目标链路：

```text
Feishu /steer <message>
  -> 通用 handleSteerCommand
  -> params.sessionEntry.sessionId
  -> steerEmbeddedPiRunAllowPending(sessionId, message)   # 新增 opt-in 入口
  -> active run queueMessage(message)
     或（恰好一个 pending token 时）pendingToken.steerMessages 缓冲，注册时重放
```

关键判断：

- 不在 `extensions/feishu` 中拦截或改写 `/steer`。渠道层缺少运行状态职责，放在那里会产生渠道特例。
- 不通过 Gateway RPC 调用 `chat.steer`。Feishu 没有可靠的客户端 `runId`，同进程命令处理器可以直接复用运行器 API。
- 不复用 `messages.queue.mode = "steer"`。该配置会影响运行期间的所有普通消息，无法表达一次性的显式命令。
- **不做命令层短轮询处理启动竞态**。原方案的轮询判定依赖"存在 pending 注册中的 run"这一信号，而 `isEmbeddedPiRunActive()` 只返回 boolean（`src/agents/pi-embedded-runner/runs.ts:171`），无法区分 pending 注册中与根本没有 run；WebChat 的重试依赖 gateway 侧 `chatAbortControllers` 状态（`src/gateway/server-methods/chat.ts:539`），命令处理层没有等价物。轮询还会阻塞 Feishu 命令回复数秒。改为复用运行器已有的 pending 缓冲机制（见下）。
- **不修改 `steerEmbeddedPiRun()` 无 runId 调用的默认语义（合同面约束）**。现有 pending 缓冲只在传入 `expectedRunId` 时生效（`src/agents/pi-embedded-runner/runs.ts:124-131`）。若把无 runId 路径也改为 pending-only 即 accepted，会静默改变两个关键调用方的 fallback 行为：`src/agents/subagent-announce.ts:1058,1125`（子 Agent 完成播报依赖 `unsteerable` 触发重试/直投链路）和 `src/auto-reply/reply/agent-runner.ts:231`（followup 派发依赖 steer 失败后独立成 turn）。因此 pending 缓冲能力通过新增 opt-in 函数暴露，仅 `/steer` 命令处理器使用。
- `/steer` 与子 Agent 简写存在语义冲突。采用干净切换：当前会话使用 `/steer`，子 Agent 使用 `/subagents steer`；`/tell` alias 删除，不保留兼容入口。

## Architecture Changes

- `src/auto-reply/reply/commands-steer.ts`
  - 新增当前会话 steer 命令处理器。
  - 负责精确命令匹配、参数提取、授权检查、sessionId 校验和结果映射（含 steered/queued 两种成功文案）。
- `src/auto-reply/reply/commands-core.ts`
  - 在 `handleSubagentsCommand` 之前注册 `handleSteerCommand`。
- `src/auto-reply/reply/commands-subagents/shared.ts`
  - 从子 Agent 简写前缀中移除 `/steer` 和 `/tell`。
  - 保留 `/subagents steer` action 作为子 Agent 唯一标准入口。
  - 更新帮助文本，删除 `/steer <id|#> <message>` 和 `/tell <id|#> <message>` 条目。
- `src/auto-reply/commands-registry.data.ts`
  - 将 `steer` 参数改为单个 `message`（`captureRemaining`），描述改为当前会话引导。
  - 删除 `registerAlias(commands, "steer", "/tell")`（`src/auto-reply/commands-registry.data.ts:698`）。
  - 不为 `/tell` 建立任何独立命令定义。
- `src/agents/pi-embedded-runner/runs.ts`
  - 新增 opt-in 函数 `steerEmbeddedPiRunAllowPending(sessionId, text)`（命名实现时可调整）：
    - 存在 active handle 时，行为与 `steerEmbeddedPiRun()` 完全一致，成功返回 `{ status: "accepted", mode: "steered" }`。
    - 无 active handle 且该 session **恰好只有一个** pending token 时，把消息 push 进 `pendingToken.steerMessages`（注册时经 `setActiveEmbeddedRun()` 重放，`src/agents/pi-embedded-runner/runs.ts:271`），返回 `{ status: "accepted", mode: "queued" }`。
    - 无 pending 或存在多个 pending token（目标有歧义）时，返回 `run_inactive`。
  - 不修改 `steerEmbeddedPiRunHandle()` 的默认分支，不改变既有 queue mode 行为。
  - 已知弱化（与 WebChat byId 路径现状对齐，v1 接受，不加确认回执机制）：注册时重放失败仅 `diag.warn`（`src/agents/pi-embedded-runner/runs.ts:272-276`）；pending token 被 `cancelPendingEmbeddedRuns()` 整体取消时缓冲消息随之丢弃。这是 queued 文案措辞更弱的原因。
- `src/auto-reply/reply/commands-steer.test.ts`
  - 新增聚焦单元测试，覆盖当前会话 steer 的完整状态矩阵。
- `src/auto-reply/reply/commands.test.ts`
  - 将原 `/steer <id> <message>` 子 Agent 回归用例迁移到 `/subagents steer`。
- `src/auto-reply/reply.triggers.trigger-handling.steers-before-collect.test.ts`
  - 在 `getReplyFromConfig()` 层增加 run 活动期间 `/steer` 即时处理、不入 collect 队列的集成断言。
- `docs/tools/slash-commands.md`
  - 记录新的 `/steer <message>` 语义，移除 `/tell`。
- `docs/tools/subagents.md`
  - 明确 `/subagents steer` 是子 Agent 的唯一入口。

## Implementation Steps

### Phase 1: 固化命令契约

1. **定义当前会话 steer 的解析规则** (File: `src/auto-reply/reply/commands-steer.ts`)
   - Action:
     - 只匹配 `/steer` 或 `/steer` 后跟空白的边界，避免 `/steering`、`/steerx` 被误识别。
     - 命令匹配继续使用 `command.commandBodyNormalized`。
     - payload 从 `ctx.CommandBody ?? ctx.RawBody ?? ctx.Body` 中移除命令 token，保留换行和后续完整原文。
     - 空消息返回 `Usage: /steer <message>`。
   - Why:
     - 当前 `resolveHandledPrefix()` 使用 `startsWith()`，同时把首个 token 当作子 Agent 目标，无法支持自然语言引导。
   - Dependencies: None.
   - Complexity: Low.
   - Risk: Low. 评审确认无需考虑旧 `/steer <id> <message>` 用户的兼容场景。

2. **调整命令注册表** (File: `src/auto-reply/commands-registry.data.ts`)
   - Action:
     - 将 `steer` 定义改为 `message` 单参数，启用 `captureRemaining`。
     - 删除 `registerAlias(commands, "steer", "/tell")`。
     - 不新增 `tell` 命令定义。
   - Why:
     - Native/text command 元数据必须与实际解析语义一致；`/tell` 兼容路径已确认不需要。
   - Dependencies: Requires step 1 contract.
   - Complexity: Low.
   - Risk: Low.

3. **从子 Agent handler 移除 `/steer` 与 `/tell` 简写** (Files: `src/auto-reply/reply/commands-subagents/shared.ts`, `src/auto-reply/reply/commands-subagents.ts`)
   - Action:
     - 删除 `COMMAND_STEER`、`COMMAND_TELL` 及对应 `resolveHandledPrefix()` 分支。
     - 保留 `/subagents steer` action。
     - 更新 `buildSubagentsHelp()`，删除 `/steer <id|#> <message>` 和 `/tell <id|#> <message>` 条目。
   - Why:
     - 防止新 `handleSteerCommand` 与子 Agent handler 同时声明 `/steer`；子 Agent 引导收敛到单一标准入口。
   - Dependencies: Requires step 2.
   - Complexity: Low.
   - Risk: Low.

### Phase 2: 实现当前会话引导

4. **实现授权和会话状态校验** (File: `src/auto-reply/reply/commands-steer.ts`)
   - Action:
     - 与其他管理命令一致，要求 `allowTextCommands` 和 `command.isAuthorizedSender`。
     - 未授权时停止处理并写 verbose 日志，不暴露会话状态。
     - 缺少 `params.sessionEntry?.sessionId` 时返回当前会话不可引导。
     - 不接受用户传入 sessionId、runId 或其他目标，目标始终绑定当前 session。
   - Why:
     - 防止跨会话 steer，并保持渠道 allowlist 和 owner 策略有效。
   - Dependencies: Requires step 1.
   - Complexity: Low.
   - Risk: Low.

5. **runner 侧新增 opt-in 的 allow-pending steer 入口** (File: `src/agents/pi-embedded-runner/runs.ts`)
   - Action:
     - 新增 `steerEmbeddedPiRunAllowPending(sessionId, text)`，按 Architecture Changes 中的三分支实现（active 注入 / 单 pending 缓冲 / 其余 `run_inactive`）。
     - 返回值区分 `mode: "steered" | "queued"`，供命令层选择文案。
     - 不修改 `steerEmbeddedPiRunHandle()` 默认分支；`steerEmbeddedPiRun()`、`queueEmbeddedPiMessage()` 行为零变化。
   - Why:
     - pending 窗口覆盖整个 lane 排队期（`run.ts:497`），"发完任务立刻补充"是日常路径；缓冲复用 WebChat byId 已有的 `steerMessages` 重放机制，命令层零等待、无轮询。
     - opt-in 入口保护 `subagent-announce.ts:1058,1125` 与 `agent-runner.ts:231` 依赖的 `unsteerable`/`false` fallback 合同。
   - Dependencies: None（可与 step 4 并行）.
   - Complexity: Low. 约 20 行加复用现有结构。
   - Risk: Medium. 合同面风险由"新增函数而非改默认语义"加 step 10 的合同断言共同覆盖。

6. **注入活动运行并映射结果** (File: `src/auto-reply/reply/commands-steer.ts`)
   - Action:
     - 调用 `steerEmbeddedPiRunAllowPending(sessionId, message)`。
     - `accepted` + `mode: "steered"` 返回"已注入当前运行"类确认。
     - `accepted` + `mode: "queued"` 返回"已排队，将在运行启动时注入"类确认，不许诺与立即注入同等的投递强度。
     - `run_inactive` 返回当前没有可引导运行，附一句引导（如"直接发送消息即可开始新回合"）。
     - `not_streaming` 返回当前运行暂时不能接收引导。
     - `compacting` 返回当前会话正在 compacting。
     - 记录 sessionId、channel、result reason、mode，不记录完整用户消息。
   - Why:
     - active 路径与 WebChat `chat.steer` 共用 `steerEmbeddedPiRunHandle()`，获得相同的工具边界注入行为；结果以运行器返回值为准，状态在检查与注入之间变化时不会误报。
   - Dependencies: Requires steps 4-5.
   - Complexity: Medium.
   - Risk: Low.

7. **接入通用命令分发** (File: `src/auto-reply/reply/commands-core.ts`)
   - Action:
     - 导入 `handleSteerCommand`。
     - 放在 `handleSubagentsCommand` 前执行。
   - Why:
     - `/steer` 必须先由当前会话 handler 消费，`/subagents steer` 继续进入子 Agent handler。
   - Dependencies: Requires steps 3-6.
   - Complexity: Low.
   - Risk: Low.

### Phase 3: 测试和兼容性

8. **增加当前会话 steer 聚焦测试** (File: `src/auto-reply/reply/commands-steer.test.ts`)
   - Action:
     - mock `steerEmbeddedPiRunAllowPending()`。
     - 覆盖：
       - Feishu provider 下 `/steer 中文引导内容` 成功。
       - 多词、大小写、标点原样传递。
       - 多行引导完整传递。
       - 空消息返回 usage。
       - 未授权发送者不调用运行器。
       - session entry 或 sessionId 缺失。
       - `run_inactive`、`not_streaming`、`compacting`。
       - `mode: "steered"` 与 `mode: "queued"` 的确认文案区分。
       - `/steering` 和 `/steerx` 不匹配。
   - Why:
     - 将命令解析、权限和状态映射与大型 `commands.test.ts` 解耦。
   - Dependencies: Requires steps 4-7.
   - Complexity: Medium.
   - Risk: Low.

9. **更新子 Agent 命令回归测试并固化处理顺序** (Files: `src/auto-reply/reply/commands.test.ts`, `src/auto-reply/reply.triggers.trigger-handling.steers-before-collect.test.ts`)
   - Action:
     - 删除 `/steer` alias 和 `/tell` 相关的子 Agent 用例，保留并确认 `/subagents steer` 对应测试（abort、wait、replacement dispatch、announce restoration 行为不变）。
     - 在 `getReplyFromConfig()` 层构造活动 run 和 collect 模式，发送 `/steer <message>`。
     - **断言当前 run 收到完整 steer payload、followup queue 深度保持为 0，且普通 agent runner 未启动。**
   - Why:
     - 明确迁移后的命令边界；命令先于队列拦截是本功能成立的隐含前提，必须由测试固化，防止队列管线重构时静默破坏。
   - Dependencies: Requires steps 2-7.
   - Complexity: Medium.
   - Risk: Low.

10. **runner 层测试：allow-pending 行为与既有合同** (File: `src/agents/pi-embedded-runner/runs.steer.test.ts`)
    - Action:
      - 保留并运行现有 active、not streaming、compacting、runId mismatch、pending-by-runId 测试。
      - 新增 `steerEmbeddedPiRunAllowPending` 用例：
        - 恰好一个 pending token 时缓冲成功，`setActiveEmbeddedRun()` 注册后消息被重放注入。
        - 多个 pending token 时返回 `run_inactive`。
        - active handle 存在时行为与 `steerEmbeddedPiRun()` 一致。
      - **新增合同断言：无 runId 的 `steerEmbeddedPiRun()` 在 pending-only 会话下仍返回 `run_inactive`。**
    - Why:
      - 最后一条是防回归的合同断言，与 `subagent-announce` 播报 fallback 和 `agent-runner` followup 派发的行为绑定；任何人将来想"顺手"把默认路径也改成 pending 缓冲时会先撞上这条测试。
    - Dependencies: Requires step 5.
    - Complexity: Medium.
    - Risk: Low.

### Phase 4: 文档和验证

11. **更新命令文档** (Files: `docs/tools/slash-commands.md`, `docs/tools/subagents.md`)
    - Action:
      - 将 `/steer` 说明改为"引导当前会话正在运行的 Agent"，说明运行启动排队期间会缓冲注入。
      - 标明没有活动或排队中运行时命令返回失败，不自动创建新 turn。
      - 将 `/subagents steer` 标为子 Agent 唯一入口，移除 `/tell` 相关内容。
    - Why:
      - 这是行为变更，用户必须能区分当前会话和子 Agent 两类目标。
    - Dependencies: Requires final command contract.
    - Complexity: Low.
    - Risk: Low.

12. **执行聚焦验证** (Files: all touched files)
    - Action:
      - 运行命令相关测试：

        ```bash
        pnpm exec vitest run \
          src/auto-reply/reply/commands-steer.test.ts \
          src/auto-reply/reply/commands.test.ts \
          src/auto-reply/reply.triggers.trigger-handling.steers-before-collect.test.ts \
          src/agents/pi-embedded-runner/runs.steer.test.ts
        ```

      - 运行 `make lint`。
      - 检查 formatter 产生的无关修改，只保留本任务相关差异。
      - 不运行 `make test`。
      - 未获得 owner 部署批准时，不运行 `make build`，不重启 gateway。

    - Why:
      - 聚焦验证覆盖命令契约、底层 steer 和处理顺序前提，同时遵守仓库工作流。
    - Dependencies: Requires steps 1-11.
    - Complexity: Medium.
    - Risk: Low.

## Testing Strategy

### Unit Tests

- `src/auto-reply/reply/commands-steer.test.ts`
  - 命令边界。
  - 权限。
  - sessionId 解析。
  - 完整消息传递。
  - 运行状态结果映射（含 steered/queued 文案区分）。
- `src/agents/pi-embedded-runner/runs.steer.test.ts`
  - active handle 注入。
  - streaming 和 compacting 状态。
  - allow-pending：单 pending 缓冲与重放、多 pending 拒绝。
  - 合同断言：默认无 runId API 在 pending-only 下返回 `run_inactive`。

### Integration Tests

- `src/auto-reply/reply/commands.test.ts`
  - `/subagents steer` 保持原行为。
  - 未授权命令被阻止。
- `src/auto-reply/reply.triggers.trigger-handling.steers-before-collect.test.ts`
  - `getReplyFromConfig()` 在 Feishu command context 下路由 `/steer`。
  - run 活动期间 `/steer` 即时处理、不入 collect 队列。

### Manual Verification

1. 在 Feishu 中启动一个会执行多个工具调用的长任务。
2. 运行期间发送：

   ```text
   /steer 先停止继续搜索，只汇总已经找到的内容
   ```

3. 确认当前运行在下一个工具边界接收引导，没有启动独立 turn。
4. 发送一条新任务后立即（run 尚在排队时）发送 `/steer 补充约束`，确认返回"已排队"确认，且运行启动后注入生效。
5. 任务空闲时发送 `/steer 测试`，确认返回"没有可引导运行"及引导文案。
6. 启动子 Agent 后发送：

   ```text
   /subagents steer 1 改为检查另一个文件
   ```

7. 确认子 Agent replacement 行为保持不变。

## Risks And Mitigations

- **Risk: `steerEmbeddedPiRun()` 无 runId 默认语义被连带改变，破坏子 Agent 播报 fallback 与 followup 派发**
  - Mitigation: pending 缓冲只经新增 opt-in 函数暴露，不动 `steerEmbeddedPiRunHandle()` 默认分支；step 10 的合同断言把默认语义钉死。

- **Risk: 队列管线重构后 `/steer` 命令被 collect 队列吞掉，功能静默失效**
  - Mitigation: 处理顺序写入 Assumptions，step 9 在 `getReplyFromConfig()` 层增加"run 活动期间即时处理且不入 collect 队列"集成断言。

- **Risk: 缓冲进 pending run 的消息在注册重放失败或 pending 取消时静默丢失**
  - Mitigation: 与 WebChat byId 路径现状对齐，v1 接受；queued 确认文案使用较弱措辞（"已排队，将在运行启动时注入"），不许诺与立即注入同等强度。

- **Risk: 多个 pending run 时缓冲目标有歧义**
  - Mitigation: 仅在恰好一个 pending token 时缓冲，其余返回 `run_inactive`。

- **Risk: `/steer` 被相似命令前缀误触发**
  - Mitigation: 使用 token 边界匹配，不使用裸 `startsWith("/steer")`。

- **Risk: 引导被投递到错误会话**
  - Mitigation: 目标只取当前 `params.sessionEntry.sessionId`，不解析用户提供的 session/run 标识。

- **Risk: 普通消息被意外改成全局 steer 模式**
  - Mitigation: 不修改 `messages.queue`，不持久化 session queueMode。

- **Risk: 命令回复暴露运行状态给未授权用户**
  - Mitigation: 在读取或返回 session 状态前完成 `isAuthorizedSender` 检查。

## Success Criteria

- [ ] Feishu 中 `/steer <message>` 可以把消息注入当前活动主 Agent。
- [ ] 活动路径注入行为与 WebChat 共用 `steerEmbeddedPiRunHandle()`。
- [ ] run 排队期间 `/steer` 缓冲进唯一 pending run，注册时注入，命令零等待返回。
- [ ] 消息内容不丢失中文、大小写、标点或空格。
- [ ] 空闲、not streaming、compacting 状态返回明确结果；steered/queued 确认文案有区分。
- [ ] run 活动期间 `/steer` 即时处理、不入 collect 队列，且有集成断言固化。
- [ ] `steerEmbeddedPiRun()` 无 runId 默认语义零变化，合同断言在位。
- [ ] 未授权发送者无法 steer 当前会话。
- [ ] `/subagents steer <id|#> <message>` 行为无回归。
- [ ] `/steer` alias、`/tell` alias 及其命令定义全部移除，`/steering`、`/steerx` 不触发 steer handler。
- [ ] 聚焦 Vitest 测试通过。
- [ ] `make lint` 通过。
- [ ] 未修改 Feishu 渠道路由和全局 queue 配置。
