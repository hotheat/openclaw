# 子代理工件交付按最终 completion route 选择单一所有者

Status: accepted (2026-07-29)

结构化 subagent handoff 已支持 staging hook 和 channel delivery hook。若 staging 后立即调用 channel adapter，同时 managed handoff 仍进入 parent collect，WebChat 会出现两次发布：

```text
subagent_handoff_delivery
→ WebUI adapter 发布成功
→ handoff view 仍保留全部工件
→ parent collect 生成 webui_artifact_publish 指令
→ 父代理再次发布
```

两次发布使用不同幂等键，服务端无法把它们视为同一次调用。

决定由最终 completion route 选择唯一交付所有者：

- `managed`、`completionDelivery="parent"`、nested requester：父代理交付，不调用 channel delivery hook。
- top-level `unmanaged` direct completion：channel adapter 自动交付，core 直接发送摘要。
- adapter 必须返回 `handled`、`deliveredArtifacts` 和 `failures`。
- core 从 parent-visible handoff 中移除已交付工件。部分失败时只把未交付工件交给父代理恢复。
- 第一个返回 `handled: true` 的 adapter 获得该事件所有权，后续 adapter 不再执行。
- `confirmation` policy 不进入自动 channel delivery，继续使用部署侧 pending 状态和确认流程。
- staging contract 统一定义 profile、quality status、policy status 和 issue code；插件自定义错误码使用 `plugin:<name>` 命名空间。
- staging hook 固定按 `200 guard preflight → 100 artifact stager → 0 guard final policy` 执行。preflight 返回 terminal halt 时，不执行后续复制和验收。
- pending 状态写入 `.artifacts/state/pending-artifact-handoff.json`。

## Consequences

- WebChat direct handoff 由 `extensions/webui-artifacts` 发布文件，core 通过 `chat.inject` 发送摘要。
- Feishu direct handoff 由 Feishu extension 发送附件，core 通过原 completion outbound 路径发送摘要。
- PPTX generator 和 PPTX restyle 保持 managed parent delivery。channel adapter 不提前发布。
- `webui_artifact_publish` 工具仍只对父 WebChat 会话开放。direct handoff adapter 使用的是 staging 后的 requester workspace 文件，不向子 agent 暴露工具。
- delivery hook 成功不再用 `undefined` 表示。未处理、未报告逐工件结果或部分失败都会进入明确恢复路径。
- researcher、PPTX generator 和 PPTX restyle 共用 staging result：`acceptedArtifacts`、`stagedArtifacts`、`rejections`、`failures`。

## Considered Options

1. **所有 handoff 都由 channel adapter 自动交付（被否决）**：会绕过 managed PPTX 的父代理质量说明和最终响应协调。
2. **所有 handoff 都由父代理交付（被否决）**：Researcher direct completion 需要额外父代理 turn，会改写摘要并增加重复与延迟。
3. **adapter 与父代理都尝试交付，依赖服务端幂等（被否决）**：两条调用链的幂等键来源不同，且无法表达部分成功。
