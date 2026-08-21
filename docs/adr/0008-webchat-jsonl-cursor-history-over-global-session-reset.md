# WebChat 历史以活跃 JSONL 游标分页为准，取消全局定期 session reset

WebChat 需要可回溯的完整聊天历史，而全局 weekly `session.reset` 会定期切换 session UUID、把历史切进 `.jsonl.reset.*` 文件之外；同时 `chat.history` 同步全量读 transcript 的方式无法承受长期增长。我们决定：删除全局 `session.reset`（保留用户主动 `/new`/`/reset`），以当前活跃 Pi JSONL transcript 为唯一聊天历史事实源，`chat.history` 增加 opaque 字节偏移游标（`before`/`nextBefore` + file token 身份校验）做异步反向分页，展示历史与模型上下文（Pi compaction）彻底脱钩。

## Considered Options

- **PostgreSQL 消息表**：被否决——引入双写一致性与迁移成本，而 JSONL 已是权威记录，分页读取即可满足展示需求。
- **保留 weekly reset 并合并 `.jsonl.reset.*` 历史文件**：被否决——跨文件游标、文件生命周期与去重复杂度远高于单一活跃文件；reset 边界对用户是意外的历史断层。
- **立即实施 segment rotation**：暂缓——先删 reset 并监控 transcript 大小与 Pi `SessionManager` 耗时，达到阈值再做对 UI 透明的 rotation 或快照；不允许回退到全局 reset。

## Consequences

- transcript 无限增长成为常态：所有读取路径必须有界（分页、尾读），新增全量读取属回归。
- 游标绑定文件身份和边界内容（session ID + file token + offset + anchor hash）：文件替换以及影响游标边界的截断或同 inode rewrite 触发显式 `cursorReset`，客户端清空重建，绝不静默跨文件。
- page 读取与游标生成使用相同文件快照元数据；期间发生 append 或 rewrite 时本次请求显式失败，禁止旧页内容绑定新版本游标。
- 反向读取同时限制单行内存、单请求扫描字节和原始记录数；预算在完整行边界耗尽时返回 continuation cursor，无法安全形成边界时显式失败。
- 前端对账从“全量替换”改为“最新窗口尾部对齐合并”（见 CONTEXT.md Reconcile 新语义）。
