# Implementation Plan: WebChat 结构化附件引用与历史回放

- 日期：2026-08-04
- 状态：PLAN_APPROVED / INTEGRATION_QA
- 修订：R7（2026-08-05）——吸收 Fresh Review Round 1；Human 选择保留 52px 缩略入口与可访问 lightbox，补充 Gateway/BFF 顶层 attachments fail-closed 清理、用户附件严格 MIME allowlist、三仓 QA 与人工验收门
- 涉及仓库：openclaw-integration、agent-server、agent-frontend
- 实施范围：用户输入附件的上传、发送、即时展示、历史恢复和下载
- 架构裁决：先完成 INPUT 字节保留和 Gateway 写入 spike；稳定写入门通过后采用结构化引用主路径，未通过则采用 media marker 读取回退

## Overview

本计划将 WebChat 图片和文件补成一条可刷新、可重新进入的持久回放链路。无论 Gateway 从 transcript 结构化字段还是现有 media marker 取得附件候选，BFF 都必须按当前 WebChat binding 查询 openclaw_artifacts，重新校验归属并生成浏览器可见的通用 attachments 数组。

当前不预设 transcript 写入一定可行。Phase 0 只接受有稳定接口、无需 patch-package、无需依赖监听器顺序的实现；如果只能修改外部 pi 对象、维护补丁或建立无稳定消息关联键的 sidecar，则终止结构化写入路线，直接执行已核验的 marker 读取回退。

本期不新增 agent-server 会话表或 Message-Artifact Link。消息缩略入口和 lightbox 都直接加载原图字节；服务端生成缩略图、preview endpoint、尺寸受限 rendition 和 chat.steer 附件均不进入本期。

## Delivery Governance

### Approval Gate

- Plan revision：`R7`
- Human-selected direction：保留当前消息内 52px 缩略入口与 modal lightbox；不恢复 R6 的 320px 纵向原图方案。
- Direction decision：2026-08-05，Human 明确回复“保留 lightbox 更合理，继续”。
- Exact Plan approval：2026-08-05，Human 明确回复“批准，继续”。
- Approved revision：`R7`，批准前 SHA-256 `41cab0bf1285b7bfc67c5480db3e48f3ac5fac27afbea771b3ed85e30208827e`。
- Execution gate：已满足；本次写回只记录批准治理元数据，不改变已批准技术范围。

### Review Round 1 Disposition

1. Important：Gateway/BFF 会保留 transcript 原始顶层 `attachments`。R7 要求两层均先删除该字段，只允许 BFF 用七维 scope 查询结果重建公开四字段数组。
2. Important：用户消息图片分流存在扩展名回退。R7 要求用户即时态与 history 仅接受四种 raster MIME；assistant OUTPUT artifact 的扩展名回退拆成独立函数。
3. Important：R6 UI 与当前 lightbox 实现不一致。Human 已选择保留 lightbox，R7 将当前交互纳入冻结契约。
4. Important：Required Manual Acceptance 无执行证据。修复后必须完成三仓自动化 QA 和跨浏览器/OSS/BFF/Gateway/transcript 的人工验收，才能进入新 Fresh Review Round。

### Shared Contract Addendum

1. Gateway 对 BFF 的 `chat.history` 用户消息必须删除 transcript 原始顶层 `attachments` 和原始 `__openclaw`，再仅重建校验后的 `__openclaw.attachments` 候选。
2. BFF 必须再次删除 Gateway 输入中的顶层 `attachments` 和 `__openclaw`；只有七维 scope 批量查询命中的 artifact 才能生成公开 `attachments`。
3. 浏览器公开附件仍严格为 `attachmentId/fileName/mimeType/sizeBytes`；无命中、部分命中、查询异常和 artifact service 缺失时不得保留上游同名字段。
4. 用户附件只有 `image/png`、`image/jpeg`、`image/webp`、`image/gif` 进入图片缩略入口和 lightbox；其他 MIME 进入文件卡。
5. 不改 route、request schema、download auth、generated client、lockfile 或数据库 migration。
6. retained READY INPUT 不计入每会话 active artifact 配额；PENDING/MATERIALIZING 和既有 READY OUTPUT 配额语义保持不变。retention 负责 INPUT 存储生命周期，active quota 继续限制在途上传和 OUTPUT artifact。

### Ownership Map

| Surface                                 | Owner        | Worktree                                               | Forbidden overlaps                   |
| --------------------------------------- | ------------ | ------------------------------------------------------ | ------------------------------------ |
| agent-server 安全清理与测试             | Codex        | `~/github/agent-server` 的 PR 分支工作树               | frontend、共享计划、lockfile         |
| OpenClaw Gateway 清理与测试             | Codex        | `~/github/openclaw-integration-v2.22` 的 PR 分支工作树 | frontend、共享计划、lockfile         |
| agent-frontend MIME/lightbox 契约与测试 | Claude Code  | 独立 frontend worktree                                 | backend、Gateway、共享计划、lockfile |
| Shared Contract、Plan、PR 描述、集成 QA | Orchestrator | integration worktree                                   | worker 并发写入                      |

Shared Contract 和 Plan 由 Orchestrator 串行修改。三个实现 worktree 不并发写同一文件；若 SSH 或 Claude Code 依赖不可用，立即停止并记录 `BLOCKED`。

### Frozen Baselines and Exit Evidence

| Repository                   | Base                                       | Current reviewed head                      |
| ---------------------------- | ------------------------------------------ | ------------------------------------------ |
| agent-server PR #268         | `05b9b6bd203d71e7f702c73c382fdd8fd51607a5` | `999b1a911ce1de4640ab5b4182aba09df5a8d700` |
| agent-frontend PR #54        | `52bab5cafda3f229615054c9e536c440c12c379d` | `ea1da86e8fe75bddbeef637faa097442e478eb86` |
| openclaw-integration PR #104 | `c6d0c23582314404ba5b66e3d5270efaa8b0aa66` | `e0e46b062320d79e6434c0e98f4abb602221d819` |

### R7 Execution Evidence

- agent-server：`uv run python -m pytest -q` 覆盖 4 个目标文件，`62 passed`；变更文件 `ruff check` 与 `git diff --check` 通过。
- agent-frontend：Claude Code session `3a68b2de-9154-4861-a221-444364e40303` 完成实现；Orchestrator 在最终工作树重跑 `npm run test`（unit/Node `165 passed`，component `202 passed`）、`npm run type-check`、`npm run lint`、`npm run build` 与 `git diff --check`，全部通过。构建仅有既存的大 chunk 非阻断警告。
- openclaw-integration：`pnpm vitest run src/gateway/chat-attachments.test.ts src/gateway/server.chat.gateway-server-chat-b.test.ts src/gateway/chat-sanitize.test.ts`，`40 passed`；目标文件 `oxfmt --check` 与 `git diff --check` 通过。
- Required Manual Acceptance：`PENDING`。必须在包含三个新 head 的同一集成环境执行；自动化证据不替代该门。

执行前以当前远端 head 重新核对；若 head 已变化，更新 baseline 和 Review Packet。退出 `INTEGRATION_QA` 前必须同时具备：

1. 三仓目标测试、静态检查和 `git diff --check` 通过；agent-frontend 必须补当前 head 的 unit/component/type-check/lint/build 证据。
2. Required Manual Acceptance 逐项记录结果和失败边界。
3. 三个 PR description 按仓库模板填写并通过 validation；不得保留占位注释。
4. 修复后重新构建不含 Round 1 finding transcript 的 Review Packet，启动全新 Codex reviewer 进入 Round 2。

## Requirements

### Functional Requirements

1. 图片上传并发送后，当前消息立即显示图片。
2. 页面刷新或重新进入同一会话后，历史消息仍显示图片。
3. Markdown、TXT、PDF 等非图片附件在当前消息和历史消息中显示文件卡。
4. 文件卡显示原文件名、MIME、大小和下载入口。
5. 同一消息允许图片和文件混合，刷新前后顺序一致。
6. 允许纯附件消息，也允许文本加附件。
7. 图片加载失败时降级为同一附件的文件卡。
8. INPUT 对象在配置的 READY retention 窗口内可以下载。

### Public Contract

BFF 对浏览器只返回以下字段，数组顺序就是附件显示顺序：

    type ChatHistoryAttachment = {
      attachmentId: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
    };

约束：

1. 不增加 kind。前端使用严格 MIME allowlist 推导图片或文件。
2. fileName、mimeType、sizeBytes 只取 openclaw_artifacts。
3. history 使用 mimeType；现有 attachments.complete 继续使用 contentType，前端在 mapper 层转换。
4. 浏览器不能收到 Gateway 私有引用、workspace path、safeName、OSS object key、Base64 或长期签名 URL。
5. 新字段保持可选，没有附件的历史消息继续正常显示文本。

### Gateway to BFF Contract

Gateway 只向 BFF 返回私有候选引用：

    type GatewayHistoryAttachmentRef = {
      attachmentId: string;
      ordinal: number;
    };

    type GatewayHistoryUserMessage = {
      role: "user";
      __openclaw?: {
        attachments?: GatewayHistoryAttachmentRef[];
      };
    };

候选来源有明确优先级：

1. 主路径：Phase 0 稳定写入门通过后，从 transcript 的结构化 attachment refs 读取。
2. 回退路径：结构化 refs 缺失或 Phase 0 未通过时，从消息开头连续的 media marker 恢复。
3. 两种来源都只生成 attachmentId 和 ordinal，不提供公开元数据或授权结论。
4. 同一消息存在结构化 refs 时不再解析 marker，避免重复和顺序冲突。

### Security and Performance Requirements

1. BFF 必须在每次父会话 chat.history 时按当前 binding 重新校验 artifact 归属。
2. 查询范围必须同时包含：
   - artifact ID
   - session_ref
   - principal_id
   - target_kind
   - target_id
   - client_session_id
   - direction = INPUT
3. 一次 history 响应中的候选 ID 去重后批量查询，禁止 N+1。
4. 单条消息去重后最多保留 16 个候选；一次 history 最多查询 256 个唯一 ID。超限截断保序并记录无敏感字段的计数。
5. 归属不匹配、未知、重复或格式错误的引用静默丢弃，文本仍正常返回。
6. BFF 在成功、部分成功、空结果、artifact service 不可用时都必须删除整个 \_\_openclaw 命名空间（不只 attachments 键）。现状说明：`__openclaw` 不是本期新造的命名空间，Gateway 今天已用它合成 compaction 标记（`session-utils.fs.ts` 给 compaction 条目写 `{kind:"compaction",id}`），BFF translator 与前端均不消费它（compaction 分隔线走 `payload.stream==='compaction'` 实时事件）。因此删除整个 `__openclaw` 安全、不破坏现有功能，compaction 标记一并被剥离。
7. 子会话 history 本期不做附件 enrichment，但必须剥离 \_\_openclaw。
8. download endpoint 继续执行独立鉴权：按 principal_id、target_kind、target_id、client_session_id 四维 scope 加 READY 状态检查。session_ref 与 direction 不参与 download 校验；同 scope 的 OUTPUT artifact 保持可下载。同一用户、同一 target、同一 clientSession 的不同 client instance 在持有不可猜测 attachmentId 时可下载，为已知限制（见 Deferred Work）。
9. 前端只内联 image/png、image/jpeg、image/webp、image/gif；SVG、HTML、未知 MIME 和其他类型统一进入文件卡。
10. mimeType 只用于展示分流，不构成内容安全证明。

### Non-goals

1. 不恢复 chat.history 中的图片 Base64。
2. 不新增会话表、消息表、Message-Artifact Link 或 migration。
3. 不在 transcript 持久化 fileName、mimeType、sizeBytes 或 kind。
4. 不使用 patch-package 修改 pi。
5. 不建立依赖文本或消息顺序匹配的 sidecar。
6. 不扩展 chat.steer 附件协议；带附件消息继续通过 chat.send 创建新 run。
7. 不实现图片编辑、裁剪、标注或拖拽排序。
8. 不在本期实现 preview endpoint、LQIP、GIF 首帧或服务端 resize。
9. 不改变现有单附件大小和单消息附件数量限制。
10. 不新增 INPUT 独立 retention 配置项；本期改为将全局 ready_retention_seconds 默认值调为 180 天（INPUT 与 OUTPUT 共享）。是否回退到更短窗口或再为 INPUT 单独设值由后续产品决策 + OSS 成本数据决定（见 Risk 5 与 Observability）。

### Assumptions and Constraints

1. 当前 agent-server 使用 UUID 生成 INPUT artifact ID。
2. 当前 Gateway materialize 路径是 uploads/webchat/<clientSessionId>/<artifactId>-<safeName>。
3. 当前 transcript 持久保存消息开头的 media marker。
4. openclaw_artifacts 持久保存完整 WebChat scope 和公开文件元数据。
5. attachments.complete 已返回 attachmentId、fileName、contentType、sizeBytes，前端尚未完整消费。
6. 当前 BFF resolve_chat_attachments 会丢弃 attachmentId；结构化写入主路径需要保留它。
7. pi prompt 当前只公开文本和图片参数，没有已核验的附件元数据参数。
8. 首次上线没有必须恢复的存量历史图片；marker 回退主要用于写入门失败、分阶段发布和异常消息。
9. 首次上线采用同一维护窗口三步发布：Gateway → agent-server → frontend。窗口内旧 BFF 会把 \_\_openclaw（仅 attachmentId 与 ordinal，均为浏览器本就可见的低敏感值）短暂透传给浏览器，该风险已显式接受；agent-server 发布后由强制清理关闭窗口。
10. ready_retention_seconds 原默认 30 天，可经 OPENCLAW_ARTIFACT\_\_READY_RETENTION_SECONDS 覆盖。本期决定将全局默认调为 **180 天**（同时影响 INPUT 与 OUTPUT artifact），理由：历史附件回放窗口需要更长保留期。

以上第 1 至 7 条已于 2026-08-04 对照三仓代码核验成立；attachments.complete 服务端已返回四字段，前端当前仅消费 attachmentId。

## Architecture Review

### Current Execution Chain

上传与发送：

    File
      -> attachments.init
      -> browser PUT private OSS
      -> attachments.complete
      -> BFF resolve attachmentId
      -> Gateway attachments.materialize
      -> workspace file
      -> chat.send
      -> transcript media marker

当前 history：

    chat.history
      -> image-only path regex
      -> pair with image block
      -> strip marker and envelope
      -> remove image Base64
      -> BFF pure translation
      -> frontend only parses omitted image block

当前缺口：

1. Gateway 只恢复图片，纯 Markdown、TXT、PDF 没有 image block。
2. BFF 丢弃 attachmentId，Gateway 无法直接持久化稳定引用。
3. pi 没有已核验的 transcript 附件元数据写入接口。
4. BFF history 没有按当前 binding 重新校验附件。
5. INPUT artifact READY 后立即删除 OSS 原对象。
6. 前端 ChatMessageAttachment 缺少 sizeBytes，UserMessage 又把全部附件当图片。
7. 乐观态只保存 attachmentId，纯附件消息仍被文本非空判断阻断。

### Data Ownership

| 数据                     | 唯一真相源                                                 | 说明                            |
| ------------------------ | ---------------------------------------------------------- | ------------------------------- |
| 会话身份和消息顺序       | Gateway transcript                                         | BFF 不复制会话实体              |
| 某条消息的附件引用和顺序 | Gateway transcript structured refs，缺失时使用 marker 回退 | 只保存 ID 和 ordinal            |
| 附件归属和公开元数据     | agent-server openclaw_artifacts                            | 每次父会话 history 重新校验     |
| 附件字节                 | 私有 OSS                                                   | 经登录态 download endpoint 获取 |

### Table Decision

本期不新增 agent-server 会话表，也不新增 openclaw_message_artifact_links。

依据：

1. Gateway 已持有会话与消息历史。
2. openclaw_artifacts 已包含 session_ref、principal、target、client session、direction 和公开元数据。
3. 当前缺少稳定消息附件引用和 history enrichment，不缺会话实体。
4. link 表仍需要稳定 message 或 run join key。
5. 新表会增加双写、会话删除同步、迁移和回滚成本。

仅在以下条件出现时重新评估 Message-Artifact Link：

1. Gateway 无法提供稳定结构化写入，同时不再保留可恢复 marker。
2. BFF 需要脱离 Gateway history 独立查询消息附件。
3. 产品要求消息级级联删除、跨会话复用或更强的同会话消息绑定完整性。
4. artifact ID 无法从 marker 的结构化路径中无歧义恢复。

## Architecture Decision Gate

### Gate Objective

验证 Gateway 是否存在可长期维护的 transcript 私有引用写入点。Spike 只验证引用：

    __openclaw: {
      attachments: [
        { attachmentId, ordinal }
      ]
    }

不得写入文件名、MIME、大小、kind、workspace path 或 URL。

### Spike Candidate

Phase 0 已有一个具体、仓库自有、同步、可测试的候选扩展点，与现有 `inputProvenance` 给 user message 追加扩展字段走同一机制：

1. `chat.send` 从附件 descriptor 提取 `{ attachmentId, ordinal }`。
2. 经 `MsgContext` / embedded runner 参数传入本次 run。
3. `src/agents/pi-embedded-runner/run/attempt.ts` 创建并包装 `SessionManager`。
4. `src/agents/session-tool-result-guard-wrapper.ts` 的 `transformMessageForPersistence` 在 user message 落盘前添加私有 `__openclaw.attachments`。
5. `src/agents/session-tool-result-guard.ts` 通过原始 `SessionManager.appendMessage` 写入，保留 Pi 的 `parentId` 链。

`inputProvenance` 已使用同一链路给 user message 增加扩展字段，证明该候选具有代码基础。Spike 不再是无方向探索，而是聚焦三个未决风险（任一项无法稳定保证即判 FAIL）：

1. refs 只被消费一次，不会错误附加到 steer queue、pending token 或后续 user message。
2. `__openclaw` 不进入 provider 请求。
3. process restart、session reload、compaction 后引用仍存在。

### Gate Pass Conditions

必须同时满足：

1. 使用 Gateway 或 pi 的稳定公开接口，或仓库内明确归属且可测试的持久化扩展点。
2. 不依赖 message_end listener 注册顺序或共享对象原位修改。
3. 不使用 patch-package。
4. 不建立 sidecar 顺序或文本匹配。
5. chat.send 的纯附件、文本加附件、混合附件都能持久化正确 ID 和 ordinal。
6. 进程重启、session reload 和 compaction 后引用仍存在。
7. provider 请求与 agent trace 事件负载均不包含 \_\_openclaw。
8. 飞书等非 WebChat 渠道在无 refs 时完全 no-op。
9. 写入失败时消息发送仍可继续，history 可由 marker 回退恢复，不产生半结构化错误字段。
10. 相关行为能够通过仓库测试稳定复现，不能只依赖一次人工成功。

### Gate Fail Conditions

出现任一条件即判定失败：

1. 只能在 pi message_end 事件中修改共享对象并依赖 appendMessage 时序。
2. 必须维护外部包补丁。
3. 只能通过无稳定 message ID 的 sidecar 关联。
4. compaction、steer queue、pending token 或 session reload 会丢引用。
5. 自定义字段可能进入 provider 或其他渠道。
6. 无法写出确定性的自动化落盘测试。

### Gate Timebox and Adjudication

1. Spike 总投入不超过 2 个工作日，含自动化落盘测试的编写时间。
2. 任一 Gate Fail Condition 被验证后立即判 FAIL，无需耗完时间盒。
3. 截止时必须同时具备全部 10 条 Pass Conditions 的自动化证据和书面 Gate Result；缺少任一项、证据有歧义或未获明确 PASS 批准，均默认 FAIL。
4. 角色分工：Spike 实施负责人提交测试、依赖版本、执行结果和结论；项目技术负责人做最终 PASS/FAIL 批准。
5. 超时未获 PASS 批准时，自动进入 Marker Fallback Branch。
6. 默认 FAIL 是安全方向：现有代码已具备固定 path 与 UUID 提取基础（chat.ts 的 WEBCHAT_INPUT_ARTIFACT_PATH_RE），Marker Fallback 剩余改动（通用附件扫描、开头行约束）边界明确且可测试。

### Gate Result

**裁决：PASS（2026-08-04，项目技术负责人已显式批准）。执行 Structured Ref Branch，Marker Fallback 仅作为兼容回退。**

自动化证据：

1. `chat.send` 的纯附件、文本加附件和混合附件均把有序 `{attachmentId, ordinal}` 传入本次 run。
2. refs 经仓库自有的 `transformMessageForPersistence` 同步写入对应 user message；不依赖 listener、共享对象原位修改、patch-package 或 sidecar 匹配。
3. 新 `SessionManager` reload、独立 Node 进程重载及 compaction 后，transcript 中的结构化引用仍存在。
4. refs 只消费一次；steer/后续 user message 不继承；无 refs 的非 WebChat run 完全 no-op。
5. session reload 后再次请求模型时，provider context 与 agent trace generation input 均不含 `__openclaw` 或 attachment ID。
6. 私有引用预处理失败时 user message 仍正常落盘，既有 media marker 保留且不产生半结构化字段，可由 marker fallback 恢复。
7. OpenClaw 目标测试、`tsc --noEmit`、oxlint、oxfmt 均通过；agent-server Phase 0 目标测试 54 项通过且 Ruff 通过。
8. 仓库部署配置启用 Langfuse，未显式覆盖时 `captureMode=llm_text`；自动化测试按更强的完整 generation input 检查脱敏。线上宿主机运行态仍由部署方在发布前确认。

未采用 Marker Fallback 作为主路径，因为稳定、同步、可测试的 transcript 扩展点已经验证成立；保留 marker annotation 只用于旧消息、分阶段发布和结构化字段异常时回退。

## Architecture Changes

### Common Changes

| 仓库和文件                                                                  | 变更                                       | 结果                      |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------- |
| agent-server/app/services/openclaw_artifact_service.py                      | 保留 INPUT 原对象，增加 history enrichment | 字节和元数据可回放        |
| agent-server/app/common/ports/repository/db/openclaw_artifact_repository.py | 增加受限批量查询 port                      | BFF 不做 N+1              |
| agent-server/app/infra/repository/db/openclaw_artifact_repository.py        | 实现完整 binding scope 查询                | 数据库承担归属过滤        |
| agent-server/app/services/openclaw_bridge_request_service.py                | chat.history 翻译前执行 enrichment         | translator 保持纯函数     |
| agent-server/app/services/openclaw_protocol_translator.py                   | 子会话剥离 \_\_openclaw                    | 私有引用不泄漏            |
| agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts                | 严格解析通用四字段 attachments             | 图片和文件统一协议        |
| agent-frontend/src/features/openclaw-bff/types/chat.ts                      | 分离发送引用和展示元数据                   | 即时态与 history 类型明确 |
| agent-frontend/src/features/openclaw-bff/components/chat/\*                 | 增加画廊、文件卡和失败降级                 | 正确展示附件              |
| agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts              | 乐观 run 保存附件元数据                    | 发送后立即显示            |

### Outbound `__openclaw` Invariant（两分支共同不变量）

Gateway 出站 history 的 `__openclaw` **永远由 Gateway 自行构造，绝不透传 transcript 原始字段**。核验依据：`readSessionMessages`（`src/gateway/session-utils.fs.ts`）是 `messages.push(parsed.message)` 整条原样推入、无字段白名单，后续 `sanitizeChatHistoryMessage` 与 `annotateChatHistoryAttachmentReferences` 又是 `{...entry}` 展开保留未知字段——所以"transcript 有 `__openclaw` 就会流到 BFF"目前只是碰巧成立，必须由构造保证：

- Structured Ref Branch：校验 refs 后**重建** `__openclaw.attachments`，不透传原始字段。
- Marker Fallback Branch：无条件**删除** transcript 原始 `__openclaw`，再按 marker 填充。

这样即使 Spike 隔离失效或 transcript 残留旧字段，出站兼容性也由构造保证，而不是靠下游白名单。

### Structured Ref Branch

| 仓库和文件                                                      | 变更                                           | 结果                   |
| --------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| agent-server/app/services/openclaw_artifact_service.py          | resolved workspace_file 保留 attachmentId      | Gateway 收到稳定 ID    |
| openclaw-integration/src/gateway/protocol/schema/attachments.ts | workspace_file 接受可选 attachmentId           | 支持分阶段发布         |
| openclaw-integration/src/gateway/chat-attachments.ts            | 生成有序私有 refs                              | 显示引用与模型输入分离 |
| Phase 0 确认的稳定写入文件                                      | 把私有 refs 写入对应用户 transcript 条目       | 新消息不依赖 path 正则 |
| openclaw-integration/src/gateway/server-methods/chat.ts         | history 优先读取结构化 refs，缺失时使用 marker | 主路径稳定且可回退     |

### Marker Fallback Branch

| 仓库和文件                                              | 变更                                   | 结果               |
| ------------------------------------------------------- | -------------------------------------- | ------------------ |
| openclaw-integration/src/gateway/chat-sanitize.ts       | 抽出消息开头 media marker 共享扫描器   | 解析与删除边界一致 |
| openclaw-integration/src/gateway/server-methods/chat.ts | 从固定 WebChat path 恢复 ID 和 ordinal | 图片和文件均能恢复 |

## Implementation Steps

### Phase 0: Common Prerequisite and Spike

1. **保留 INPUT OSS 原对象**
   - File: agent-server/app/services/openclaw_artifact_service.py
   - Action: 从 OpenClawArtifactService.complete_input() 删除 READY 后立即 storage.delete()。沿用 ready_retention_seconds（本期全局默认调为 180 天，见 Assumption 10），由 cleanup_expired() 统一删除。READY INPUT 不再占用每会话 active artifact 配额，避免 retention 窗口内累计 50 个附件后阻塞后续上传；READY OUTPUT 的既有配额语义保持不变。
   - Why: history 图片和文件需要在 retention 窗口内下载。
   - Dependencies: None
   - Complexity: S
   - Risk: Medium。OSS 占用增加，cleanup 正常时不引入永久字节保留；**显式依赖**：保留窗口成立的前提是 bff_server 进程存活且 cleanup_expired() loop 在跑，若 bff_server 长期不跑则"保留 180 天"退化为无限增长（见 Observability 与 OSS 成本回滚）。

2. **补齐 INPUT download 回归测试**
   - Files:
     - agent-server/app/test/unit_test/services/test_openclaw_artifact_service.py
   - Action: 现有 download_url() 链路已不限制 direction、不限制 INPUT/OUTPUT，按 ID 查询后执行 principal_id、target_kind、target_id、client_session_id 四维 scope 校验并要求 READY，因此 retained INPUT 可经同一登录态 endpoint 下载，Phase 0 无需扩展下载实现。只需补回归断言：
     1. `complete_input()` 完成后不再调用 `storage.delete()`。
     2. `READY + INPUT` 能经 download_url() 生成下载 URL。
     3. `PENDING/MATERIALIZING INPUT` 仍被 download 拒绝。
     4. retained INPUT 到期后仍由 cleanup_expired() 删除。
   - Why: 当前缺口在测试覆盖，不在实现能力。落实此断言后，历史附件可下载这条验收线在 Phase 0 不再留隐藏缺口。
   - Dependencies: Step 1
   - Complexity: S
   - Risk: Low

3. **验证稳定 transcript 引用写入点**
   - Files:
     - openclaw-integration/src/agents/pi-embedded-runner/run/attempt.ts
     - openclaw-integration/src/agents/pi-embedded-runner/run/steer-queue.ts
     - openclaw-integration/src/gateway/chat-attachments.ts
     - openclaw-integration/src/agents/session-tool-result-guard-wrapper.ts
     - openclaw-integration/src/agents/session-tool-result-guard.ts
   - Action: 按 Gate Pass Conditions 验证 Spike Candidate（见 Architecture Decision Gate）。验证路径是 chat.send 提取 refs → MsgContext/embedded runner 传入 → attempt.ts 包装 SessionManager → session-tool-result-guard-wrapper.transformMessageForPersistence 在 user message 落盘前写入 `__openclaw.attachments` → session-tool-result-guard 经原始 appendMessage 写入并保留 parentId 链。只写 attachmentId 和 ordinal。
   - Why: 结构化引用能消除 marker 正则主路径，但不能建立在未公开事件顺序上。该候选已有 inputProvenance 先例，Spike 聚焦三个未决风险（refs 单次消费、provider 不泄漏、restart/reload/compaction 存活）。
   - Dependencies: None
   - Complexity: M
   - Risk: High。候选有代码基础，但三个风险点仍需确定性自动化验证。

4. **记录 Gate 结果**
   - File: openclaw-integration/docs/plans/2026-07-23-webchat-image-message-gallery.md
   - Action: 记录 PASS 或 FAIL、证据、选择分支和未采用路径。PASS 时先修订 ADR-0004 与 CONTEXT.md；FAIL 时删除 Structured Ref Branch 的实施任务。
   - Why: 后续实现只能有一个主路径。
   - Dependencies: Step 3
   - Complexity: S
   - Risk: Low

5. **确认 trace 暴露面（Structured Ref 限定）**
   - Action: 向部署方确认 gateway 宿主机的 Langfuse 启用状态与 captureMode，作为 `__openclaw` 是否可能进入 trace 事件的风险定级输入。此约束只针对 Structured Ref Branch；Marker Fallback 不往 transcript 写任何新字段，无此暴露。
   - Why: Gate Pass Condition 7 已扩写为"provider 请求与 agent trace 事件负载均不包含 `__openclaw`"，需要知道实际 captureMode 才能判定测试是否覆盖真实暴露面。
   - Dependencies: None
   - Complexity: S
   - Risk: Low

### Phase 1: agent-server Common Security Boundary

1. **增加受限批量查询**
   - Files:
     - agent-server/app/common/ports/repository/db/openclaw_artifact_repository.py
     - agent-server/app/infra/repository/db/openclaw_artifact_repository.py
   - Action: 新增 list_input_by_ids_for_binding()，参数包含 artifact_ids、session_ref、principal_id、target_kind、target_id、client_session_id；SQL 同时过滤 direction = INPUT，不按 lifecycle status 过滤。
   - Why: 对象过期后仍可显示数据库元数据，download 状态由 endpoint 独立判断。
   - Dependencies: Phase 0 Step 1
   - Complexity: M
   - Risk: High。任何 scope 条件遗漏都会泄漏元数据。

2. **实现 history enrichment**
   - File: agent-server/app/services/openclaw_artifact_service.py
   - Action:
     - 新增 enrich_chat_history_attachments(binding, payload)。
     - 只解析用户消息的 \_\_openclaw.attachments。
     - 对每条原始消息先删除顶层 `attachments` 和完整 `__openclaw`；禁止把 Gateway/transcript 的公开附件元数据当作已授权数据。
     - 单消息最多 16 个候选，整次 history 最多 256 个唯一 ID。
     - 一次批量查询并按 message 与 ordinal 恢复顺序。
     - 使用数据库字段生成精确四字段 attachments。
     - 只有数据库命中的 artifact 才写回顶层 `attachments`；无 refs、零命中、部分命中、查询异常和 artifact service 缺失时保持 fail closed。
     - 所有执行路径删除 \_\_openclaw。
   - Why: Gateway 引用只用于定位，BFF 才是公开授权边界。
   - Dependencies: Step 1
   - Complexity: L
   - Risk: High。必须覆盖 malformed、duplicate、partial match 和 cleanup。

3. **接入 chat.history**
   - Files:
     - agent-server/app/services/openclaw_bridge_request_service.py
     - agent-server/app/services/openclaw_protocol_translator.py
   - Action:
     - OpenClawBridgeRequestService.execute() 在 translate_response() 前，仅对父会话 chat.history 调用 enrichment。
     - artifact service 不可用时删除顶层 `attachments` 和 \_\_openclaw。
     - 子会话翻译分支把 \_\_openclaw 加入私有字段剥离集合。
   - Why: 数据库 I/O 留在异步 application service，纯 translator 不承担查询。
   - Dependencies: Step 2
   - Complexity: M
   - Risk: High。顺序错误会泄漏私有引用。

4. **补充 agent-server 测试**
   - Files:
     - agent-server/app/test/unit_test/services/test_openclaw_artifact_service.py
     - agent-server/app/test/unit_test/services/test_openclaw_bridge_request_service.py
     - agent-server/app/test/unit_test/services/test_openclaw_protocol_translator.py
     - agent-server/app/test/unit_test/infra/repository/test_openclaw_artifact_repository.py
   - Action: 覆盖 retention、单次批量查询、七维 scope、顺序、上限、部分命中、空服务和父子会话私有字段清理；新增伪造顶层 `attachments` 在无 refs、零命中、部分命中、查询异常和 artifact service 缺失时均被删除的回归测试。
   - Dependencies: Steps 1 to 3
   - Complexity: M
   - Risk: Low

### Phase 2A: Structured Ref Branch

仅在 Phase 0 Gate PASS 后执行。

1. **保留发送引用**
   - File: agent-server/app/services/openclaw_artifact_service.py
   - Action: resolve_chat_attachments() 的 workspace_file descriptor 增加 attachmentId，同时保持现有 fileName、mimeType、workspacePath、sizeBytes、sha256。
   - Why: Gateway 需要稳定 ID，不能从 path 反解析。
   - Dependencies: Phase 0 PASS
   - Complexity: S
   - Risk: Low。BFF 已在同一方法完成 INPUT scope 校验。

2. **扩展 Gateway workspace_file schema**
   - Files:
     - openclaw-integration/src/gateway/protocol/schema/attachments.ts
     - openclaw-integration/src/gateway/server-methods/attachment-normalize.ts
     - openclaw-integration/src/gateway/chat-attachments.ts
   - Action:
     - workspace_file 接受可选 attachmentId，保持旧 BFF descriptor 兼容。
     - attachment-normalize 透传可选 attachmentId（当前实现静默丢弃未知字段）。
     - 对带 attachmentId 的 WebChat descriptor 做格式和数量校验。
     - 生成有序私有 refs，不生成 kind 或公开元数据。
   - Why: workspace_file schema 为 additionalProperties: false，旧 Gateway 会以 INVALID_REQUEST 拒绝带 attachmentId 的 chat.send；optional 字段让旧 BFF descriptor 继续合法，因此 Gateway 必须先于 agent-server 的 attachmentId 发射上线。
   - Dependencies: Phase 0 PASS；部署先于 agent-server 的 attachmentId 发射
   - Complexity: M
   - Risk: Medium。不能把 inline/base64 附件伪装成可下载 artifact。

3. **写入 transcript 私有引用**
   - File: Phase 0 确认的稳定写入扩展点
   - Action: 把 refs 写到对应用户消息的 \_\_openclaw.attachments；无 WebChat refs 时完全 no-op。
   - Why: 新消息使用结构化关联，显示链路不依赖文本格式。
   - Dependencies: Step 2 and Phase 0 PASS
   - Complexity: M
   - Risk: High。必须保持 provider 与非 WebChat 渠道隔离。

4. **history 优先读取结构化 refs**
   - File: openclaw-integration/src/gateway/server-methods/chat.ts
   - Action:
     - 校验 transcript 私有 refs。
     - 复制消息后先删除 transcript 原始顶层 `attachments` 和原始 `__openclaw`，再按结构化 refs 或 marker fallback 重建唯一候选命名空间。
     - 有合法 refs 时直接作为 Gateway to BFF candidates。
     - refs 缺失时调用 marker fallback。
     - 继续删除 inline image Base64、media marker 和 envelope。
     - 私有 refs 计入单消息与最终 history budget。
   - Why: 新消息使用稳定主路径，异常和分阶段发布仍可恢复。
   - Dependencies: Step 3
   - Complexity: M
   - Risk: Medium

5. **补充 Structured Ref 测试**
   - Files:
     - openclaw-integration/src/gateway/chat-attachments.test.ts
     - openclaw-integration/src/gateway/server.chat.gateway-server-chat-b.test.ts
     - Phase 0 写入扩展点对应测试
   - Action: 覆盖纯附件、混合附件、顺序、重启、reload、compaction、无 refs no-op、provider 不泄漏、结构化优先和 marker fallback；新增 transcript 伪造顶层 `attachments` 必须被删除的出站回归测试。必须额外覆盖一条 trace 隔离断言：`captureMode: "full"` 下断言 generation start 事件的 input 不含 `__openclaw`，且 **session reload 之后再发一轮再断言**——Spike Candidate 在 `transformMessageForPersistence` 落盘时加字段，当前 run 内存对象不带它，reload 后才带，不 reload 测不出来（与 Gate Pass Condition 6 reload 后引用仍存在是同一事实的两面）。
   - Dependencies: Steps 1 to 4
   - Complexity: L
   - Risk: Low

### Phase 2B: Marker Fallback Branch

仅在 Phase 0 Gate FAIL 后执行。

1. **统一扫描 media marker**
   - Files:
     - openclaw-integration/src/gateway/chat-sanitize.ts
     - openclaw-integration/src/gateway/chat-sanitize.test.ts
   - Action: 抽出 scanLeadingInboundMediaPrompt()，返回开头连续 media lines 和清理后的正文；现有 strip 复用同一扫描结果。
   - Why: 附件解析和文本清理必须共享边界。
   - Dependencies: Phase 0 FAIL
   - Complexity: M
   - Risk: Medium

2. **恢复通用附件引用**
   - File: openclaw-integration/src/gateway/server-methods/chat.ts
   - Action:
     - 用 extractChatHistoryAttachmentRefs() 替换 image-only extractor。
     - 只扫描开头 media lines 中固定 uploads/webchat 路径。
     - 只提取当前 UUID attachmentId，不解析 safeName 或 marker MIME。
     - 按出现顺序生成 ordinal，单消息最多 16 个。
     - sanitize 前挂到 \_\_openclaw.attachments。
   - Why: 图片和非图片使用同一候选协议。
   - Dependencies: Step 1
   - Complexity: M
   - Risk: Medium。ID 生成规则变化时必须 fail closed。

3. **补充 Marker Fallback 测试**
   - Files:
     - openclaw-integration/src/gateway/server.chat.gateway-server-chat-b.test.ts
     - openclaw-integration/src/gateway/chat-sanitize.test.ts
   - Action: 覆盖单图、多图、Markdown、TXT、PDF、混合、重复 ID、正文伪造、特殊文件名、Base64 清理和 history budget。
   - Dependencies: Steps 1 and 2
   - Complexity: M
   - Risk: Low

### Phase 3: agent-frontend Unified Rendering

1.  **分离发送引用和展示 DTO**
    - Files:
      - agent-frontend/src/features/openclaw-bff/types/chat.ts
      - agent-frontend/src/features/openclaw-bff/api/attachments.ts
    - Action:
      - OpenClawChatAttachment 保持 chat.send 传输引用。
      - ChatMessageAttachment 增加 sizeBytes。
      - attachments.complete 完整消费 fileName、contentType、sizeBytes。
      - chat.send 请求边界显式只发送 type 和 attachmentId。
    - Why: 即时态需要元数据，Gateway 传输只需要引用。
    - Dependencies: Phase 1
    - Complexity: M
    - Risk: Medium

2.  **解析通用 history attachments**
    - Files:
      - agent-frontend/src/features/openclaw-bff/api/chat-mappers.ts
      - agent-frontend/tests/openclaw-chat-mappers.test.ts
    - Action: 新增 parseHistoryAttachments()，严格验证四字段、长度、sizeBytes 非负和数组上限；删除 omitted image block 作为新协议的依赖。
    - Why: 非图片没有 image block，展示必须读取消息级 attachments。
    - Dependencies: Step 1
    - Complexity: M
    - Risk: Low

3.  **补齐乐观态和纯附件发送**
    - Files:
      - agent-frontend/src/features/openclaw-bff/types/chat.ts
      - agent-frontend/src/features/openclaw-bff/hooks/useOpenClawChat.ts
      - agent-frontend/src/features/openclaw-bff/state/chat-reducer.ts
      - agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx
      - agent-frontend/tests/openclaw-chat-reducer.test.ts
    - Action:
      - ChatLiveRunUserMessage 和 SEND_STARTED 携带附件展示元数据。
      - 发送后立即显示附件。
      - Reconcile 采用统一复合签名匹配键：

            normalizedText + orderedAttachmentIds

        三种消息走同一算法：纯文本 `normalizedText + []`，纯附件 `"" + [attachmentId...]`，混合消息 `normalizedText + [attachmentId...]`。扩展 `ChatLiveRunUserMessage` 保存有序 attachmentIds，并让 `matchRunWindow()` 同时满足：附件 ID 序列精确相等、文本按现有规范化规则比较；完全相同的复合签名重复出现时，继续依靠 `historyFence + ordered-consume` 按顺序消费。不选“仅附件 ID 序列”：纯文本消息的附件序列都是空数组，无法形成有效匹配键，且同一附件重新发送但文字不同会误匹配。不选 frontRunId 映射：该值不进入 history，Marker Fallback 无法恢复，改动与收益不成比例。

      - Composer 和 sendMessage 只在文本与附件同时为空时拒绝。
      - 活跃 run 期间带附件消息进入队列，drain 后使用 chat.send。

    - Why: 消除发送到 history 落盘之间的展示断档。复合签名覆盖纯附件无文本与混合消息相同文本两类歧义。
    - Dependencies: Steps 1 and 2
    - Complexity: L
    - Risk: High。需要覆盖 FIFO queue、resume 和 ambiguous send。

4.  **抽出统一附件组件**
    - Files:
      - agent-frontend/src/features/openclaw-bff/components/chat/UserAttachmentList.tsx
      - agent-frontend/src/features/openclaw-bff/components/chat/MessageImageGallery.tsx
      - agent-frontend/src/features/openclaw-bff/components/chat/MessageFileCard.tsx
      - agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.tsx
    - Action:
      - 保持原数组顺序。
      - 将用户附件判定拆为 `isPreviewableUserImage(mimeType)`，只接受四种 raster MIME；不得按文件扩展名或 `application/octet-stream` 回退。
      - assistant OUTPUT artifact 如需兼容历史 `application/octet-stream + 图片扩展名`，使用独立 `isPreviewableArtifactImage(fileName, mimeType)`，禁止用户消息调用。
      - 用户附件 raster allowlist 进入图片缩略入口和 lightbox。
      - 其他 MIME 进入 MessageFileCard。
      - 用户消息图片使用 download URL 加载原图，但消息内只展示 `52px × 52px`、`object-cover` 的缩略入口；多附件保持数组顺序并横向换行。
      - 本期 lightbox UI 规则：
        1. 点击缩略入口打开 modal lightbox，最大内容宽度 `820px`、图片最大高度 `70vh`，使用 `object-contain` 保持原始比例。
        2. modal 打开后锁定 body 滚动，焦点进入关闭按钮；支持 `Escape`、Tab 焦点环和关闭后焦点恢复。
        3. backdrop 和关闭按钮均可关闭；下载按钮在新标签页打开同一鉴权下载 URL。
        4. 消息缩略图加载失败时只降级一次为同一附件文件卡，保留文件名和下载入口。
        5. 图片以文件名作为 `alt`，缩略入口使用可访问按钮和明确 `aria-label`。
        6. 不新增 preview endpoint、服务端缩略图、rendition、缩放或图片编辑；浏览器仍加载原图字节。
      - onError 只降级一次到同一附件文件卡。
      - artifactScope 不完整时保留不可下载文件卡。
    - Why: 当前 UserMessage 把全部附件当图片，且职责过大。Human 已选择保留 lightbox；本期冻结现有可访问 modal 行为，不扩展为服务端 preview/rendition。
    - Dependencies: Steps 1 to 3
    - Complexity: L
    - Risk: Medium

5.  **补充前端测试**
    - Files:
      - agent-frontend/src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx
      - agent-frontend/src/features/openclaw-bff/adapters/OpenClawWorkspaceAttachmentAdapter.test.ts
      - agent-frontend/src/features/openclaw-bff/api/attachments.test.ts
      - agent-frontend/tests/openclaw-chat-mappers.test.ts
      - agent-frontend/tests/openclaw-chat-reducer.test.ts
    - Action: 覆盖即时态、history、图片与文件分流、纯附件、混合顺序、scope 缺失、图片失败、lightbox 打开/关闭/焦点恢复/Escape/Tab/下载和 reconcile；用户附件增加 `application/octet-stream + .png`、`text/html + .png`、SVG、HEIC 均保持文件卡的严格 MIME 负例。assistant OUTPUT artifact 的扩展名回退必须使用独立函数和独立测试。其中 reconcile 冲突测试用两条有意义的断言（核验发现：init_input 每次用 `gen_id` 生成 UUID v4，无 sha256 去重，因此"两 Tab 发同一文件"得到不同 attachmentId，附件签名构造上唯一，比今天的纯文本匹配可区分度更强）：
      1. 两 Tab 并发发同一文件 → 断言各自拿到不同 attachmentId、乐观态精确匹配、互不串台。
      2. 同签名重复（纯文本相同，或同一 attachmentId 集合重发）→ 断言由 historyFence + ordered-consume 按序消费。
         另记录一条与附件无关的既有行为（本期不修）：matchRunWindow 遇第一条不匹配的 user item 即 break，若另一个 Tab 的消息落在本 Tab fence 与自身消息之间，本轮匹配失败、乐观态滞留到下次 reconcile——这在今天纯文本场景已存在。
    - Dependencies: Steps 1 to 4
    - Complexity: L
    - Risk: Low

### Phase 4: Integration and Deployment

1. **同一维护窗口三步发布**
   - Action:
     1. 先发布 Gateway：workspace_file 接受可选 attachmentId、attachment-normalize 透传，以及 Gate 选定 branch 的 history 逻辑；descriptor 无 attachmentId 时 refs 写入 no-op，history 走 marker fallback。
     2. 再发布 agent-server：INPUT retention、history enrichment、\_\_openclaw 强制清理与 attachmentId 发射一次上线。
     3. 最后发布前端通用 mapper、画廊和文件卡。
   - Why: workspace_file schema 为 additionalProperties: false，旧 Gateway 会拒绝带 attachmentId 的 chat.send，因此 Gateway 必须先行。代价是窗口内旧 BFF 对 \_\_openclaw（仅 attachmentId 与 ordinal）的短暂透传，首发同窗口场景下已显式接受。Marker Fallback Branch 下无 schema 约束，Gateway 与 agent-server 顺序可互换，但同窗口内按同一顺序执行即可。
   - Dependencies: Phases 0 to 3
   - Complexity: S
   - Risk: High

2. **执行端到端验收**
   - Action: 完成上传、发送、刷新、重新进入、下载和越权负例；Structured Ref Branch 还需检查 transcript 引用和 marker fallback。
   - Dependencies: Step 1
   - Complexity: M
   - Risk: Medium

3. **确认回滚**
   - Action:
     - 前端可独立回滚，文本保持可见。
     - Gateway 回滚后 BFF 收不到候选，文本仍正常。
     - agent-server enrichment 保留时会安全忽略不存在的候选。
     - INPUT retention 最后回滚；保留到既有 cleanup 不影响协议。
   - Dependencies: Step 1
   - Complexity: S
   - Risk: Low

## Observability

全部复用现有 structlog 结构化日志，不引入新指标系统：

1. **enrichment 健康**：enrich_chat_history_attachments() 记一条结构化计数事件，字段 `candidate_count / resolved_count / dropped_count / truncated_count`，不含 attachmentId、文件名等敏感字段（其中 truncated_count 即 Security Req 4 已要求的超限截断计数，统一到这一事件）。部分命中率由日志聚合得到。
2. **marker fallback 双路径**：Gateway 每次 history 记 `structured_ref_messages / marker_fallback_messages` 计数。这是判断 Structured Ref 是否真正成为主路径的唯一信号，也是 Risk 10 "稳定观察期结束后评估删除 marker" 所依赖的证据——没有它，那条 mitigation 无法执行。
3. **`__openclaw` 泄漏**：不设线上监控。这是安全不变量，等运行时告警响应时已经泄漏，因此左移到测试（父子会话剥离测试 + BFF 出站响应兜底断言），不依赖线上观测。
4. **INPUT OSS 存量**：复用现有 `openclaw_artifact_cleanup{claimed_count}` 指标。**显式依赖**：保留窗口成立的前提是 bff_server 进程存活且 cleanup_expired() loop 在跑；bff_server 长期不跑时"保留 180 天"退化为无限增长，触发 OSS 成本回滚（见 Risks 第 5 条）。

## Testing Strategy

### Phase 0 Spike Tests

Structured Ref Gate 必须提供：

1. chat.send 纯附件、文本加附件和混合附件落盘断言。
2. 进程重启与 session reload 后引用仍存在。
3. compaction 前后的 history 引用一致。
4. provider 请求与 agent trace 事件负载均不含 \_\_openclaw。
5. 非 WebChat run 无额外字段。
6. refs 单次消费：带附件 user message 的 refs 不会错误附加到 steer queue、pending token 或后续 user message（Spike Candidate 风险 1）。
7. 写入失败时 marker fallback 仍能恢复。

### Unit Tests

agent-server：

    uv run python -m pytest -q \
      app/test/unit_test/services/test_openclaw_artifact_service.py \
      app/test/unit_test/services/test_openclaw_bridge_request_service.py \
      app/test/unit_test/services/test_openclaw_protocol_translator.py \
      app/test/unit_test/infra/repository/test_openclaw_artifact_repository.py

openclaw-integration：

    pnpm vitest run \
      src/gateway/chat-attachments.test.ts \
      src/gateway/server.chat.gateway-server-chat-b.test.ts \
      src/gateway/chat-sanitize.test.ts

agent-frontend：

    npm run test:unit
    npm run test:components -- \
      src/features/openclaw-bff/components/chat/OpenClawAssistantThread.test.tsx \
      src/features/openclaw-bff/adapters/OpenClawWorkspaceAttachmentAdapter.test.ts \
      src/features/openclaw-bff/api/attachments.test.ts

### Static Verification

openclaw-integration：

    pnpm exec oxfmt --check \
      src/gateway/chat-attachments.ts \
      src/gateway/chat-sanitize.ts \
      src/gateway/server-methods/chat.ts

agent-frontend：

    npm run type-check
    npm run lint
    npm run build

agent-server：

    uv run ruff check \
      app/services/openclaw_artifact_service.py \
      app/services/openclaw_bridge_request_service.py \
      app/services/openclaw_protocol_translator.py \
      app/common/ports/repository/db/openclaw_artifact_repository.py \
      app/infra/repository/db/openclaw_artifact_repository.py

### Integration Matrix

| 场景                           | 当前消息     | 刷新       | 重新进入   | 下载     |
| ------------------------------ | ------------ | ---------- | ---------- | -------- |
| 单 PNG                         | 原图内联     | 仍显示     | 仍显示     | 成功     |
| 多图                           | 顺序画廊     | 顺序一致   | 顺序一致   | 成功     |
| 单 Markdown                    | 文件卡       | 文件卡     | 文件卡     | 成功     |
| TXT 和 PDF                     | 文件卡       | 文件卡     | 文件卡     | 成功     |
| 图片加 Markdown                | 混合顺序一致 | 一致       | 一致       | 成功     |
| 纯附件                         | 可发送       | 可恢复     | 可恢复     | 成功     |
| 空格、Unicode、特殊字符文件名  | DB 原名      | DB 原名    | DB 原名    | 成功     |
| 图片解码失败                   | 文件卡降级   | 文件卡降级 | 文件卡降级 | 明确失败 |
| 伪造其他 scope 的 attachmentId | 不显示附件   | 不显示附件 | 不显示附件 | 404      |

负例边界：history（不显示附件）负例覆盖七维 scope（含 session_ref 与 direction）；download（404）负例限定 principal_id、target_kind、target_id、client_session_id 四维加非 READY 状态，不含 session_ref 与 direction。

### Required Manual Acceptance

1. 上传 PNG → 发送 → 当前消息显示 52px 缩略入口 → 点击打开 lightbox → 刷新 → 重新进入 → 缩略入口和 lightbox 仍可用且可下载。
2. 上传 Markdown → 发送 → 当前消息文件卡 → 刷新 → 重新进入 → 文件名、text/markdown、大小和下载入口仍存在。
3. 混合上传 PNG、Markdown、TXT、PDF，刷新前后顺序一致。
4. lightbox 支持 backdrop、关闭按钮、Escape、Tab 焦点环、关闭后焦点恢复和新标签页下载；图片加载失败只降级一次为文件卡。
5. history WebSocket payload 不含 Base64、workspace path、object key、长期 URL、原始顶层 `attachments` 和 \_\_openclaw；BFF 仅返回数据库命中的公开四字段 `attachments`。
6. history 负例：使用不同 principal、target、client session、session_ref 和 direction 的 attachmentId，BFF 均不返回附件；伪造 transcript/Gateway 顶层 `attachments` 在无 refs、零命中、部分命中和查询失败时均不进入浏览器。download 负例：principal、target_kind、target_id、client_session_id 任一不匹配或非 READY 时明确失败；session_ref 与 direction 不属于 download 校验边界，同 scope 的 OUTPUT artifact 保持可下载。
7. Structured Ref Branch：新消息优先命中结构化 refs，移除 refs 后同一消息可由 marker fallback 恢复。
8. 将 PNG 文件分别声明为 `application/octet-stream` 和 `text/html`，用户消息中均显示文件卡；SVG、HEIC 和未知 MIME 也不得进入 lightbox。

## Edge Cases

1. history 没有 messages 或结构不合法：保持文本响应并清理私有字段。
2. 同一 attachmentId 重复：只保留第一次。
3. 部分 artifact 过期或删除：仍显示数据库元数据，download 返回明确状态。
4. media marker 有总数行但缺少明细：不生成虚构附件。
5. marker 包含 URL、MIME、空格或特殊字符：只提取固定 path 中的 UUID。
6. 正文中段出现类似 marker：不解析。
7. 结构化 refs 与 marker 顺序不同：结构化 refs 优先，不合并。
8. transcript 私有 refs malformed：忽略结构化字段并尝试 marker fallback。
9. artifactScope 缺失：显示不可下载文件卡。
10. 图片 MIME 合法但解码失败：只触发一次文件卡降级。
11. 候选超限：截断保序并记录计数，文本不丢失。
12. artifact ID 生成规则变化：marker parser fail closed；先更新结构化载体或重新评估 link。

## Risks and Mitigations

1. **Risk: Phase 0 把一次可运行误判为稳定接口**
   - Mitigation: Gate 禁止 listener 时序、共享对象修改和 patch-package，要求重启、reload、compaction 与自动化测试全部通过。

2. **Risk: BFF scope 查询遗漏条件**
   - Mitigation: repository SQL 同时过滤七个维度，每个维度提供独立负例。

3. **Risk: transcript 元数据进入 provider 或其他渠道**
   - Mitigation: 只写私有 ID 引用，增加 provider snapshot 和非 WebChat no-op 测试；任何泄漏使 Gate FAIL。

4. **Risk: marker parser 把正文当附件**
   - Mitigation: 只扫描开头连续 media lines 和固定 WebChat path，BFF 再做完整 scope 校验。

5. **Risk: INPUT 对象保留增加 OSS 存储**
   - Mitigation: READY INPUT 不占用 active artifact 配额，生命周期只由 ready_retention_seconds（本期全局默认 180 天）和 cleanup_expired() 管理。**显式依赖**：cleanup 正常时不引入永久字节保留；bff_server 长期不跑时保留退化为无限增长。设成本回滚触发条件：retained INPUT OSS 存量超过阈值或 cleanup 滞后超过窗口时，先回滚 INPUT retention 改动（complete_input 恢复立即删除），文本与元数据展示不受影响。具体阈值由部署方按 OSS 配额填入，不在计划硬编码。

6. **Risk: 纯附件支持破坏 reconcile**
   - Mitigation: 使用有序 attachmentId 集合匹配，覆盖 FIFO、resume 和 ambiguous send。

7. **Risk: 前端内联危险内容**
   - Mitigation: 用户附件只允许四种 raster MIME；SVG、HTML、`application/octet-stream` 和未知类型始终使用文件卡。assistant OUTPUT artifact 的扩展名兼容逻辑与用户消息函数和调用面完全分离。

8. **Risk: 三仓短暂协议不一致**
   - Mitigation: 同一维护窗口内按 Gateway → agent-server → frontend 连续部署。窗口内旧 BFF 对 \_\_openclaw 的短暂透传仅暴露 attachmentId 与 ordinal（浏览器本就可见的低敏感值），已作为首发风险显式接受；agent-server 上线后由强制清理关闭窗口。

9. **Risk: lightbox 仍加载原图，增加流量、解码和 LCP 成本**
   - Mitigation: 消息缩略入口使用 lazy loading、async decoding 和固定 CSS 尺寸；lightbox 复用同一鉴权 URL，不增加第二套服务端协议。以真实数据决定后续 preview/rendition。

10. **Risk: 同时维护结构化与 marker 两条长期主路径**
    - Mitigation: marker 只作为明确回退；稳定观察期结束后另立任务评估删除，不能并列成为双重事实源。

## Success Criteria

- [ ] Phase 0 有明确 PASS 或 FAIL 结论和自动化证据。
- [ ] PASS 时没有 patch-package、listener 时序或 sidecar 顺序匹配。
- [ ] Gateway 对 BFF 只返回 attachmentId 和 ordinal 私有候选。
- [ ] BFF 每次父会话 history 都按当前 binding 批量校验。
- [ ] 浏览器每个附件只有 attachmentId、fileName、mimeType、sizeBytes。
- [ ] 父会话和子会话 history 均不泄漏 \_\_openclaw。
- [ ] 图片和 Markdown 均完成上传、发送、刷新、重新进入闭环。
- [ ] 图片进入画廊，Markdown、TXT、PDF 等进入文件卡。
- [ ] 用户消息只按四种 raster MIME 进入 52px 缩略入口与可访问 lightbox；非允许 MIME 即使带图片扩展名也进入文件卡。
- [ ] lightbox 的关闭、Escape、焦点环、焦点恢复和新标签页下载通过组件测试与人工验收。
- [ ] 文件卡显示文件名、类型、大小和下载入口。
- [ ] 纯附件和文本加附件均可发送并恢复。
- [ ] INPUT 对象在 retention 窗口内可下载。
- [ ] history enrichment 拒绝跨 principal、target、client session、session_ref 和 direction 的引用；download 按四维 scope 加 READY 拒绝越权。
- [ ] history 不返回 Base64、workspace path、object key 或长期 URL。
- [ ] 未新增数据库表、migration、会话双写或 Message-Artifact Link。
- [ ] 三仓目标测试、静态检查和人工验收全部通过。

## Deferred Work

### Preview and Rendition

本期消息内使用加载原图字节的 52px 缩略入口，lightbox 继续使用同一鉴权 download URL。它不是服务端缩略图或 rendition。出现以下条件后再新增 preview endpoint 和尺寸受限 rendition：

1. 大图下载量或 LCP 超过产品阈值。
2. 产品要求固定像素缩略图、静态 GIF 首帧或禁止浏览器解码原图。
3. 移动网络或多图会话证明原图直出成本不可接受。

未来链路：

    GET /api/v1/openclaw/artifacts/<artifactId>/preview
      -> BFF browser scope authorization
      -> 302 short-lived OSS resize rendition

### Strict Client Instance Download Isolation

当前 download 只做 principal_id、target_kind、target_id、client_session_id 四维 scope 校验加 READY 检查。同一用户、同一 target、同一 clientSession 的不同 client instance 在持有不可猜测 attachmentId（UUID v4）时可以下载，为已知限制。

触发以下任一条件时再立项收紧：

1. 产品或合规要求 client instance 级下载隔离。
2. clientSessionId 不再固定为 main，跨 instance 边界成为真实用户边界。

实施要求：下载请求显式携带 clientInstanceId 或服务端签发的绑定令牌，由服务端解析 binding 后比对；不得直接信任浏览器提交的 session_ref。涉及前端下载 URL、Controller 参数、binding 解析、Service 签名与测试的联动扩展。

### chat.steer Attachments

steer 附件单独立项，原因：

1. 当前运行时只能 queueMessage(text)，不能保证 mid-run inline image 注入。
2. 需要扩展 Gateway schema、BFF translator、queue、resume 和 pending-token。
3. 当前上传、发送和历史回放验收不依赖 steer。

## Decision Summary

1. P1 INPUT 字节保留是共同前置。
2. Phase 0 只验证稳定结构化引用写入，不验证完整元数据快照。
3. Gate PASS 后采用 Structured Ref Branch；FAIL 后采用 Marker Fallback Branch。
4. transcript 最多保存 attachmentId 和 ordinal。
5. BFF 在两种分支下都必须读时鉴权和补全元数据。
6. 不持久化 kind，不新增会话表或 Message-Artifact Link。
7. 前端统一使用四字段 attachments，图片严格按 raster allowlist 分流。
8. steer、preview 和独立 INPUT retention 均延期。
9. 发布采用同一维护窗口三步：Gateway → agent-server → frontend；窗口内 \_\_openclaw 短暂透传为显式接受的首发风险。
10. download 保持四维 scope 加 READY 校验；session_ref 与 direction 不参与 download 校验，严格 client instance 下载隔离延期。
11. Phase 0 spike 时间盒 2 个工作日；任一 fail condition 证实即 FAIL；证据不全、有歧义或未获项目技术负责人批准均默认 FAIL，自动进入 Marker Fallback Branch。
12. Spike 有具体候选：`SessionManager.appendMessage` 持久化转换链（attempt.ts → session-tool-result-guard-wrapper → session-tool-result-guard），与 inputProvenance 同机制；Spike 聚焦 refs 单次消费、provider 不泄漏、restart/reload/compaction 存活三项风险。
13. Reconcile 匹配键统一为复合签名 `normalizedText + orderedAttachmentIds`；纯文本、纯附件、混合消息走同一算法；重复签名由 `historyFence + ordered-consume` 消费。
14. Human 选择保留 lightbox：用户消息内为 52px 正方形缩略入口并保持附件顺序横向换行；点击打开最大宽 820px、图片最大高 70vh 的可访问 modal，支持 backdrop/关闭按钮/Escape/Tab/焦点恢复和新标签页下载；不新增 preview endpoint、rendition、缩放或图片编辑。
15. download 已支持 `direction=INPUT` + READY，无需扩展实现；Phase 0 只补回归断言（complete_input 不再删 OSS、READY+INPUT 可下载、非 READY 拒绝、retained INPUT 到期由 cleanup 删除）。
16. 新增 Observability 节（4 条全复用 structlog）：enrichment 计数事件、marker fallback 双路径计数、`__openclaw` 泄漏左移到测试不做线上监控、INPUT OSS 存量复用既有 cleanup 指标并显式依赖 cleanup loop 存活。
17. Gate Pass Condition 7 扩写为"provider 请求与 agent trace 事件负载均不含 `__openclaw`"；Phase 2A 测试须在 session reload 后再断 trace 不含 `__openclaw`（候选在落盘时加字段，reload 后才带）。
18. Gateway 出站 `__openclaw` 永远由 Gateway 自行构造，绝不透传 transcript 原始字段（两分支共同不变量）；BFF 删除整个 `__openclaw` 命名空间（不只 attachments），compaction 标记一并剥离，不影响现有功能。
19. Spike 隔离环境：Gate 结论前不合并任何 Structured Ref 写入，跨分支数据迁移问题不存在；FAIL 时无需清理任务（禁止裸写 JSONL），读侧 fail-safe 已覆盖。
20. 全局 ready_retention_seconds 默认值从 30 天调为 180 天（INPUT 与 OUTPUT 共享，不新增独立配置）；OSS 成本超阈值或 cleanup 滞后超期时先回滚 INPUT retention 改动，展示不受影响。

当前状态：`INTEGRATION_QA`。R7 代码修复与三仓自动化 QA 已完成；PR metadata、Required Manual Acceptance 和全新 Fresh Review Round 2 尚待完成。
