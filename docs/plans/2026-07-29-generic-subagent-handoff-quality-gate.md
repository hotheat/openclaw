# Implementation Plan: Generic Subagent Handoff Quality Gate

## Overview

本方案替代 `docs/plans/2026-07-29-pptx-warning-delivery.md` 中“通过公开 Plugin API 共享 parser”的路线。

Core 作为 `SUBAGENT_HANDOFF` wire format、路径安全检查和质量状态机的唯一 owner。部署扩展通过 `subagent_handoff_staging` 接收解析后的结构体，负责路径/文件名准入、文件 staging、Feishu pending 状态和 blocked tombstone。Core announce 只使用脱敏投影视图，确保 blocked 失败原因可达用户，同时不暴露文件路径或提供发送入口。

## Requirements

- Core 只保留通用协议语义，不包含 PPTX、Researcher、Feishu 路径或文件名知识。
- Core 对 handoff 中的绝对路径、路径穿越、NUL 和超长字段执行安全拒绝。
- Core 不限制业务前缀、文件扩展名或固定文件名。
- `verification` 与 `delivery` 均缺失时，handoff 状态为 `unmanaged`。
- 任一质量字段存在时，handoff 进入通用质量门。
- `passed + ready` 归一化为 `ready`。
- `passed` 且缺失 `delivery` 兼容归一化为 `ready`。
- `failed + warning + 非空 verification.summary` 归一化为 `warning`。
- 显式 `blocked`、未知状态、缺失必要信息和矛盾组合归一化为 `blocked`。
- `unmanaged`、`ready`、`warning` 只有经过 staging policy 接受后才能进入 deliverable 列表。
- `blocked` 永远不进入 deliverable 列表，不创建 pending，不提供重试或“发送文件”入口。
- `blocked` 的任务、原因和验证说明必须进入 requester announce，由父 agent 按当前会话语言告知用户。
- managed handoff 统一经过 requester-agent announce，确保 warning 披露和 blocked 失败通知有稳定出口。
- policy 明确拒绝与 policy 无法执行必须使用不同状态和不同 announce 原因。
- 无 staging hook、sessionKey 解析失败和 workspace 解析失败归类为 policy unavailable。
- staging hook 已启动后发生的超时、abort 或异常归类为 staging failure，禁止返回静默空集。
- `outcome.status !== "ok"` 时仍解析并执行 staging side effect，但 `deliveryEligible=false`；
  插件必须作废旧 pending，Core 必须清空 accepted projection、跳过 delivery hook 且不生成 deliverable。
- 检测到终端 handoff 块但 payload 无法解析时，Core 必须以 `handoffMalformed=true`
  执行 blocked staging，使部署扩展作废旧 pending，且不得接受或复制 artifact。
- policy 已评估但没有接受 artifact 时，Core 仍需向父 agent 提供部署策略拒绝信号。
- staging policy 对所有 requester 执行，包括 requester 本身是 subagent 的嵌套链路。
- 调用方提供外层 announce abort signal 时，Core 必须传入 staging；abort 后不得继续复制、写状态或调用 delivery hook。
- 缺少 `subagent_handoff_delivery` hook 时，policy assessment 和 accepted artifact 仍必须回流 announce。
- blocked 路径不得进入 announce prompt；完整原始 handoff 仅保留在 lifecycle event 和 result snapshot 中。
- warning 与 blocked 共用一套 Core 路径 scrub。
- collect queue 按 `announceId` 去重，同一 run 的 blocked 信息不得重复渲染。
- 每个新 handoff 必须使同一 peer 的旧 pending 失效。
- pending 状态必须包含 `runId`、`handoffAt`、`expiresAt` 和明确的状态迁移。
- `message_sending` 只做协议块和路径文本消毒，不解析 JSON，不执行质量判定，不写 pending。
- session-memory 的回溯解析复用 Core 内部 parser，移除独立 JSON parser 和 Researcher 专用标题。

## Non-Goals

- 不把 parser 提升为 `openclaw/plugin-sdk` 公共函数。
- 不新增 `subagent_handoff_artifact_policy` hook。
- 不把 PPTX 或 Researcher 前缀写入 Core 配置。
- 不修改全局 `openclaw.json`。
- 不在本阶段重构 handoff wire format 的标签或 JSON 外层格式。
- 不执行 Gateway 重启或部署。

## Architecture Decisions

### 1. Canonical Parsed Model

质量字段位于 handoff 顶层，适用于全部 artifacts。Core 解析结果应显式保留顶层质量结论，支持没有 artifact 的 inline blocked handoff。

```ts
type SubagentHandoffQuality = {
  gate: "unmanaged" | "managed";
  verificationStatus: "passed" | "failed" | "unknown";
  verificationSummary?: string;
  deliveryStatus: "unmanaged" | "ready" | "warning" | "blocked";
};

type ParsedSubagentHandoff = {
  mode?: "inline" | "hybrid" | "export-file";
  summary?: string;
  quality: SubagentHandoffQuality;
  artifacts: SubagentHandoffArtifact[];
  omittedArtifactCount: number;
};
```

`SubagentHandoffArtifact` 只保存路径、文件名、标题和 MIME 等 artifact 元数据。现有 artifact 级质量字段迁移到 `quality`，避免同一个顶层结论复制到每个 artifact。

### 2. Single Parser Owner

Core 提供内部解析能力：

```text
subagent-handoff.ts
├─ analyzeSubagentHandoff(content)        # live completion，解析终端 handoff
├─ parseSubagentHandoffBlocks(content)    # transcript 回溯，可解析多个 block
└─ stripSubagentHandoff(content)          # 纯协议块移除
```

三个入口共享 JSON 解码、字段归一化、路径安全和限制逻辑。插件只接收解析后的数据，不调用 parser。

### 3. Staging Acceptance Contract

`subagent_handoff_staging` 同时承担部署准入和实际文件 staging。event 增加完整解析结果：

```ts
type PluginHookSubagentHandoffStagingEvent = {
  // existing fields
  handoff: ParsedSubagentHandoff;
  handoffAt: number;
  deliveryEligible: boolean;
  handoffMalformed?: boolean;
};

type PluginHookAcceptedArtifact = {
  sourceRelativePath: string;
  requesterRelativePath: string;
};

type PluginHookStagedArtifact = {
  sourceRelativePath: string;
  relativePath: string;
  fileName?: string;
  title?: string;
  mimeType?: string;
};

type PluginHookSubagentHandoffStagingResult = {
  policyStatus: "evaluated" | "unavailable";
  acceptedArtifacts: PluginHookAcceptedArtifact[];
  stagedArtifacts: PluginHookStagedArtifact[];
  rejections: Array<{
    sourceRelativePath?: string;
    code: string;
    message: string;
  }>;
  failures: Array<{
    sourceRelativePath?: string;
    code: string;
    message: string;
  }>;
  haltRemainingHandlers?: boolean;
};
```

约束：

- `sourceRelativePath` 必须对应 `event.handoff.artifacts[].relativePath`。
- `requesterRelativePath` 是 requester workspace 内可访问、可进入 deliverable 块的路径。
- `stagedArtifacts[].relativePath` 是实际复制后的 requester-relative 路径，并通过 `sourceRelativePath` 与原 artifact 关联。
- 同 workspace 无需复制时，`requesterRelativePath` 可以等于 `sourceRelativePath`，
  `stagedArtifacts` 可以为空；该 artifact 仍进入 delivery hook。
- Core 用 `sourceRelativePath` 验证准入，用 `requesterRelativePath` 渲染 deliverable。
- `subagent_handoff_delivery` 接收全部 requester workspace 可访问的 accepted artifacts，
  包括同 workspace 无需复制的 artifact；不得反向决定 policy assessment。
- Core 忽略 source path 不存在于 parsed handoff、requester path 不安全或关联关系不完整的插件结果。
- 多个 staging hook 的 accepted/staged 结果按 `sourceRelativePath` 合并，高优先级 mapping 和 metadata 胜出。
- acceptance 采用加法合并；rejections 和 failures 独立聚合，不能反向删除其他插件已接受的 artifact。
- 任一插件返回 `policyStatus=evaluated`，合并结果即为 evaluated；hook 异常只追加 staging failure。
- 高优先级 policy 可用 `haltRemainingHandlers=true` 终止低优先级 handler；该结果同时清空已合并的 accepted/staged mapping。
- 过期、乱序和 blocked handoff 必须在文件复制 handler 之前返回 terminal result，防止旧文件覆盖或进入 delivery。
- `policyStatus=evaluated` 且 artifact 未接受时，插件必须返回显式 rejection；Core 生成部署策略拒绝信号。
- `policyStatus=unavailable` 只用于 policy 未运行或没有任何插件成功评估；存在 runtime failure 时不再附加 policy unavailable，避免双重信号。
- hook runner 必须把 staging hook 异常聚合进 `failures`，不能只记录日志后返回 `undefined`。
- 无 `subagent_handoff_delivery` hook 时，accepted/staged/policy 结果仍然返回 Core。
- `unmanaged` 可被部署扩展接受，Researcher 继续走 staging 和 delivery。
- `blocked` 不参与 artifact acceptance；扩展仍接收完整 handoff，用于清理 pending 和写 tombstone。
- acceptance 采用加法合并；已安装 staging 插件属于可信部署 policy owner。

### 4. Announce Projection

Canonical parsed data 保持原始内容，供 staging、lifecycle 和审计使用。Core 在进入 prompt 前构造独立投影：

```ts
type SubagentHandoffAnnounceView = {
  summary?: string;
  quality: SubagentHandoffQuality;
  deliverableArtifacts: SubagentHandoffAnnounceArtifact[];
  blocked?: {
    reason: string;
    verificationSummary?: string;
  };
  deliveryIssues: Array<{
    kind: "policy-rejected" | "policy-unavailable" | "staging-failed";
    reason: string;
  }>;
  omittedArtifactCount: number;
};
```

投影规则：

- `deliverableArtifacts = acceptedArtifacts ∩ (unmanaged | ready | warning)`，渲染 `requesterRelativePath`。
- `blocked` 只保留 scrub 后的自然语言原因和验证说明。
- policy rejection、policy unavailable 和 staging failure 分别进入 `deliveryIssues`，禁止合并成无原因空集。
- `deliveryIssues` 只输出 scrub 后的通用原因，不输出 source/requester workspace 路径、
  object key、预签名 URL 或凭据。
- blocked artifact 路径、文件名和 MIME 不进入投影。
- warning artifact 路径可进入 deliverable 块，但 summary、title 和 verification summary 先 scrub。
- `handoff.summary`、`verification.summary`、artifact title/label 和 blocked reason 共用一个 scrub 函数。
- scrub 先替换结构化字段中的精确路径，再清除残余绝对 workspace 路径和 `artifacts/...` 片段。
- completion 正文只剥除 handoff trailer，保留 URL、换行、Markdown、代码块和表格；强 scrub 不作用于正文。

### 5. Blocked Semantics

blocked 表示文件投递终止，文本失败通知继续。

Core announce 块使用通道无关内部语义：

```text
Blocked handoff:
- Task: <scrubbed task label>
- Reason: <scrubbed summary or normalized fallback>
- Verification details: <scrubbed details, when present>
- Instruction: Inform the user that the artifact cannot be delivered. Do not offer sending or expose workspace paths.
```

行为约束：

- blocked handoff 进入原 completion queue item，不创建第二个 announce item。
- collect queue 继续使用稳定 `announceId` 去重。
- managed completion 必须经过 requester-agent announce；ready、warning 和 blocked 共享同一语义渲染出口。
- blocked 不触发 `subagent_handoff_delivery`。
- result snapshot 保留原始 completion，供受控恢复和审计读取。

### 6. Pending State Machine

部署扩展在 `subagent_handoff_staging` 中处理状态副作用。

```json
{
  "runId": "run-id",
  "handoffAt": 0,
  "expiresAt": 0,
  "deliveryState": "pending | sending | failed_retryable | sent | blocked | superseded",
  "stagingReservation": true,
  "supersedesRunId": "older-run-id",
  "artifactPathHashes": [],
  "supersededArtifactPathHashes": []
}
```

状态规则：

```text
新 handoff
├─ handoffAt < current.handoffAt
│  └─ 忽略旧事件
├─ runId == current.runId
│  └─ 幂等处理，不把 sent/blocked 降级为 pending
└─ 更新事件
   ├─ 先使旧状态失效
   ├─ blocked              -> blocked tombstone
   ├─ 无 accepted artifact -> superseded tombstone
   └─ accepted artifact    -> pending

pending -> sending -> sent
                  └-> failed_retryable -> sending

任一可重试状态超过 expiresAt -> superseded
```

补充约束：

- TTL 使用插件配置，默认 24 小时。
- blocked/superseded tombstone 不保存明文 export path。
- tombstone 保存 canonical artifact identity 的 SHA-256，用于 `before_tool_call` 拦截针对已 blocked artifact 的发送。
- 新 pending 把被替换 handoff 的 artifact identity 移入 `supersededArtifactPathHashes`；
  `before_tool_call` 在任何 delivery state 下都必须阻断这些旧 artifact。
- reservation 升级为同 run pending 时，本 run 的新 artifact identity 不得进入
  `supersededArtifactPathHashes`。
- canonical artifact identity 必须使用同一个共享函数生成：
  - 输入为绝对路径时，先 `path.resolve`，确认路径位于 requester workspace 内，再计算 `path.relative(requesterWorkspace, absolutePath)`。
  - 输入为相对路径时，拒绝绝对路径、traversal、NUL 和空路径，再执行 `path.normalize`。
  - 最终统一为 POSIX 分隔符，移除前导 `./`，保留 Linux 大小写语义，然后按 UTF-8 计算 SHA-256。
- workspace 外绝对路径无法生成 canonical identity，必须拒绝并记录审计日志。
- `before_tool_call` 对 message 工具原始附件参数执行 canonicalization，不能依赖 basename fallback。
- `before_prompt_build`、`before_tool_call`、`after_tool_call` 都校验 `runId`、TTL 和当前状态。
- `after_tool_call` 只更新匹配当前 `lastToolCallId` 和当前 run 的状态，旧调用结果不能覆盖新 handoff。
- 新 handoff 的状态替换使用原子写，避免“先删除旧文件、后写新文件”的空窗。
- Feishu policy 在复制前可写 `deliveryState=superseded` 且 `stagingReservation=true` 的隐藏 reservation；该状态不进入 prompt，低优先级 staging 完成后由同 run 原子升级为 pending 或最终 tombstone。
- reservation 或 tombstone 持久化失败时，插件返回 terminal `state-persist-failed`，清空自身 acceptance，并按 requester state path 安装进程内 tombstone；读取 pending 时优先采用更新的 fallback，阻止磁盘旧 pending 继续发送。
- 单文件和多文件的发送确认都按声明的文件名集合匹配；结果中存在任意附件不能视为发送成功。

### 7. Message Guard Boundary

`message_sending` 保留以下职责：

- 移除 `<SUBAGENT_HANDOFF>...</SUBAGENT_HANDOFF>` 协议块。
- 清除残余 workspace 路径和 `artifacts/...` 文本片段。
- 保留已经由父 agent 渲染的用户文案和附件。

该 hook 不读取 handoff JSON，不判断 ready/warning/blocked，不创建确认提示，不写 pending。

## End-to-End Flow

```text
Child completion text
  -> Core analyzeSubagentHandoff()
  -> ParsedSubagentHandoff (raw)
  -> subagent_handoff_staging(event.handoff) for every requester
       -> event.deliveryEligible = (outcome.status == ok)
       -> deployment path/file policy
       -> invalidate old peer state
       -> policyStatus / accepted mappings / staged mappings
       -> pending or tombstone
  -> Core buildSubagentHandoffAnnounceView()
       -> accepted unmanaged/ready/warning => requester-relative Deliverable artifacts
       -> blocked => Blocked handoff, no path
       -> rejected/unavailable/failed => explicit delivery issue
       -> shared path scrub
  -> completion queue item
       -> dedupe by announceId
  -> requester agent renders current-language user message
  -> message_sending performs text-only sanitation
  -> before_tool_call / after_tool_call enforce current pending state

Top-level requester only:
  -> subagent_handoff_delivery(requester-visible accepted artifacts)
```

Researcher compatibility path:

```text
unmanaged Researcher handoff
  -> Core generic parse
  -> researcher-export-stager accepts configured prefix
  -> file copied to requester workspace
  -> accepted unmanaged artifact enters announce/delivery
```

## Architecture Changes

- `src/agents/subagent-handoff.ts`
  - 移除业务前缀和文件名限制。
  - 增加顶层 quality model、inline blocked 支持和多 block 内部解析入口。
  - 保留绝对路径、traversal、NUL、数量和长度限制。
- `src/agents/subagent-handoff-announce.ts`（新文件）
  - 构造 `SubagentHandoffAnnounceView`。
  - 集中实现路径 scrub 和 blocked/warning 自然语言字段清洗。
- `src/agents/subagent-announce.ts`
  - 每个 completion 只解析一次。
  - staging 先于 deliverable 计算。
  - staging 接受结果回流到 announce。
  - 所有 requester 执行 policy evaluation 和 staging。
  - 只有顶层 requester 执行 `subagent_handoff_delivery`。
  - 拆除“无 delivery hook 即丢弃 staging result”的早退。
  - 将无 hook、session/workspace 解析失败、超时和异常转换为显式 policy unavailable/failure。
  - managed blocked 强制进入 requester announce。
  - managed direct 只要存在 deliverable，也生成父 agent 文件发送指令。
  - delivery issue 强制进入 collect announce，禁止与 legacy direct warning 双通道重复。
- `src/agents/subagent-announce-queue.ts`
  - completion item 保存 announce view。
  - 渲染 deliverable、warning 和 blocked 块。
  - 保持 `announceId` 单项去重。
- `src/plugins/types.ts`, `src/plugins/hooks.ts`
  - staging event 增加 `handoff`、`handoffAt`、`deliveryEligible`、`handoffMalformed`。
  - staging result 拆分 `acceptedArtifacts` 与 `stagedArtifacts`。
- `src/plugin-sdk/index.ts`, `src/plugins/registry.ts`
  - 删除当前未完成的 parser public API 暴露。
- `src/hooks/bundled/session-memory/transcript-input.ts`
  - 使用 Core 内部多 block parser。
- `src/hooks/bundled/session-memory/summary-markdown.ts`
  - 将 `Researcher 产物` 改为通用 artifact 标题。
- `extensions/researcher-export-stager/index.js`
  - staging 主路径直接消费 `event.handoff`。
  - 返回 accepted/staged 两类结果。
  - 删除 `message_sending` 和 `subagent_ended` 中对 handoff 文本的补偿解析。
  - 保留基于显式工具路径的 `before_tool_call` 文件镜像补偿。
- `extensions/subagent-handoff-output-guard/index.js`
  - 注册 `subagent_handoff_staging` 处理部署准入和 peer state。
  - 移除 wire parser、质量矩阵和 message_sending 状态副作用。
  - 增加 ordering、TTL、tombstone 和 tool-call 硬门。

## Implementation Steps

### Phase 1: 清理错误方向

1. **撤销 public parser API 暴露**
   - Files: `src/plugin-sdk/index.ts`, `src/plugin-sdk/index.test.ts`, `src/plugins/registry.ts`, `src/plugins/types.ts`, `src/plugins/agent-trace-sink.registration.test.ts`, `extensions/lobster/src/lobster-tool.test.ts`
   - Action: 删除 `api.analyzeSubagentHandoff`、SDK exports 和为该字段补的测试桩。
   - Why: parser 保持 Core 内部单一 owner，插件消费 hook event 的解析结果。
   - Dependencies: None.
   - Risk: Low；当前改动尚未提交。

2. **更新旧方案状态**
   - File: `docs/plans/2026-07-29-pptx-warning-delivery.md`
   - Action: 在顶部标记 superseded，并链接本方案；删除已完成勾选，避免文档误导。
   - Why: 当前文档记录了已放弃的 SDK 共享路线。
   - Dependencies: Step 1.
   - Risk: Low.

### Phase 2: Core Parser 与质量模型

3. **建立顶层质量模型**
   - Files: `src/agents/subagent-handoff.ts`, `src/agents/subagent-handoff.test.ts`
   - Action: 将 gate、verification 和 delivery 归一化到 handoff 顶层；覆盖 inline blocked 和零 artifact。
   - Why: wire fields 位于顶层，blocked 不能依赖 artifact 存在。
   - Dependencies: Phase 1.
   - Risk: Medium；需要迁移现有 artifact 级调用点。

4. **收紧通用路径安全，移除业务白名单**
   - Files: `src/agents/subagent-handoff.ts`, `src/agents/subagent-handoff.test.ts`
   - Action: 接受任意安全 workspace-relative path；拒绝绝对路径、traversal、NUL、空路径和超限输入。
   - Why: 文件类型和业务目录属于部署 policy。
   - Dependencies: Step 3.
   - Risk: High；必须与 staging fail-closed 同批完成，不能单独提交到可部署状态。

5. **统一 transcript 解析入口**
   - Files: `src/agents/subagent-handoff.ts`, `src/hooks/bundled/session-memory/transcript-input.ts`, `src/hooks/bundled/session-memory/summary-markdown.ts`, `src/hooks/bundled/session-memory/handler.test.ts`
   - Action: 增加内部多 block 解析函数，替换 session-memory 的 regex + `JSON.parse`；标题改为 `Exported artifacts`。
   - Why: 清除第三条 parser 车道和 Researcher 专用文案。
   - Dependencies: Steps 3-4.
   - Risk: Medium；需保留历史 transcript 中多 handoff block 的提取能力。

### Phase 3: Staging 契约与权威准入

6. **扩展 staging event/result**
   - Files: `src/plugins/types.ts`, `src/plugins/hooks.ts`, `src/plugins/wired-hooks-subagent.test.ts`
   - Action: event 增加 `handoff`、`handoffAt`、`deliveryEligible`、`handoffMalformed`；result 增加 `policyStatus`、source/requester path mapping、`rejections` 和 `failures`；accepted/staged 按 source path 加法合并；staging hook 异常只进入 failures，显式 halt 才能清空结果并终止后续 handler。
   - Why: 插件需要结构化输入，Core 需要权威准入结果。
   - Dependencies: Phase 2.
   - Risk: High；属于插件 hook 合同变更。

7. **让 staging 结果回流 announce**
   - Files: `src/agents/subagent-announce.ts`, `src/agents/subagent-announce.format.test.ts`
   - Action: 在 `runSubagentAnnounceFlow` 中先解析、再 staging、再计算 deliverable；Core 用 source path 验证 accepted mapping，使用 requester path 渲染 deliverable；policy 拒绝与 unavailable 生成不同 announce issue；managed handoff 统一进入 requester-agent announce。
   - Why: 防止 `MEMORY.md` 等任意安全相对路径绕过部署 policy。
   - Dependencies: Step 6.
   - Risk: High；影响 direct、parent、WebChat 和 nested requester 路径。

8. **保持 staged delivery 行为**
   - Files: `src/agents/subagent-announce.ts`, `src/plugins/types.ts`, 相关 delivery tests
   - Action: policy evaluation 和 staging 对所有 requester 执行；`subagent_handoff_delivery`
     只对顶层 requester 执行并接收全部 requester-visible accepted artifacts；缺少 delivery hook
     时仍返回 assessment 和 accepted mapping；delivery failure 进入结构化 `deliveryIssues`，
     并切换到 collect announce，禁止再追加 legacy warning。
   - Why: artifact acceptance 与文件复制/发布具有不同语义。
   - Dependencies: Steps 6-7.
   - Risk: Medium；Researcher WebChat 自动发布不能回归。

### Phase 4: Announce 投影、Scrub 与 Queue

9. **新增 announce projection**
   - Files: `src/agents/subagent-handoff-announce.ts`, 对应新测试文件
   - Action: 生成 deliverable 和 blocked 投影；协议字段使用共享强 scrub，completion 正文只剥 trailer。
   - Why: raw 数据用于审计，prompt 数据必须去路径。
   - Dependencies: Phase 3.
   - Risk: High；scrub 过宽会损伤自然语言，过窄会泄漏路径。

10. **渲染 blocked 和 warning**
    - Files: `src/agents/subagent-announce.ts`, `src/agents/subagent-announce-queue.ts`, `src/agents/subagent-announce-queue.test.ts`, `src/agents/subagent-announce.format.test.ts`
    - Action: completion item 保存 announce view；渲染 `Deliverable artifacts` 和 `Blocked handoff`；warning 保留验证披露指令。
    - Why: blocked 需要用户可见失败原因，文件仍然终止投递。
    - Dependencies: Step 9.
    - Risk: High；不得把 blocked path 放入 prompt。

11. **固定 queue 去重**
    - Files: `src/agents/subagent-announce-queue.ts`, `src/agents/subagent-announce-queue.test.ts`
    - Action: blocked 数据保留在原 completion item；用现有 `announceId` 去重；补 collect 重放测试。
    - Why: 同一 run 只能生成一次失败通知。
    - Dependencies: Step 10.
    - Risk: Low；现有 enqueue 已按 `announceId` 去重。

### Phase 5: 部署扩展迁移

12. **迁移 Researcher stager**
    - Files: `extensions/researcher-export-stager/index.js`, `extensions/researcher-export-stager/test/index.test.cjs`
    - Action: live staging 使用 `event.handoff.artifacts`，按配置前缀接受 unmanaged Researcher artifact；当前实现继续保留原相对路径复制，并返回 `sourceRelativePath -> requesterRelativePath` 映射；删除 `message_sending` 和 `subagent_ended` 中的 handoff parser，保留显式工具路径补偿。
    - Why: Researcher 继续交付，同时退出扩展侧 wire parsing。
    - Dependencies: Phase 3.
    - Risk: High；unmanaged 不得被当作丢弃状态。

13. **迁移 output guard 到 staging**
    - Files: `extensions/subagent-handoff-output-guard/index.js`, `extensions/subagent-handoff-output-guard/openclaw.plugin.json`, `extensions/subagent-handoff-output-guard/test/index.test.cjs`
    - Action: 在 staging 中执行配置前缀/文件名 policy，返回 accepted artifacts；按 peer 更新 pending 或 tombstone。
    - Why: 状态副作用需要发生在结构化 handoff 生命周期内。
    - Dependencies: Phases 3-4.
    - Risk: High；状态文件存在跨轮次和并发写。

14. **实现状态时序和 TTL**
    - Files: `extensions/subagent-handoff-output-guard/index.js`, guard tests
    - Action: 增加 `runId`、`handoffAt`、`expiresAt`、同 run 幂等、旧事件拒绝、旧 pending 失效和原子替换。
    - Why: 防止旧 warning pending 在新 blocked handoff 后继续可发送。
    - Dependencies: Step 13.
    - Risk: High；需覆盖乱序和 in-flight tool result。

15. **处理运行失败和状态持久化失败**
    - Files: `src/agents/subagent-announce.ts`, `extensions/researcher-export-stager/index.js`, `extensions/subagent-handoff-output-guard/index.js`, 对应 tests
    - Action: 非 ok outcome 下发 `deliveryEligible=false`；扩展只执行旧状态失效，不复制、不接受；Core 跳过 delivery hook。状态 reservation/tombstone 写失败时返回 terminal failure，并使用进程内 fallback tombstone 阻断旧 pending。
    - Why: 防止失败 run 的伪造 ready trailer 被交付，也防止状态文件写失败后旧 pending 复活。
    - Dependencies: Steps 13-14.
    - Risk: High；必须同时覆盖 error、timeout、unknown 和持久化异常。

16. **实现 tombstone 硬门**
    - Files: `extensions/subagent-handoff-output-guard/index.js`, guard tests
    - Action: blocked/superseded 状态清除明文路径、保留 canonical artifact identity hash；相对路径和 requester workspace 内绝对路径共用同一 canonicalization；`before_tool_call` 拦截匹配 tombstone 的附件发送。
    - Why: blocked 语义不能依赖 prompt 约束。
    - Dependencies: Step 14.
    - Risk: Medium；匹配必须限定到 artifact，不能阻断无关附件。

17. **收缩 message_sending**
    - Files: `extensions/subagent-handoff-output-guard/index.js`, guard tests
    - Action: 只保留协议块和路径文本消毒；删除 parser、状态矩阵、确认提示和 pending 写入。
    - Why: message hook 只处理已经渲染的出站文本。
    - Dependencies: Steps 13-16.
    - Risk: Medium；需验证普通文本和已有附件不被改写。

### Phase 6: Documentation and Migration

18. **更新协议与技能文档**
    - Files: `workspace/AGENTS.md`, `workspace/skills/otr-pptx-generator/SKILL.md`, `workspace/skills/otr-pptx-restyle/SKILL.md`
    - Action: 对 ready、warning、blocked 给出统一 schema；blocked 使用 inline handoff 且不声明 export。
    - Why: 生产者必须稳定声明质量结论和投递许可。
    - Dependencies: Core 状态机确定后。
    - Risk: Medium；两个 spawn task 文案必须保持一致。

19. **分仓提交和部署顺序**
    - Source: `/home/xiaolu/github/openclaw-integration`
    - Workspace: `/home/xiaolu/.openclaw`
    - Action: 先提交 Core hook contract 和测试，再提交扩展迁移；实际启用时先部署 Core，再启用依赖新 event 的扩展。
    - Why: 旧 runtime 不提供 `event.handoff`。
    - Dependencies: 前述全部步骤。
    - Risk: High；两个仓库不能只部署一半。

## Testing Strategy

### Core Unit Tests

- 质量矩阵：
  - unmanaged
  - passed + implicit ready
  - passed + ready
  - failed + warning + summary
  - failed + missing summary
  - unknown/contradictory/explicit blocked
- inline blocked 且没有 artifact。
- 任意安全相对路径可解析。
- absolute、Windows absolute、traversal、NUL、超长和重复路径被拒绝。
- 多 block transcript 使用同一 parser。
- SDK 和 `OpenClawPluginApi` 不暴露 parser。

### Core Integration Tests

- staging 未接受的 artifact 不进入 deliverable。
- policy 明确拒绝时生成 policy-rejected announce issue。
- 无 staging hook 时生成 policy-unavailable announce issue。
- child/requester sessionKey 或 workspace 无法解析时生成 policy-unavailable announce issue。
- staging 超时或 hook 抛错时生成 staging failure，不能返回静默空集。
- 多 hook 中一个异常不能清空其他插件的 accepted/staged；任一 evaluated 使最终 policyStatus 为 evaluated。
- 只有显式 `haltRemainingHandlers` 能清空已合并 acceptance 并停止后续 handler。
- error、timeout、unknown outcome 即使携带 ready trailer，也不创建 deliverable、不调用 delivery hook。
- malformed terminal handoff 执行 blocked staging，覆盖旧 pending，且不接受或复制 artifact。
- 调用方提供的外层 abort 或内部 timeout 触发后，低优先级 staging handler、状态写入和 delivery hook 不再执行。
- 过期、乱序和 blocked terminal policy 会阻止 Researcher stager 复制。
- staging 返回未知路径时被 Core 丢弃。
- deliverable 使用 requester-relative staged path，不使用 child workspace source path。
- 当前 Researcher stager 的 source/requester path 相等回归测试保持通过。
- unmanaged Researcher artifact 经 stager 接受后进入 staging/delivery。
- ready/warning artifact 经 policy 接受后进入 parent deliverable。
- blocked 进入 announce，prompt 中没有 relative path、absolute path 或 `artifacts/...`。
- warning summary 中嵌入路径时被 scrub。
- Researcher 正文中的标题、列表、表格、代码块和引用 URL 保持原格式。
- collect queue 对相同 `announceId` 只渲染一次 blocked。
- direct delivery issue 只进入一次结构化 collect announce。
- managed direct artifact 仍包含父 agent 文件发送指令。
- nested requester 必须执行 policy evaluation/staging，但不能执行渠道 delivery hook。
- 缺少 `subagent_handoff_delivery` hook 时 accepted artifact 仍进入 parent announce。
- direct、parent、WebChat 和缺失 channel 兼容路径保持现有行为。

### Extension Tests

- Researcher stager 不再解析 live `event.content`。
- Researcher stager 不再从 transcript 或 `message_sending` 重新解析 handoff。
- output guard 不再解析 handoff JSON。
- 新 ready/warning/unmanaged handoff 覆盖旧 pending。
- 新 blocked handoff 覆盖旧 warning pending。
- 非 ok handoff 覆盖旧 pending，且不创建新 pending。
- reservation/tombstone 写失败时，进程内 fallback tombstone 阻止旧 pending 和新 artifact。
- 旧乱序 handoff 无法覆盖新状态。
- 同 run 重放不能把 `sent` 降级为 `pending`。
- TTL 到期后 pending 不进入 prompt，也不能触发发送。
- 旧 `after_tool_call` 结果不能修改新 run。
- blocked tombstone 不包含明文路径。
- blocked path hash 可阻止 requester workspace 内的绝对路径附件。
- 相同 artifact 的相对路径与绝对路径生成相同 hash。
- workspace 外绝对路径不能命中或生成合法 artifact identity，并产生审计日志。
- 无关绝对路径附件不受影响。
- 渠道发送失败进入 `failed_retryable`，成功进入 `sent`。
- 单文件 tool result 必须匹配声明文件名；无关附件不能把状态误标为 `sent`。
- `message_sending` 只移除协议块和路径文本。

### Validation Commands

```bash
pnpm vitest run \
  src/agents/subagent-handoff.test.ts \
  src/agents/subagent-handoff-announce.test.ts \
  src/agents/subagent-announce-queue.test.ts \
  src/agents/subagent-announce.format.test.ts \
  src/plugins/wired-hooks-subagent.test.ts \
  src/plugin-sdk/index.test.ts \
  src/hooks/bundled/session-memory/handler.test.ts

node --test extensions/researcher-export-stager/test/index.test.cjs
node --test extensions/subagent-handoff-output-guard/test/index.test.cjs

git diff --check
make lint
```

不运行 `make test`。不运行 `make build`，除非当前对话获得明确授权。

## Risks & Mitigations

- **Core 白名单移除后任意文件进入交付**
  - Mitigation: deliverable 必须经过 staging `acceptedArtifacts`；无 policy 时 fail closed。
- **Fail-closed 产生静默空集**
  - Mitigation: staging 返回显式 policy status；拒绝、不可用和执行失败分别进入 announce issue。
- **Source path 在 requester workspace 不可访问**
  - Mitigation: accepted mapping 同时携带 source 和 requester path；announce 只渲染 requester path。
- **Nested requester 永远得不到 accepted artifact**
  - Mitigation: policy evaluation/staging 对全部 requester 执行，只有渠道 delivery 保留顶层限制。
- **缺少 delivery hook 导致 accepted result 丢失**
  - Mitigation: assessment 返回与渠道 delivery 解耦；无 delivery hook 不清空 accepted mapping。
- **Researcher unmanaged 流程被误丢弃**
  - Mitigation: quality gate 允许 unmanaged，Researcher stager 负责显式接受和复制。
- **blocked 原因携带路径**
  - Mitigation: Core projection 对 summary、verification summary、title 和 label 统一 scrub；blocked 投影不含 artifact metadata。
- **parser 漂移**
  - Mitigation: live hook 和 transcript 都调用 Core 内部 parser；扩展不保留 JSON handoff parser。
- **插件 SDK 版本错配**
  - Mitigation: 不公开 parser 函数；结构化结果随 lifecycle event 传递。
- **旧 pending 穿透新 blocked**
  - Mitigation: 新 handoff 原子覆盖 peer state，写 blocked/superseded tombstone，并校验 runId 与 TTL。
- **旧 tool result 回写新状态**
  - Mitigation: `after_tool_call` 同时匹配 runId、toolCallId 和当前状态。
- **tombstone 误伤无关附件**
  - Mitigation: 使用 requester-workspace-relative POSIX identity hash 精确匹配，禁止按 basename 或“当前 peer 有 blocked”做全局拦截。
- **scrub 破坏普通文本**
  - Mitigation: 先按结构化精确路径替换，再使用受限 path-fragment pattern；增加正反例测试。
- **双仓部署中间态**
  - Mitigation: Core 先部署，扩展后启用；不提供扩展侧 parser fallback。

## Success Criteria

- [x] Core 源码不包含 PPTX、Researcher 的路径和文件名判定。
- [x] Core 只有一套 handoff JSON parser 和质量状态机。
- [x] `openclaw/plugin-sdk` 不导出 handoff parser。
- [x] staging event 携带 raw parsed handoff。
- [x] staging 结果是 artifact 进入 announce 的权威准入依据。
- [x] policy rejected、policy unavailable 和 staging failure 都有独立 announce 信号。
- [x] 无 hook、session/workspace 解析失败、超时和异常不会产生静默空集。
- [x] accepted mapping 明确关联 source path 与 requester path。
- [x] deliverable 只渲染 requester workspace 可访问路径。
- [x] nested requester 执行 policy evaluation/staging。
- [x] 无 delivery hook 时 accepted mapping 仍回流 announce。
- [x] unmanaged Researcher 继续 staging 和投递。
- [x] ready/warning 文件只在 policy 接受后进入 deliverable。
- [x] blocked 文件不进入 deliverable、不创建 pending、不提供发送入口。
- [x] blocked 用户通知稳定可达，且 prompt 中没有路径。
- [x] warning 披露信息经过 scrub 后仍完整可用。
- [x] collect queue 对同一 run 的 blocked 信息只渲染一次。
- [x] pending 状态具备 runId、ordering、TTL 和幂等保护。
- [x] 新 blocked handoff 会使旧 warning pending 立即失效。
- [x] 相对路径和 requester workspace 内绝对路径生成相同 tombstone hash。
- [x] 绝对路径附件回归测试能真实触发 blocked 硬门。
- [x] `message_sending` 不再承担协议解析或状态决策。
- [x] session-memory 使用 Core parser 和通用 artifact 标题。
- [x] focused tests、`git diff --check` 和 `make lint` 通过。
