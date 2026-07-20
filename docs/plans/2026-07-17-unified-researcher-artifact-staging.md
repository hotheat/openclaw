# Implementation Plan: Unified Researcher Artifact Staging

## Overview

在子任务结果投递前统一解析 `SUBAGENT_HANDOFF`，把 Researcher 产物同步到 requester workspace。同步逻辑与渠道无关；飞书继续使用既有 outbox/message 交付，WebChat 使用 BFF Artifact 协议自动发布后再执行 `chat.inject`。

## Requirements

- 飞书和 WebChat 复用同一套 Researcher 文件同步逻辑。
- staging 必须发生在用户可见结果投递之前。
- WebChat 产物发布完成后再直投 Researcher 原文，不触发主 Agent 改写。
- 保留 `subagent_ended`、`read` 和 `webui_artifact_publish` 前置镜像作为补偿路径。
- 只允许同步声明在配置 export prefix 下的普通文件。

## Architecture Changes

- Core 新增 `subagent_handoff_staging` 和 `subagent_handoff_delivery` 两阶段 hook。
- 将部署插件 `feishu-researcher-export-mirror` 重构为渠道无关的 `researcher-export-stager`。
- `extensions/webui-artifacts` 复用现有安全读取和 OSS/BFF 上传实现，订阅 delivery hook 自动发布 staged artifacts。
- `subagent_ended` 保持投递后生命周期语义，不作为主 staging 入口。

## Implementation Steps

### Phase 1: Core lifecycle

1. **新增 hook 类型和 runner** (`src/plugins/types.ts`, `src/plugins/hooks.ts`)
   - Action: 定义 staging event/result、staged artifact、delivery event，并增加 runner 方法。
   - Why: staging 与渠道交付需要明确的同步边界和数据契约。
   - Dependencies: None.
   - Risk: Medium，hook 类型会影响插件注册面。

2. **接入 subagent announce 流程** (`src/agents/subagent-announce.ts`)
   - Action: 在顶层 requester 的 completion 投递前运行 staging，再运行 delivery，最后进入现有 direct/parent delivery。
   - Why: 保证飞书和 WebChat 都使用同一份 staged artifact。
   - Dependencies: Step 1.
   - Risk: High，必须保持无 handoff 任务行为不变。

### Phase 2: Unified staging and delivery

3. **重构部署镜像插件** (`openclaw-workspace/extensions/researcher-export-stager`)
   - Action: 从 handoff 提取 export/exports，安全复制到 requester workspace，并返回标准 staged artifact 清单；保留既有补偿 hook。
   - Why: 消除按渠道复制文件的重复逻辑。
   - Dependencies: Phase 1.
   - Risk: Medium，需同步更新插件 ID 和部署配置。

4. **复用 WebChat Artifact publisher** (`extensions/webui-artifacts`)
   - Action: 抽取可复用 publish 函数，delivery hook 对 `:webchat:` requester 自动执行 init/upload/complete。
   - Why: 避免复制 OSS/BFF 上传、安全读取、hash 和限额逻辑。
   - Dependencies: Steps 1-3.
   - Risk: Medium，需保证幂等 source id。

### Phase 3: Verification and deployment

5. **目标测试**
   - Core hook runner、announce 顺序、stager 路径边界、WebChat 自动发布、飞书 staging 回归。
   - 运行相关 Vitest、Node test、格式检查和 OpenClaw build。

6. **部署与端到端验收**
   - 同步 OpenClaw runtime 和部署插件，更新插件配置，重启 Gateway。
   - 验证同一 Researcher handoff 在飞书/WebChat 都先进入用户 workspace；WebChat 自动出现下载卡片。

## Testing Strategy

- Unit: hook 合并、stager export/exports、路径越界、重复 staging、artifact publisher 幂等 key。
- Integration: `runSubagentAnnounceFlow` 中 staging → delivery → direct delivery 的调用顺序。
- E2E: Researcher workspace 独占源文件，WebChat 自动生成 Artifact 下载卡；飞书目标 workspace 同步文件不回归。

## Risks & Mitigations

- **重复投递**：announce 重试可能重复发布。
  - Mitigation: 使用 `subagent-handoff:<runId>:<index>` 作为 BFF 幂等 source id。
- **路径穿越或跨 workspace 读取**：handoff 内容不可信。
  - Mitigation: export prefix、realpath、安全普通文件和 requester workspace 边界校验。
- **Artifact 发布失败阻断文本**：OSS/BFF 异常不应丢失 Researcher 结论。
  - Mitigation: delivery hook 完成等待但失败记录日志，文本仍继续直投。
- **插件重命名导致重复加载**：旧、新插件目录并存。
  - Mitigation: 配置和远端目录一次性切换，禁止同时启用两个 plugin id。

## Success Criteria

- [x] 飞书和 WebChat 使用同一 staging hook 和同一 stager 插件。
- [x] staging 在用户可见结果之前完成。
- [x] WebChat 自动发布 staged artifact，主 Agent 不参与改写。
- [x] 无 HANDOFF 的子任务投递行为不变。
- [x] 目标测试、构建和远端 E2E 通过。
