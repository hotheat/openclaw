# 删除 `artifact_jobs` 工具，而非用配置禁用保留恢复能力

Status: accepted (2026-07-28)

`artifact_jobs` 在本部署没有生产调用链：源码搜索找不到业务链路，部署侧还主动劝阻使用——`openclaw-workspace/workspace/AGENTS.md:366` 与 `workspace/skills/otr-pptx-restyle/SKILL.md:20` 都写着「Do not use `artifact_jobs`」。也就是说当前每次运行都在把它列为可用工具、占用 tool schema 预算，同时又花提示词 token 叫模型别用。

决定**整体删除**：实现（`src/agents/tools/artifact-jobs-tool.ts`）、注册（`src/agents/openclaw-tools.ts`）、tool catalog 条目、tool policy 中的 `"group:artifacts"` 别名与 `TOOL_PROFILES.coding.allow` / `group:openclaw` 条目、配置类型与 zod schema（`src/config/types.tools.ts`、`src/config/zod-schema.agent-runtime.ts`）、以及对应测试。删除后不需要再把它加进 `tools.deny`。

决定性证据是**它是本 fork 本地新增**：由 `f06a953496e (#39)` 引入，upstream OpenClaw 不存在该文件。删除**减少**而非增加与 upstream 的分叉面——这与「删除核心功能会加重 fork 维护成本」的直觉相反，是本决策最容易被未来读者误判的一点。

## Considered Options

1. **全局 `tools.deny` 禁用，保留实现（被否决）**：一行配置即可让模型看不见它，且随时可恢复。但工具实现、catalog 条目、policy 别名和 `tools.artifactJobs` 配置 schema 会长期留在源码里，每次 upstream 同步都要处理这些 fork-only 文件的冲突；配置补全和 Control UI 仍会展示一个永远不该被使用的能力；`AGENTS.md` / `SKILL.md` 里的「Do not use」死指令也没有理由删除。留下的是一个所有人都知道不能用、但谁都不敢删的中间状态。
2. **保留实现但移出 `TOOL_PROFILES.coding.allow`（被否决）**：粒度更小，只影响 coding profile。但本部署**没有任何 agent 设置 `tools.profile` / `allow` / `deny`**，唯一策略是全局 deny，因此改 profile 对实际运行零效果，只是让配置更难理解。
3. **永久保留 `tools.artifactJobs` 配置 schema、只删工具（被否决）**：永久兼容会让 schema 长期承诺一个不存在的能力。升级兼容期内仍保留 deprecated 字段一个发布周期；它只保证旧配置可校验和写回，不恢复工具实现，也不被运行时消费。

## Consequences

- 模型侧同时省下 `artifact_jobs` 的 tool schema 与「不要使用它」的提示词 token。
- 与 upstream 的分叉面缩小；后续同步 upstream 不再需要处理这批 fork-only 文件。
- `tools.artifactJobs` 暂时作为 deprecated 配置占位保留一个发布周期。旧值可通过 `validateConfig()`、`config.apply`、doctor 和 Control UI 写回，但没有运行时消费者；部署侧仍应尽快删除该字段，兼容期结束后再移除 schema。
- `"group:artifacts"` 别名**连同删除**，不留空数组：留空组会让 `tools.allow: ["group:artifacts"]` 静默变成「什么都不允许」，比直接报 unknown group 更难排查。本仓与 workspace 配置均无引用。
- 删除不可逆。上线前仍应查询一段约定时间范围内的 Langfuse called tool names，确认没有未记录的模型自主调用。
- `docs/plans/2026-05-28-otr-pptx-same-workspace-subagent.md` 与 `docs/research/openclaw-frontend-integration/openclaw-frontend-integration-research.md` 保留正文，只在开头标注该工具已移除、相关链路仅供历史参考。
- 若未来确实需要「agent 产出可下载工件」，应评估复用 [ADR-0003](0003-webui-file-delivery-as-artifact-publish.md) 的 artifact 通道，而不是恢复 `artifact_jobs`。
