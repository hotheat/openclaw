# WebChat 用户标题使用独立 title 字段而非复用 label

Status: accepted (2026-08-07)

WebChat 会话管理需要用户可自由重命名会话。直觉方案是复用 `SessionEntry.label`（「避免两份标题源」），但 label 在 OpenClaw 是全局唯一的 CLI 寻址别名：`applySessionsPatchToStore()` 对 label 做全 store 唯一性检查（`src/gateway/sessions-patch.ts:140`），label 同时被 `sessions.resolve`、`sessions_send(label=...)` 寻址并参与 search。把可重复的用户标题写入 label 会导致跨用户重名失败，且错误信息 `label already in use: <label>` 会向另一个用户泄露标题存在性。

决定新增可选 `SessionEntry.title` 字段承载用户标题：`webchat.sessions.rename` 只写 title（trim 后 1-64，无唯一性检查）；label 的唯一性、resolve、send、search 契约完全不变；`sessions.list` 返回 title，前端标题优先级为 `title -> derivedTitle -> label -> displayName`（2026-08-07 计划访谈修正：只把用户新设的 title 提到首位，derivedTitle 与 label 保持现有相对顺序，避免已设 label 的会话展示翻转）。

## Considered Options

1. **复用 label，冲突时报「标题已被占用」（被否决）**：跨用户标题存在性泄露；多用户部署下两个用户不能给各自会话起同名，不可接受。
2. **保留写 label，把 webchat 会话从 label 唯一域排除（被否决）**：需要同步修改 patch 唯一性检查、resolve、search、`sessions_send` 四处既有语义并为 CLI 兼容性补负例测试；旧版本 Gateway 回滚后会重新应用原有唯一性，兼容面明显更大。
3. **写入 displayName（被否决）**：displayName 是 channel 群组元数据派生值（`buildGroupDisplayName`，如飞书群名），挪用会污染 channel 元数据语义。

## Consequences

- 用户标题与 CLI 别名是两个领域概念，分字段后互不干扰；「单一标题源」的原始诉求通过「title 只存 OpenClaw、agent-server 不复制标题」保持。
- `SessionsPatchParams` 与 `applySessionsPatchToStore()` 增加 title 分支，admin `sessions.patch` 与窄方法共用同一 store 更新实现；label 分支的唯一性检查必须原样保留并由回归测试锁定。
- 旧版本 Gateway 读取含 title 的 `sessions.json` 时忽略未知字段，无迁移成本。已接受边界：旧版本在 reset 等重建 entry 的路径上可能丢弃 title。
