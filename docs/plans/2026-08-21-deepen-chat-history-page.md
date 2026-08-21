# Implementation Plan: Deepen chat.history page assembly

## Overview

把 `chat.history` 的历史页读取、展示变换、响应预算和游标终结收拢到 `session-history-page` module。Gateway handler 只保留 RPC 参数校验、session 定位、错误映射、诊断日志与响应发送。

## Requirements

- 保持 PR #127 已定义的游标、`cursorReset`、分页和响应预算语义。
- 文件快照、record offset 与游标创建顺序不得泄漏到 handler。
- 保持附件引用重建、消息脱敏、oversized placeholder 和 6 MiB 响应上限。
- 只运行历史页与 Gateway chat 的针对性测试。

## Architecture Changes

- `src/gateway/session-history-page.ts`：深化 History Page module，新增可直接响应的历史页加载 interface；吸收展示变换、响应预算与游标终结。
- `src/gateway/server-methods/chat.ts`：移除历史页 implementation 细节，改为一次调用 deep module。
- `src/gateway/session-history-page.test.ts`：在 deep interface 上覆盖预算裁剪后游标连续性与展示变换。

## Implementation Steps

### Phase 1: Deepen the History Page module

1. **收拢历史页展示规则**（File: `src/gateway/session-history-page.ts`）
   - Action: 移入附件引用重建、envelope/directive 脱敏、文本与单消息限制、最终响应预算逻辑。
   - Why: 保持 record offset 与展示消息在同一 implementation 中。
   - Dependencies: None
   - Risk: Medium；移动时必须保持变换顺序。

2. **终结游标与文件快照**（File: `src/gateway/session-history-page.ts`）
   - Action: 在 deep interface 内根据最终返回的最早 record 计算游标，并在同一调用内验证文件快照。
   - Why: handler 不再承担跳页正确性。
   - Dependencies: Step 1
   - Risk: High；错误会造成历史跳过或重复。

### Phase 2: Shrink the handler

1. **替换 handler 编排**（File: `src/gateway/server-methods/chat.ts`）
   - Action: 用一次历史页加载调用替换 reader、变换、预算和 cursor 调用链。
   - Why: 缩小 interface，提升 locality 与 leverage。
   - Dependencies: Phase 1
   - Risk: Medium；保留 INVALID_REQUEST 与 UNAVAILABLE 映射。

### Phase 3: Verification

1. **迁移 deep interface 测试**（File: `src/gateway/session-history-page.test.ts`）
   - Action: 覆盖最终消息、附件/脱敏、预算裁剪和后续游标。
   - Why: tests 与调用方跨同一 seam。
   - Dependencies: Phase 1
   - Risk: Low

2. **运行针对性测试**
   - Action: 运行 History Page 与 Gateway chat 测试文件，再运行相关 TypeScript 检查。
   - Why: 验证 implementation 细节与 RPC observable outcomes。
   - Dependencies: All implementation steps
   - Risk: Low

## Testing Strategy

- Unit tests: `src/gateway/session-history-page.test.ts`
- Gateway integration tests: `src/gateway/server.chat.gateway-server-chat-b.test.ts`
- Static checks: changed-file formatting and targeted TypeScript validation where available

## Risks & Mitigations

- **响应裁剪后 cursor 跨过未返回消息**
  - Mitigation: 用最终返回 record 的 `startOffset` 终结 cursor，并保留现有回归测试。
- **文件在读取和 cursor 创建之间变化**
  - Mitigation: deep module 内继续比较 file token、size、mtime 与 ctime。
- **历史展示规则移动后行为漂移**
  - Mitigation: 保持原处理顺序，并通过现有 Gateway observable-outcome tests 验证。

## Success Criteria

- [x] `chat.ts` 不再引用 `HistoryPageRecord`、`SessionHistoryPage`、page cursor 或 record offset。
- [x] History Page deep interface 返回可直接响应的 messages 与分页字段。
- [x] 现有分页、rewrite、附件、脱敏和 oversized 测试通过。
- [x] 变更提交并推送到 PR #127 的 head branch。
