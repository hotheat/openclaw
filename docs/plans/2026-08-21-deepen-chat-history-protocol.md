# Implementation Plan: Deepen the chat.history protocol seam

## Overview

把 `chat.history` 的 params、result 与分页语义收拢到 schema-backed protocol module，并让 Gateway、Swift 生成代码和 Control UI 共用该 interface。Control UI 通过 history port 调用 production WebSocket adapter，测试使用 in-memory adapter。

## Requirements

- `ChatHistoryResult` 明确声明 messages、`nextBefore`、`hasMore`、`cursorReset` 与会话展示设置。
- 每条 result message 必须包含稳定 `historyEntryId`，其余展示字段保持可扩展。
- Control UI 初始/刷新读取 1000 条，旧页读取 100 条。
- 刷新最新窗口保留已加载旧页；游标重置或无稳定重叠时清空重建。
- 老客户端可继续忽略新增 result 字段。

## Architecture Changes

- `src/gateway/protocol/schema/logs-chat.ts`：新增 history message/result schema。
- `src/gateway/protocol/schema/{protocol-schemas,types}.ts` 与 `src/gateway/protocol/index.ts`：注册、导出并验证 params/result。
- `src/gateway/server-methods/chat.ts`：使用 schema-backed params/result 类型。
- `scripts/protocol-gen-swift.ts` 生成的 Swift models：增加 `ChatHistoryResult`。
- `ui/src/ui/controllers/chat.ts`：定义 history port、production adapter 和分页合并 implementation。
- `ui/src/ui/{app,app-view-state,app-render}.ts` 与 `ui/src/ui/views/chat.ts`：持有分页状态并提供旧页入口。

## Implementation Steps

### Phase 1: Deepen the protocol module

1. **声明 history result**（File: `src/gateway/protocol/schema/logs-chat.ts`）
   - Action: 新增带稳定条目标识的 message schema 和完整 result schema。
   - Why: params/result 在同一 interface 获得 locality。
   - Dependencies: None
   - Risk: Medium；message 必须保持异构字段扩展能力。

2. **注册类型与 validator**（Files: `protocol-schemas.ts`, `types.ts`, `index.ts`）
   - Action: 导出 params/result 静态类型与 result validator。
   - Why: Gateway 与 owned clients 不再本地猜测 result。
   - Dependencies: Step 1
   - Risk: Low

3. **生成 Swift model**（Files: `apps/*/GatewayModels.swift`）
   - Action: 运行 Swift protocol generator。
   - Why: owned Swift clients 跨同一 seam。
   - Dependencies: Step 2
   - Risk: Low

### Phase 2: Adopt the interface in Control UI

1. **建立 history port**（File: `ui/src/ui/controllers/chat.ts`）
   - Action: 定义窄 history port；GatewayBrowserClient 作为 production adapter，测试注入 in-memory adapter。
   - Why: transport 与分页逻辑分离，同时保持一个真实 seam。
   - Dependencies: Phase 1
   - Risk: Medium

2. **实现分页状态与合并**（Files: `chat.ts`, `app.ts`, `app-view-state.ts`）
   - Action: 保存 cursor/hasMore/loadingOlder；按 History Entry ID prepend、去重和刷新尾部对齐。
   - Why: 已加载旧页不被刷新丢弃。
   - Dependencies: Step 1
   - Risk: High；错误合并会丢消息或重复。

3. **提供旧页入口**（Files: `app-render.ts`, `views/chat.ts`, chat CSS）
   - Action: 在消息列表顶部显示可访问的旧页加载按钮。
   - Why: 分页能力可以被用户实际调用。
   - Dependencies: Step 2
   - Risk: Low

### Phase 3: Verification

1. **协议 tests**（File: `src/gateway/protocol/index.test.ts`）
   - Action: 验证完整 result、缺少 History Entry ID 和非法分页字段。
2. **Control UI tests**（Files: `controllers/chat.test.ts`, `views/chat.test.ts`）
   - Action: 覆盖 initial、prepend、dedupe、refresh merge、cursor reset 和旧页入口。
3. **Gateway tests 与生成检查**
   - Action: 运行 protocol、Gateway chat、目标 UI tests、UI build、typecheck 和 protocol generation check。

## Testing Strategy

- Protocol: `src/gateway/protocol/index.test.ts`
- Gateway: `src/gateway/server.chat.gateway-server-chat-b.test.ts`
- UI controller/view: `ui/src/ui/controllers/chat.test.ts`, `ui/src/ui/views/chat.test.ts`
- Static: targeted formatting/lint, TypeScript typecheck, UI build

## Risks & Mitigations

- **异构 message 被 schema 收窄**
  - Mitigation: 只要求 `historyEntryId`，允许其余公开展示字段扩展；Swift 保持字典消息。
- **刷新覆盖已加载旧页**
  - Mitigation: 以 History Entry ID 查找尾部重叠；无重叠按 Cursor Reset 语义清空。
- **会话切换期间旧请求污染新会话**
  - Mitigation: 请求完成时核对捕获的 sessionKey。

## Success Criteria

- [x] `ProtocolSchemas.ChatHistoryResult` 存在且 validator 通过。
- [x] Gateway handler 使用共享 params/result 类型。
- [x] Swift 生成代码包含兼容的 `ChatHistoryResult`。
- [x] Control UI 可加载旧页并保存分页状态。
- [x] 刷新与 Cursor Reset 行为有 in-memory adapter tests。
- [x] 目标测试、UI build 与 typecheck 通过。
