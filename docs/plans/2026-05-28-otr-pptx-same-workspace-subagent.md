# Implementation Plan: OTR PPTX Same-Workspace Subagent

## Overview

本计划替代旧的 `artifact_jobs + ppt-agent + 独立 workspace` PPT 链路。

OTR PPTX 生成或 restyle 不再通过独立 `ppt-agent` 执行。调用方在当前 agent 内使用 `sessions_spawn` 启动同 agent 子 session，子 session 与父 session 共享同一个 workspace，因此输入文件、工作目录、输出 PPTX 和后续发送都在同一 workspace 内完成。

主链路：

```text
main / researcher / feishu 当前 workspace
  -> 明确识别 OTR 风格 PPT 生成或 PPTX restyle
  -> sessions_spawn(task=..., 不传 agentId)
  -> agent:<current-agent>:subagent:<uuid>
  -> 子 session 使用 otr-pptx-restyle
  -> 当前 workspace/artifacts/pptx-restyle/<taskId>/
  -> final.pptx + verify 输出 + delivery.json
  -> 子 session 先用 message 工具发送 final.pptx
  -> completionDelivery="parent" 触发父 session 检查 delivery.json
  -> 父 session 对 failed/missing 做 message 工具兜底发送
```

## Superseded Design

旧方案文件名：

```text
docs/plans/2026-05-28-artifact-jobs-ppt-agent.md
```

旧链路：

```text
caller workspace
  -> artifact_jobs.create / attach_file / write_manifest
  -> sessions_spawn(agentId="ppt-agent")
  -> workspace-ppt-agent
  -> artifact_jobs outbox/result
  -> artifact_jobs.finalize(exportTo="caller_workspace")
  -> caller workspace artifacts/imports/<jobId>/
```

该方案能解决跨 workspace 文件传递，但对 OTR PPTX restyle 场景过重。这里需要的是执行隔离，不需要 workspace 隔离。

`artifact_jobs` 保留为通用跨 workspace artifact 工具，后续可继续用于 researcher、PDF、图片、报告等需要严格 inbox/outbox 协议的任务。PPT restyle 主链路不再使用它。

## Requirements

- 只有用户明确要求生成 OTR 风格 PPT，或将 PPTX 转换/restyle 为 OTR 风格时，才触发该链路。
- 普通 PPT 阅读、总结、问答、非 OTR slide 编辑不触发 `otr-pptx-restyle`。
- 父 session 必须通过 `sessions_spawn` 委派 OTR PPTX 任务。
- `sessions_spawn` 不传 `agentId`，确保子 session 属于当前 agent。
- `sessions_spawn` 传 `completionDelivery="parent"`，确保父 session 在子 session 完成后执行一次交付检查。
- 子 session 共享当前 workspace，直接读取当前 workspace 内输入文件。
- 子 session 输出固定写入当前 workspace 的 `artifacts/pptx-restyle/<taskId>/`。
- 子 session 必须写 `delivery.json`，记录 `sent`、`failed` 或 `skipped`。
- 父 session 必须读取 `delivery.json`，对 `failed` 或 missing 状态做兜底发送。
- 子 session 中不得再次递归 spawn 同类 OTR PPTX 子任务。
- `otr-pptx-restyle` skill 必须同步到所有可能调用它的 feishu workspace 和 researcher workspace。

## Architecture Changes

- `workspace/skills/otr-pptx-restyle/SKILL.md`
  - 增加 same-agent spawn 规则。
  - 增加 subagent recursion guard。
  - 增加固定输出目录约定。
  - 增加 `delivery.json` 和父 session 兜底发送约定。
  - 保留 doctor、analyze、apply、verify 主流程。

- `workspace/AGENTS.md`
  - 删除 `ppt-agent` 和 PPT 专用 `artifact_jobs` 调用说明。
  - 增加 OTR PPTX 委派规则：调用 `sessions_spawn` 时不传 `agentId`。
  - 增加 `completionDelivery="parent"` 和交付检查规则。
  - 增加例外说明：OTR PPTX same-agent spawn 不适用“delegation 必须显式 agentId”的通用规则。

- `openclaw.json`
  - 删除 `ppt-agent` agent entry。
  - 从 `agents.defaults.subagents.allowAgents` 移除 `ppt-agent`。
  - 保留 `tools.artifactJobs`，但不作为 PPT 链路依赖。

- `workspace/feishu-sync.toml`
  - 从 `[skills].exclude` 移除 `otr-pptx-restyle`。
  - 删除 `[agent_skill_sync.ppt-agent]`。
  - 将 `otr-pptx-restyle` 纳入普通 feishu workspace skill sync。
  - 将 `otr-pptx-restyle` 加入 `[researcher].sync_skills`。

- `workspace-ppt-agent/`
  - 删除或停用。
  - 清理其中同步出的 `skills/otr-pptx-restyle` 副本，避免误导后续维护。

## Implementation Steps

### Phase 1: 更新调用协议

1. 修改 `otr-pptx-restyle/SKILL.md`
   - 父 session 遇到符合触发条件的任务时，必须 `sessions_spawn`。
   - spawn task 必须写清输入文件路径、输出目录、验证要求。
   - 不传 `agentId`。
   - 传 `completionDelivery="parent"`。
   - 如果当前消息已包含 subagent context，则直接执行，不再 spawn。
   - 子 session 成功 verify 后先用 `message` 工具发送 `final.pptx`，并写 `delivery.json`。
   - 父 session 完成后读取 `delivery.json`，必要时用 `message` 工具补发。

2. 修改 `workspace/AGENTS.md`
   - 移除 `ppt-agent`、`artifact_jobs.create`、`attach_file`、`finalize` 的 PPT 调用链。
   - 明确 OTR PPTX 任务使用 same-agent subagent。
   - 明确普通 PPT 任务不触发该流程。

### Phase 2: 更新配置和同步

1. 修改 `openclaw.json`
   - 删除 `ppt-agent`。
   - 删除 defaults allowlist 中的 `ppt-agent`。
   - 保留 `tools.artifactJobs`。

2. 修改 `workspace/feishu-sync.toml`
   - 让 `otr-pptx-restyle` 同步到 feishu-\* workspace。
   - 让 `otr-pptx-restyle` 同步到 researcher workspace。
   - 移除 ppt-agent 专用同步配置。

3. 重启并验证 `openclaw-feishu-workspace-sync.service`
   - feishu-\* workspace 均有 `skills/otr-pptx-restyle`。
   - researcher workspace 有 `skills/otr-pptx-restyle`。
   - 不再依赖 `workspace-ppt-agent`。

### Phase 3: 清理旧 PPT agent 链路

1. 删除或停用 `workspace-ppt-agent/AGENTS.md`。
2. 清理 `workspace-ppt-agent/skills/otr-pptx-restyle`。
3. 更新文档中所有 `ppt-agent` PPT 主链路描述。
4. 保留 `artifact_jobs` 通用工具文档和测试。

## Same-Workspace Notes

- 输入文件路径必须是当前 workspace 内路径，或当前 agent 已经可访问的 inbound media 路径。
- 输出目录必须由父 session 在 task 中指定，推荐：

```text
artifacts/pptx-restyle/<YYYYMMDD-HHMMSS-or-runId>/
```

- 子 session 产物至少包括：

```text
final.pptx
work/visual_analysis/layout_plan.json
work/verify/
summary.md
delivery.json
```

- 子 session 先尝试发送文件，父 session 通过 `delivery.json` 做兜底。
- 父 session 发送文件时直接使用当前 workspace 内的 `final.pptx`，并必须通过 `message` 工具，让 Feishu outbox router 完成受控 staging。
- 不再需要 `artifact_jobs.finalize(exportTo="caller_workspace")`。

## Testing Strategy

- 配置检查：
  - `openclaw.json` 不存在 `ppt-agent`。
  - `agents.defaults.subagents.allowAgents` 不包含 `ppt-agent`。
  - `tools.artifactJobs` 仍可保留。

- 同步检查：
  - `workspace/feishu-sync.toml` 中 `otr-pptx-restyle` 不在 `[skills].exclude`。
  - researcher sync list 包含 `otr-pptx-restyle`。
  - `workspace-feishu-*/skills/otr-pptx-restyle` 存在。
  - `workspace-researcher/skills/otr-pptx-restyle` 存在。

- 行为检查：
  - OTR PPTX 请求触发 same-agent `sessions_spawn`。
  - spawn 请求不传 `agentId`。
  - spawn 请求包含 `completionDelivery="parent"`。
  - 子 session 输出到当前 workspace 的 `artifacts/pptx-restyle/<taskId>/`。
  - 子 session 写 `delivery.json`。
  - 父 session 对 `delivery.json.status=failed` 或缺失状态执行兜底发送。
  - 子 session 不再次 spawn 同类任务。
  - 普通 PPT 阅读、总结、问答不触发 `otr-pptx-restyle`。

- 回归检查：
  - `artifact_jobs` 现有测试继续通过。
  - `sessions_spawn` same-agent 默认行为测试继续通过。
  - `make build` 通过。

## Risks & Mitigations

- **Risk**: 子 session 再次触发 `otr-pptx-restyle` 并递归 spawn。
  - Mitigation: 在 skill 中明确检查 subagent context，子 session 直接执行。

- **Risk**: 输出文件名或目录不稳定，父 session 找不到产物。
  - Mitigation: 父 session 在 spawn task 中固定输出目录，子 session 必须写 `summary.md` 和 `delivery.json` 记录最终路径。

- **Risk**: 子 session 生成成功但文件未发送。
  - Mitigation: `completionDelivery="parent"` 强制父 session 收到 completion，并读取 `delivery.json` 对失败或缺失投递做兜底。

- **Risk**: feishu workspace 未同步该 skill，same-agent 子 session 看不到 `otr-pptx-restyle`。
  - Mitigation: 从 feishu skill exclude 移除该 skill，并用 sync service 验证。

- **Risk**: `artifact_jobs` 仍在工具列表中造成误用。
  - Mitigation: `workspace/AGENTS.md` 明确 PPT 链路不使用 `artifact_jobs`；工具保留仅用于跨 workspace artifact 任务。

## Success Criteria

- [ ] 文档、workspace 指令和配置均不再把 PPT restyle 主链路指向 `ppt-agent`。
- [ ] OTR PPTX 任务在当前 agent 内使用 same-agent `sessions_spawn`。
- [ ] `otr-pptx-restyle` 在 feishu-\* 和 researcher workspace 中可用。
- [ ] 输出 PPTX 位于调用方 workspace 内，可直接发送。
- [ ] 子 session 生成 `delivery.json`，父 session 能在失败或缺失投递时兜底发送。
- [ ] `artifact_jobs` 保留为通用工具，但不参与 PPT restyle 主链路。
