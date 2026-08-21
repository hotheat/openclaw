# Implementation Plan: Deepen bounded transcript scanning

## Overview

把反向 chunk traversal、单行/扫描预算和 JSON record decode 从 WebChat 历史页移入中立的有界 transcript module。历史页与 post-compaction audit 通过同一 interface 读取 raw records，并删除无生产调用的同步全文件 reader。

## Requirements

- 保持 History Page 的游标、文件快照和展示映射语义不变。
- post-compaction audit 不再依赖 `gateway/session-history-page`。
- malformed 与 oversized 行仍计入原始 record 预算。
- 单行和扫描字节上限只在有界 transcript module 内实现。
- 删除 `session-utils.fs` 的同步全文件 `readSessionMessages` interface 及其专属 tests。

## Architecture Changes

- `src/sessions/bounded-transcript.ts`：新增中立 deep module，负责反向 traversal、完整行预算、record decode、统计和近期 raw-record 读取。
- `src/gateway/session-history-page.ts`：只保留 History Page 的 record 映射、游标和响应预算，通过有界扫描 interface 取得 decoded records。
- `src/auto-reply/reply/post-compaction-audit.ts`：直接使用中立 module 的近期 record interface。
- `src/gateway/session-utils.fs.ts` / `src/gateway/session-utils.ts`：删除同步全文件 reader 与 re-export。

## Implementation Steps

### Phase 1: Establish the deep module

1. **提取有界 traversal 与 decode**（File: `src/sessions/bounded-transcript.ts`）
   - Action: 移入 reverse chunk reader、line assembly、字节预算和 JSON decode；返回 offsets、状态及扫描统计。
   - Why: 两个调用方共享资源上限与解析规则，提升 locality。
   - Dependencies: None
   - Risk: High；行边界或 continuation offset 错误会影响分页。

2. **增加 module interface tests**（File: `src/sessions/bounded-transcript.test.ts`）
   - Action: 覆盖跨 chunk record、malformed 计数、oversized 状态、raw-record 上限和无完整边界时失败。
   - Why: tests 通过 deep module interface 验证实现，而非 WebChat 私有路径。
   - Dependencies: Step 1
   - Risk: Medium

### Phase 2: Migrate callers and delete shallow interfaces

1. **迁移 History Page**（File: `src/gateway/session-history-page.ts`）
   - Action: 使用有界扫描结果构建 History Page record，保留游标快照和展示预算。
   - Why: WebChat module 不再拥有通用 transcript traversal。
   - Dependencies: Phase 1
   - Risk: High

2. **迁移 audit**（Files: `src/auto-reply/reply/post-compaction-audit.ts`, tests）
   - Action: 从中立 module 读取近期 raw records。
   - Why: 删除 audit → WebChat 的反向依赖。
   - Dependencies: Phase 1
   - Risk: Low

3. **删除同步全文件 reader**（Files: `src/gateway/session-utils.fs.ts`, `src/gateway/session-utils.ts`, tests）
   - Action: 删除未使用的 `readSessionMessages` 和专属 tests。
   - Why: deletion test 表明删除后复杂度直接消失，interface 没有 leverage。
   - Dependencies: History Page 已不依赖旧 reader
   - Risk: Low；先用全仓引用搜索确认无生产调用。

## Testing Strategy

- Deep module: `src/sessions/bounded-transcript.test.ts`
- History Page: `src/gateway/session-history-page.test.ts`
- Audit: `src/auto-reply/reply/post-compaction-audit.test.ts`
- Gateway chat: `src/gateway/server.chat.gateway-server-chat-b.test.ts`
- Static: targeted format/lint、`pnpm typecheck`、`pnpm ui:build`

## Risks & Mitigations

- **分页 continuation 改变**：保留每条 record 的 byte offsets，并继续用最早返回 record 或预算停止点生成游标。
- **malformed/oversized 不再消耗预算**：module 对所有非空完整行计数，状态只影响 decode 结果。
- **文件在读取期间变化**：chunk short-read 继续显式失败；History Page 保留读取前后快照校验。

## Success Criteria

- [x] History Page 与 audit 共用中立有界 transcript module。
- [x] audit 不再 import WebChat 历史 module。
- [x] 同步全文件 `readSessionMessages` interface 和 tests 被删除。
- [x] 资源上限与 record decode 仅在有界 transcript module 实现。
- [x] 定向 tests、typecheck、UI build、format 和 lint 通过。
