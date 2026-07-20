# Implementation Plan: WebChat 附件历史消息脱敏

## Overview

修复 WebChat workspace 附件在历史消息中暴露服务器绝对路径的问题，同时保留 Agent 通过本地 workspace 路径读取附件的能力。出站 `webui_artifact_publish` 下载链路保持不变。

## Requirements

- Workspace 附件只写入 `MediaPath` / `MediaPaths`，不把本地路径伪装成 `MediaUrl` / `MediaUrls`。
- `chat.history` 返回用户消息时移除开头的媒体附件注入行和媒体回复提示，只保留用户原文。
- `sessions.list` 派生标题和用户消息预览应用相同清洗，避免侧边栏泄露本地路径。
- 不修改 transcript 中供 Agent 执行使用的原始 prompt，也不影响 Artifact 下载。
- 为字段映射和历史消息清洗增加回归测试。

## Architecture Changes

- `src/gateway/server-methods/chat.ts`：收紧 workspace 附件进入 `MsgContext` 时的字段映射。
- `src/auto-reply/media-note.ts`：导出媒体回复提示常量，作为生成端和展示清洗端的单一事实来源。
- `src/gateway/chat-sanitize.ts`：只针对用户消息的展示副本清理开头的媒体注入块。
- `src/gateway/session-utils.fs.ts`：在派生会话标题和用户预览时复用展示清洗。
- `src/gateway/chat-sanitize.test.ts` 与 `src/gateway/server-methods/chat.directive-tags.test.ts`：覆盖单附件、多附件、非用户消息和 workspace 字段映射。

## Implementation Steps

### Phase 1: 消息字段与展示清洗

1. **移除本地路径 URL 映射**（`src/gateway/server-methods/chat.ts`）
   - Action：保留 `MediaPath`、`MediaPaths`、媒体类型字段，删除 `MediaUrl`、`MediaUrls`。
   - Why：URL 字段不应承载服务器本地路径，且会导致注入文本重复显示 `path | path`。
   - Dependencies：无。
   - Risk：低；Agent 文件读取以 Path 字段为主。

2. **统一媒体回复提示常量**（`src/auto-reply/media-note.ts`、`src/auto-reply/reply/get-reply-run.ts`）
   - Action：导出并复用 `INBOUND_MEDIA_REPLY_HINT`。
   - Why：确保展示层清洗规则与 prompt 生成内容一致。
   - Dependencies：无。
   - Risk：低；文本内容保持不变。

3. **清理历史展示副本**（`src/gateway/chat-sanitize.ts`）
   - Action：对 role=user 的字符串或 text block，剥离开头连续的 `[media attached...]` 行及其后的固定回复提示。
   - Why：隐藏本地实现细节，同时不改变 transcript 和 Agent 输入。
   - Dependencies：步骤 2。
   - Risk：中；必须锚定消息开头且只处理用户消息，避免误删正文。

4. **清理会话标题与预览**（`src/gateway/session-utils.fs.ts`）
   - Action：读取 transcript 的用户文本用于标题或预览时，复用用户展示清洗函数。
   - Why：`sessions.list` 不经过 `chat.history`，需要独立覆盖侧边栏展示路径。
   - Dependencies：步骤 3。
   - Risk：低；assistant 预览保持原样。

### Phase 2: 验证与部署

1. **增加回归测试**
   - Unit：单附件、多附件、content 数组、assistant 消息不清理、正文中同类文本不清理。
   - Integration：workspace chat.send 的 dispatch context 不含 `MediaUrl(s)`，但仍含 `MediaPath(s)`。

2. **本地验证**
   - 运行相关 Vitest 测试、类型检查和格式检查。

3. **测试环境部署与 E2E**
   - 构建并同步到 `ssh-xialu-test`，重启 OpenClaw Gateway。
   - 重新读取指定会话，确认历史消息只展示用户原文；确认 Artifact 下载仍返回成功跳转。

## Testing Strategy

- Unit tests：`src/gateway/chat-sanitize.test.ts`。
- Session list tests：`src/gateway/session-utils.fs.test.ts`。
- Gateway integration tests：`src/gateway/server-methods/chat.directive-tags.test.ts`。
- Regression tests：现有附件解析、媒体 prompt 和 Artifact 测试。
- E2E：WebChat 历史刷新、workspace 附件读取、Artifact 下载。

## Risks & Mitigations

- **误删用户正文**：仅处理 role=user 且锚定消息开头的规范媒体注入行。
- **Agent 无法读取附件**：只删除 URL 映射，保留 Path 和 MIME 字段；清洗仅作用于返回 UI 的消息副本。
- **旧 transcript 不生效**：在 `chat.history` 读取时动态清洗，因此历史记录无需迁移。

## Success Criteria

- [x] Workspace 附件上下文中不存在本地路径形式的 `MediaUrl(s)`。
- [x] `chat.history` 不再返回 `[media attached: ...]` 和媒体回复提示。
- [x] 会话标题与用户消息预览不再包含本地路径。
- [x] 用户原始请求文本完整保留。
- [x] Agent 仍可读取 workspace 附件。
- [x] Artifact 文件卡和下载链路保持正常。
