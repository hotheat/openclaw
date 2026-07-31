# Implementation Plan: apply_patch 多 Provider 启用与上游安全对齐

## Overview

在 `openclaw-integration` 中经 `enabled` 开关对所有 Provider/模型启用 `apply_patch`，并将补丁解析、工作区边界、符号链接与硬链接防护、sandbox 路径处理对齐到 `../openclaw` 的实现。代码与依赖由当前仓库 PR 承载；部署配置的实际生效文件是 **Gateway 主机（`xiaolu@172.16.120.245`，systemd 服务 `openclaw-gateway`）上的 `~/.openclaw/openclaw.json` 默认路径**——该进程环境中没有 `OPENCLAW_CONFIG_PATH` 覆盖。本机 `../openclaw-workspace/openclaw.json` 是仓库记录副本，定位为「与远端保持一致的忠实记录」，最终随远端合并收敛（非运行时读取对象）。

参考实现基线为 `../openclaw` 的提交 `b0ccaa6eecbadeb326bc12e2f42fec5d7540fb24`。迁移时按行为和安全契约适配当前分支；文件安全层（fs-safe）本 PR 一步到位统一到上游终态。

## Interview Decisions (2026-07-29 grill)

1. **fs-safe 终态统一（facade 范围 + 错误码矩阵）**：`src/infra/fs-safe.ts` **逐字复制上游 152 行 facade**（含约 15 条 re-export、两个真实 helper `ensureAbsoluteDirectory`/`writeExternalFileWithinRoot`、两个 deprecated 包装 `readFileWithinRoot`/`writeFileWithinRoot`），删除手写 `SafeOpenError`/`openFileWithinRoot`/`readLocalFileSafely`/`openVerifiedLocalFile`。原计划「纯 re-export」表述不准确，已修正——逐字复制保证编译（上游 pin 的正是 `@openclaw/fs-safe@0.4.4`，6 个 import subpath `/advanced`、`/root`、`/errors`、`/path`、`/secure-file`、`/walk` 在 0.4.4 exports map 逐一确认），且避免裁剪制造的永久人工同步面。5 个调用方（`src/web/media.ts`、`src/browser/paths.ts`、`src/canvas-host/file-resolver.ts`、`src/media/server.ts`、`src/media/store.ts`）迁 `FsSafeError` 走**条件→code 对照矩阵**（见决策 11）：原「`FsSafeErrorCode` 是 `SafeOpenErrorCode` 超集、6 码原样匹配」只验证了 code 字符串存在，未验证「相同条件→相同 code」——手写 `openFileWithinRoot` 会把 symlink/not-file/path-mismatch 折叠成 `invalid-path`，fs-safe 抛细粒度 code（`symlink`/`not-file`/`path-alias`）。
2. **sandbox-paths 收紧（审计阴性）**：`assertSandboxPath` 内部 `assertNoSymlinkEscape` 替换为 `assertNoPathAliasEscape`（strict 默认，含硬链接拒绝），签名升级为 `allowFinalSymlinkForUnlink`/`allowFinalHardlinkForUnlink`；8 个现有调用方跟随收紧。2026-07-30 按最新基线复审：`stage-sandbox-media`、`feishu-file-outbox-router` 仍使用 `fs.copyFile`；新增的 `chat-attachment-materialize.ts` 会先 `fs.link(tempPath, targetPath)`，随后在 `finally` 删除 `tempPath`，持久目标恢复为 `nlink=1`，不会进入 strict-hardlink 拒绝形态；其余本机 + 远端 `src/`、`extensions/`、`~/.openclaw/extensions/` 无持久硬链接依赖。`assertNoHardlinkedFinalPath` 只查最终组件、已存在普通文件、`nlink>1` 才拒、`ENOENT` 放行、父目录不受影响——新写入目标与 staging 产物不受影响。上游 `stage-sandbox-media` 本就传空 policy 走 strict，姿态生产已验证。不引入上游 `sandbox-paths.ts` 携带的 `@openclaw/media-core`、`local-file-access`、`tmp-openclaw-dir`、`archive-path` 超范围依赖。
3. **pi-agent 不升级（已定案，非探索项）**：本 PR 保持 `@mariozechner/pi-*` `0.54.1`。no-op 交付「不写盘 + `No changes made...` 文本」，**不带 `terminate` 字段**（`0.54.1` 类型与 agent loop 均不消费）。`terminate` 支持列入独立的 pi-agent 升级 PR。已查证：`0.73.1` 才有 `terminate?: boolean`，跨 19 个 minor，且上游参考实现使用自研 runtime 而非 pi-agent-core。
4. **白名单 8 项（已被决策 8 作废）**：曾定为加入主力模型 `otr/gpt-5.6-sol` 与 `otr/gpt-5.5`、排除 deepseek 与 qwen；2026-07-29 晚些时候修订为纯开关启用，见决策 8。
5. **部署拓扑**：Gateway 在远端主机 systemd 运行，读取默认路径 `~/.openclaw/openclaw.json`（普通文件，非 symlink，无 env 覆盖）。远端 `~/github/openclaw-workspace/` 非 git 仓库且不含 openclaw.json。
6. **配置变更流程（远端活动文件为准）**：① integration 代码远端部署并经用户确认重启；② 部署即生效风险冒烟（apply_patch 仍禁用，见决策 9）；③ 直接编辑远端 `~/.openclaw/openclaw.json` 加入 `applyPatch` 块；④ 同一块变更回写本机 `../openclaw-workspace/openclaw.json` 并提交作记录。仓库副本与远端活动配置的双向漂移是已知遗留问题，不在本 PR 解决（副本定位为「最终与远端一致的忠实记录」）。
7. **空 `allowModels` = 全放行（保留上游语义）**：`enabled` 仍为显式 opt-in。（原「文档强调必须配白名单」的要求已被决策 8 调整：空名单即部署模式。）
8. **部署改为纯开关启用（2026-07-29 追加，修订决策 4）**：部署只设置 `enabled: true` + `workspaceOnly: true`，不配置 `allowModels`——按决策 7 语义即对所有 Provider/模型启用，含 qwen 与 deepseek（接受非 GPT 模型 patch 格式遵循度的质量风险；workspace-only、alias 防护等安全边界对所有模型一致生效）。代码保留 `allowModels` 配置面（上游对齐），未来需要收窄时使用完整模型标识。`enabled` 代码默认仍为禁用，开关在远端配置打开。
9. **两类部署风险显式区分（2026-07-29 追加）**：fs-safe 终态迁移与 sandbox-paths 收紧是「部署即生效」风险——与 `applyPatch.enabled` 无关，配置无法兜底，唯一回退是回滚代码 PR；apply_patch 注册/执行是「配置门控」风险，`enabled=false` 可兜底。部署顺序因此固定为：代码部署 → 媒体冒烟（apply_patch 仍禁用）→ 打开 `enabled` → apply_patch 冒烟。
10. **no-op 混合 hunk 保持上游静默省略（2026-07-29 追加）**：上游仅在「所有 hunk 都 no-op」时标 noOp 返回 `No changes made`；混合 patch（部分 no-op、部分修改）里 no-op 文件被静默从 summary 省略，返回 `Success` 只列修改文件。drop terminate 不触及混合路径（上游混合场景本无 terminate），integration 与上游逐字节等价、无信息缺口；最坏模型重发一次该文件的 patch 命中显式 `No changes made to X.` 自愈（一轮，非死循环）。不追加 `(no change)` 提示（会破坏与参考基线的 behavioral-test 断言锚，且成为永久文本 delta）。
11. **条件→code 对照矩阵（2026-07-29 追加）**：迁移前对 fixture 集合（逃逸路径 / 最终 symlink / symlink 父目录 / 目录而非文件 / too-large / not-found）分别用手写 `openFileWithinRoot`/`readLocalFileSafely` 与 fs-safe `openRootFile`/`root().read()` 各跑一遍，产出「条件→code」实测映射表，作为 5 调用方迁移的硬依据。按表逐 caller 迁移以「对外行为零漂移」为准：`media/server.ts` 补 `symlink`/`path-alias`/`not-file` → 400（旧行为折叠进 `invalid-path`→400，补 case 后 HTTP 语义零漂移，无需 shim）；`media/store.ts` 的 `path-mismatch` 走 `readLocalFileSafely`（手写版不折叠）、分支今天活着，按矩阵决定改写或删除（不留 dead code）；`browser/paths.ts` 仅判 `not-found`、`canvas-host` `instanceof`→`null`、`web/media` `not-found`/`not-file`/else→`invalid-path`，均按矩阵核对。
12. **裸 `allowModels` 条目启动告警（2026-07-29 追加）**：匹配器对裸 ID（无 `/`）的「任意 provider」支持是上游有意语义，匹配器 upstream-verbatim 不动；告警放配置加载层（仓库有 `legacy-config-detection` 先例），不阻断启动、不改 zod schema 结构。措辞中性说明而非「你配错了」：`allowModels entry "X" has no provider prefix and matches this model on ALL providers; use "provider/model" to scope to one provider`。注意多 relay 拓扑（otr/micu/sss/duckcoding 同名 GPT 模型）下裸 ID 恰是合法收窄写法。部署当前不配 allowModels，告警面向未来收窄场景。
13. **链接测试 POSIX 共享 fixture，macOS 不 skip（2026-07-29 追加）**：CI 已全部 `ubuntu-latest`（`.github/workflows/` 7 处 `runs-on`，`ci.yml` 在内），「strict-hardlink 在部署 OS 无自动化覆盖」不成立；macOS 与 Linux 的 `fs.link`/`lstat().nlink`/symlink 都是 POSIX 共有能力（实测 `ln a b` → `nlink=2` 同 inode），真正缺能力的是 Windows。新增 hardlink/symlink 测试沿用既有惯例 `it.runIf(process.platform !== "win32")`，本地 macOS 开发与 ubuntu CI 都真实执行。测试卫生注意：macOS `/tmp`→`/private/tmp` symlink（临时目录须先 `realpath` 再当 root，否则边界比较自己先挂）、APFS 默认大小写不敏感（路径比较用例注意）。排除 mock `nlink` 用于安全断言（真实 FS fixture 仅几行）。部署机 ext4 大小写敏感等特有行为由远端 Stage A 冒烟兜底。
14. **namespaced model 与 plugin SDK 兼容（2026-07-31）**：上游 matcher 在 `modelId` 自带 `/` 时不会拼接 provider，导致完整 `provider/modelId` 永不命中；原始 namespaced model ID 又会跨 provider 命中。integration 改为「只有无 `/` 的条目才是跨 provider 裸 ID；所有含 `/` 的条目按完整 provider/model 标识匹配」，并增加 namespaced model 回归测试。公共 `openclaw/plugin-sdk` 保留 deprecated `SafeOpenError`/`openFileWithinRoot`/`SafeOpenResult` 兼容出口，内部适配到 fs-safe 终态，避免外部插件升级后加载失败。
15. **文件身份与 container-only bridge 契约（2026-07-31）**：move 的同文件判断不能只比较区分大小写的路径字符串；在大小写不敏感文件系统中按 `dev`/`ino` 识别同一文件，写入后使用安全 rename 保留目标大小写，避免 write 后 remove 删除目标。sandbox bridge 保留现有 host-backed 主契约，另提供 `ContainerPathSandboxFsBridge` 窄契约；无 `hostPath` 时 bridge 必须自行保证容器内边界和 alias 安全，测试不再用类型强制断言绕过契约。

## Decision Summary

- 本 PR 必须引入 `@openclaw/fs-safe@0.4.4`（npm 已确认存在；0.4.4 与上游基线 pin 一致，0.5.0 已发布但本 PR 不浮动，记为后续评估项），并新增 `path-policy.ts`、`boundary-file-read.ts`、`path-alias-guards.ts`、`fs-safe-defaults.ts` 及其测试。
- `src/infra/fs-safe.ts` **逐字复制上游 152 行 facade**（含 helper 与 re-export）；删除手写实现与 `SafeOpenError`；5 个调用方按**条件→code 对照矩阵**迁 `FsSafeError`，对外行为零漂移为准（决策 1、11）。
- sandbox-paths 内部检查统一为 `assertNoPathAliasEscape`（strict 默认拒绝硬链接）；8 个调用方收紧（审计阴性，决策 2）。
- 保持 `applyPatch.enabled` 显式启用，未配置时仍禁用。该点有意保留当前部署的 opt-in 行为，不采用参考仓库的默认启用语义。
- 空 `allowModels` 保留上游「全放行」语义（决策 7）；部署即依赖该语义实现全 Provider 启用（决策 8）。代码保留 `allowModels` 配置面；未来收窄时只使用完整模型标识。
- 删除 OpenAI Provider 硬编码门禁（`isOpenAIProvider()`）。工具是否注册由 `enabled`、（可选）`allowModels` 白名单、工具策略和 sandbox 写权限共同决定。
- 本 PR 对齐补丁执行和文件安全语义，包括 no-op 检测（混合 hunk 保持上游静默省略，决策 10）；**不升级 pi-agent、不返回 `terminate`**（决策 3，已定案）。
- **不迁移 `outputSchema`**（已定案）：pi-agent-core `0.54.1` 与 `0.73.1` 的 `AgentTool` 类型均无 `outputSchema`，当前分支没有消费链；上游该字段由其自研 runtime 消费。
- 不迁移参考仓库的整套 `packages/agent-core`、`typebox` 包或 `@openclaw/normalization-core`。继续使用 `@sinclair/typebox`；model-policy 内联字符串归一化（等价 normalization-core 的 `toLowerCase`/`trim`），并保留决策 14 的 namespaced model 安全修正。
- 不在当前 PR 引入 `apply-patch-paths.ts` 和 `host-tool-param-parsers.ts`。它们服务于新版 `before_tool_call` 的 `derivedPaths` 契约，当前分支没有该宿主契约。
- 裸 `allowModels` 条目加载时发中性告警，不阻断（决策 12）。
- 部署即生效风险（fs-safe 迁移 + sandbox-paths 收紧）与配置门控风险（apply_patch 注册/执行）显式区分；config disable 非安全网（决策 9）。
- 链接测试 POSIX 共享 fixture、macOS 不 skip、CI=Linux（决策 13）。

## Requirements

- 经 `enabled` 开关对**所有 Provider/模型**启用 `apply_patch`（决策 8）：部署不配置 `allowModels`，含 qwen、deepseek（接受其 patch 质量风险；workspace-only 等安全边界对所有模型一致生效）。
- `tools.exec.applyPatch.enabled` 和 `tools.exec.applyPatch.workspaceOnly` 均显式设为 `true`。
- `allowModels` 机制保留：一旦配置，未命中完整模型白名单的 Provider 或模型不注册 `apply_patch`（单元测试锁定，部署不使用）；加载时对无 `/` 条目发中性告警（决策 12）。
- `tools.deny`、`tools.allow`、`exec` 别名策略及只读 sandbox 继续优先于功能开关。
- 本地非 sandbox 执行必须阻止路径逃逸、父目录别名、符号链接别名和硬链接别名。
- 删除文件时只允许删除最终符号链接或硬链接本身，不允许经别名遍历到工作区外目标。
- sandbox 执行必须兼容只有 `containerPath`、没有 `hostPath` 的 bridge（本部署 workspace-only 无 sandbox，但代码须编译通过且行为正确）。
- add、update、delete、move、EOF 插入、上下文插入、标点归一化和 no-op 不重写行为与参考实现一致；混合 hunk no-op 按上游静默省略（决策 10）。
- 配置变更必须落在远端 Gateway 实际读取的 `~/.openclaw/openclaw.json`；本机仓库副本做记录回写（定位为最终与远端一致的忠实记录）。

## Call Chain

```text
远端 ~/.openclaw/openclaw.json（默认路径，无 env 覆盖）
  -> config schema / AgentToolsConfig
  -> resolveExecConfig()
  -> enabled === true && isApplyPatchAllowedForModel(provider, model, allowModels=[])
       （空 allowModels -> true，即全放行）
  -> tool policy + sandbox write permission
  -> createApplyPatchTool()
  -> parsePatchText()
  -> resolvePatchPath()
  -> workspace boundary + path alias policy
  -> @openclaw/fs-safe root read/write/remove/mkdir
  -> patch summary / no-op result（无 terminate）
```

状态变化按执行顺序如下：

1. 配置解析得到 `enabled`、`workspaceOnly`；`allowModels` 未配置（空）。
2. 工具构建阶段：`enabled === true` 且 `isApplyPatchAllowedForModel` 对空名单返回 true，再叠加工具策略和 sandbox 权限，决定是否把 `apply_patch` 加入工具列表。
3. 工具执行阶段先解析全部 hunk，再逐个解析目标路径并执行边界检查（含 add/move 的父目录别名防护）。
4. 本地 workspace-only 路径通过 `@openclaw/fs-safe` 完成固定根目录内的读写；sandbox 路径通过 bridge 执行。
5. update 写前按 `normalizeUpdateComparison` 比较，无变化不写盘；成功后只返回实际发生的 added、modified、deleted；混合 hunk 中 no-op 文件按上游静默省略。

## Architecture Changes

- `package.json`、`pnpm-lock.yaml`：增加 `@openclaw/fs-safe@0.4.4`。
- `src/infra/fs-safe-defaults.ts`：配置 fs-safe 默认关闭 Python helper，允许环境变量显式覆盖。
- `src/infra/fs-safe.ts`：**逐字复制上游 152 行 facade**（re-export `FsSafeError`、`readLocalFileSafely`、`openLocalFileSafely`、`root`、`isPathInside`、`sanitizeUntrustedFileName`、`walkDirectory`、`readSecureFile`、`movePathToTrash`、`appendRegularFile`/`readRegularFile`/`statRegularFile` 等，以及 helper `ensureAbsoluteDirectory`/`writeExternalFileWithinRoot` 和 deprecated `readFileWithinRoot`/`writeFileWithinRoot`）；删除手写 `SafeOpenError`、`SafeOpenResult`、`SafeLocalReadResult`、`openFileWithinRoot`、`readLocalFileSafely`、`openVerifiedLocalFile`。
- 调用方迁移（按条件→code 矩阵，决策 11；5 个文件及其测试）：
  - `src/web/media.ts`（`not-found` / `not-file` / 其余→`invalid-path`，按矩阵核对）。
  - `src/browser/paths.ts`（仅判 `not-found`，折叠漂移基本不影响）。
  - `src/canvas-host/file-resolver.ts`（`instanceof FsSafeError` → `null`，按矩阵核对粒度）。
  - `src/media/server.ts`（**补 `case "symlink"`/`"path-alias"`/`"not-file"` → 400**，保 `invalid-path`→400、`not-found`→404；HTTP 语义零漂移）。
  - `src/media/store.ts`（`toSaveMediaSourceError` 全 code 映射；`path-mismatch` 走 `readLocalFileSafely` 本不折叠，按矩阵决定改写或删除，不留 dead code）。
- `src/infra/boundary-file-read.ts`：封装 `openRootFile` re-export、descriptor bounded read 及 `too-large` → `RangeError` 转换。
- `src/infra/path-alias-guards.ts`：导出 `PATH_ALIAS_POLICIES` 与 `assertNoPathAliasEscape`（来自 `@openclaw/fs-safe/advanced`）。
- `src/infra/path-guards.ts`：增加 Windows 边界计算所需的保留大小写路径归一化（`normalizeWindowsPathPreservingCase`）。
- `src/infra/abort-signal.ts`：统一构造 `AbortError`（`createAbortError`）。
- `src/agents/path-policy.ts`：提供 workspace/sandbox 相对路径边界转换（`toRelativeWorkspacePath`/`toRelativeSandboxPath`/`resolvePathFromInput`）和输入路径解析。
- `src/agents/sandbox-paths.ts`：内部 `assertNoSymlinkEscape` 替换为 `assertNoPathAliasEscape`（strict 默认，硬链接拒绝），签名升级为 `allowFinalSymlinkForUnlink` / `allowFinalHardlinkForUnlink`；8 个现有调用方（bash-tools.exec、bash-tools.shared、pi-tools.read、apply-patch、stage-sandbox-media、message-action-params（经 `resolveSandboxedMediaSource`）、sandbox-paths 自身）行为跟随收紧（审计阴性，决策 2）；**不引入**上游文件携带的 `@openclaw/media-core` / `local-file-access` / `tmp-openclaw-dir` / `archive-path` 改动。
- `src/agents/apply-patch-model-policy.ts`：从 `pi-tools.ts` 提取 `isApplyPatchAllowedForModel`；内联归一化等价 `@openclaw/normalization-core` 的 `toLowerCase`/`trim`。无 `/` 的裸 ID 可跨 provider 匹配；含 `/` 的条目只按完整 provider/model 标识匹配，修复上游 namespaced model 漏拼 provider 的授权缺口。部署使用空 `allowModels`。
- `src/plugin-sdk/fs-safe-compat.ts`：为外部插件保留 deprecated `SafeOpenError`/`openFileWithinRoot`/`SafeOpenResult`，并适配到 `root().open()`；新代码继续使用 `FsSafeError`/`root`/`OpenResult`。
- `src/agents/apply-patch.ts`：迁移 fs-safe 文件操作（`openRootFile` 读、`fsRoot(cwd)` 写/删/建目录）、alias 防护（`assertPatchParentPath` + `assertNoExistingParentAliases`）、sandbox host/container 路径兼容、**新增 no-op 不写盘**（`normalizeUpdateComparison` + `noOpPaths`）；混合 hunk 按上游静默省略（决策 10）；不含 `terminate`、不含 `outputSchema`。
- `src/agents/sandbox/fs-bridge.ts`：增加 `ContainerPathSandboxFsBridge`，让 apply_patch 可显式接受无 `hostPath` 的 bridge，同时保留其他调用方的 host-backed `SandboxFsBridge` 类型保证。
- `src/agents/apply-patch-update.ts`：迁移纯插入坐标（`changeContext && !isEndOfFile ? lineIndex : ...` + `lineIndex = insertionIndex` 回写）与 `.at()` 越界安全访问；4 级容错匹配与 EOF 哨兵重试已存在。已核实当前与上游仅此两处真实差异，标点归一化 regex 版为等价重构。
- `src/agents/pi-tools.ts`：移除 `isOpenAIProvider()` 判断，注册条件改为 `enabled === true && isApplyPatchAllowedForModel(...)`；继续组合工具策略和 sandbox 权限。
- `src/config/types.tools.ts`、`src/config/schema.help.ts` 及加载层：删除「仅 OpenAI 模型」描述；加载时对无 `/` 的 `allowModels` 条目发中性告警（措辞见决策 12），不阻断启动、不改 zod schema 结构；说明空名单 = 全放行（当前部署模式）与可选 `provider/model` 收窄。
- `docs/tools/apply-patch.md`、`docs/tools/index.md` 及对应中文文档：说明空 `allowModels` = 全放行语义、可选 `provider/model` 收窄、workspace-only 安全边界与裸 ID 告警。
- 远端 `~/.openclaw/openclaw.json` + 本机 `../openclaw-workspace/openclaw.json` 回写：部署 `{enabled:true, workspaceOnly:true}` 配置（决策 6 流程）。

## Implementation Steps

### Phase 1: 固定基线与依赖

1. **建立功能分支并记录参考基线**（Files: repository metadata）
   - Action：从 `otr-integration-v2.22` 创建 `feat/apply-patch-upstream-alignment`；记录参考仓库提交 `b0ccaa6e...`。
   - Why：当前分支禁止直接提交，参考仓库后续变化不能隐式进入本 PR。
   - Risk：低。

2. **引入 fs-safe 依赖**（Files: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`）
   - Action：固定 `@openclaw/fs-safe` 为 `0.4.4`（与上游基线 pin 一致；不浮动到 0.5.0），更新 lockfile；仅在安装实际要求 lifecycle script 时调整 pnpm build allowlist。
   - Why：参考实现的 root-scoped I/O、descriptor open 和 alias guard 均由该包提供。
   - Dependencies：步骤 1。
   - Risk：中；需要确认 Node 22 和当前 pnpm 配置下安装结果可复现。

（原「pi-agent 兼容性门」步骤已按决策 3 删除：本 PR 保持 `0.54.1`，不做临时分支升级验证。）

### Phase 2: 文件安全基础层（fs-safe 终态统一）

1. **增加 fs-safe 默认配置**（Files: `src/infra/fs-safe-defaults.ts` + test）
   - Action：迁移参考实现的 Python mode 默认关闭逻辑，保留 `FS_SAFE_PYTHON_MODE` 和 `OPENCLAW_FS_SAFE_PYTHON_MODE` 显式覆盖。
   - Risk：低。

2. **产出「条件→code 对照矩阵」**（Files: 临时 fixture 脚本 / 测试；结果写入本计划）
   - Action：对 fixture 集合（逃逸路径 / 最终 symlink / symlink 父目录 / 目录而非文件 / too-large / not-found）分别用手写 `openFileWithinRoot`/`readLocalFileSafely` 与 fs-safe `openRootFile`/`root().read()` 各跑一遍，记录「条件→code」实测映射表。
   - Why：决策 11——验证「相同条件→相同 code」，而非仅 code 字符串超集。
   - Dependencies：步骤 1。
   - Risk：中；矩阵是 5 个调用方迁移的硬依据。

3. **fs-safe facade 切换为上游终态（逐字复制）**（Files: `src/infra/fs-safe.ts`, `src/infra/fs-safe.test.ts`）
   - Action：**逐字复制上游 152 行 facade**（re-export + helper + deprecated 包装）；删除手写 `SafeOpenError` 与全部本地实现；测试改写为按矩阵验证 facade 语义（symlink 拒绝、root 逃逸、too-large、not-found 与旧手写实现等价）。
   - Why：决策 1——消除双实现，直接对齐上游终态，零漂移同步。
   - Dependencies：步骤 1、2。
   - Risk：高；这是媒体/浏览器/canvas 链路的公共底座。

4. **迁移 5 个调用方到 FsSafeError**（Files: `src/web/media.ts`, `src/browser/paths.ts`, `src/canvas-host/file-resolver.ts`, `src/media/server.ts`, `src/media/store.ts` 及各自测试）
   - Action：`SafeOpenError` → `FsSafeError`（`instanceof` + `err.code` 按矩阵匹配）；`openFileWithinRoot(rootDir, relativePath)` 调用点改用 fs-safe 等价 API（`openRootFile({absolutePath, rootPath, boundaryLabel})` 或 `root(rootDir).read(rel)`）。`media/server.ts` 补 `symlink`/`path-alias`/`not-file`→400；`media/store.ts` 按矩阵决定 `path-mismatch` 分支去留。逐文件跑既有测试。
   - Why：决策 11——上游没有这 5 个文件的范本，迁移准则是「错误契约行为等价（零漂移）」。
   - Dependencies：步骤 2、3。
   - Risk：高；媒体链路是 Feishu 文件投递生产关键路径，任何 code 映射偏差都会改变对外错误行为。

5. **增加边界读取 facade**（Files: `src/infra/boundary-file-read.ts`, `src/infra/boundary-file-read.test.ts`）
   - Action：迁移 `openRootFile` re-export、bounded descriptor read 及 `too-large` → `RangeError` 转换。
   - Dependencies：步骤 1。
   - Risk：中。

6. **增加 alias guard facade**（Files: `src/infra/path-alias-guards.ts`, `src/infra/path-alias-guards.test.ts`）
   - Action：迁移 `PATH_ALIAS_POLICIES` 和 `assertNoPathAliasEscape` 导出。测试用 POSIX 共享 fixture（`it.runIf(process.platform !== "win32")`）。
   - Dependencies：步骤 1。
   - Risk：中；macOS/Linux 真实执行，Windows skip。

7. **增加路径边界策略**（Files: `src/agents/path-policy.ts`, `src/agents/path-policy.test.ts`, `src/infra/path-guards.ts`）
   - Action：迁移 workspace/sandbox 相对路径计算；补充 Windows 保留大小写归一化。
   - Dependencies：步骤 6。
   - Risk：中；重点覆盖 `..foo` 合法文件名、根目录目标、Windows drive path 和 extended-length path。

8. **sandbox-paths 内部检查统一收紧**（Files: `src/agents/sandbox-paths.ts`, `src/agents/sandbox-paths.test.ts`）
   - Action：`assertNoSymlinkEscape` 替换为 `assertNoPathAliasEscape`（strict 默认）；`assertSandboxPath` 签名升级为 `allowFinalSymlinkForUnlink` / `allowFinalHardlinkForUnlink`（原唯一传 flag 的调用方 apply-patch 的 `allowFinalSymlink: purpose === "unlink"` 改为传 `aliasPolicy`）；**不引入**上游文件携带的 media-core / local-file-access / tmp-openclaw-dir / archive-path 改动。
   - Why：决策 2——审计阴性，单实现方向，硬链接检测对全部 8 个调用方是方向正确的安全收紧。
   - Dependencies：步骤 6、7。
   - Risk：中；8 个调用方需定向回归。审计已确认无持久 `nlink>1` 依赖：staging 用 `fs.copyFile`，WebChat attachment 的瞬时 `fs.link` 会立即解除源链接；Stage A 冒烟含 Feishu 收发 + 硬链接拒绝兜底。

### Phase 3: 对齐 apply_patch 执行器

1. **迁移统一取消错误**（Files: `src/infra/abort-signal.ts`, `src/agents/apply-patch.ts`）
   - Action：用 `createAbortError("Aborted")` 替代两处手工构造。
   - Risk：低。

2. **迁移本地 workspace-only I/O**（File: `src/agents/apply-patch.ts`）
   - Action：读使用 `openRootFile` 固定 descriptor（`readFileSync(fd)` + `closeSync`）；写、删、建目录使用 `fsRoot(cwd)`；`workspaceOnly: false` 保持原生 fs 路径。
   - Dependencies：Phase 2 步骤 3、5、7。
   - Risk：高；这是主要安全边界。

3. **迁移 alias 与父目录防护**（Files: `src/agents/apply-patch.ts`, `src/agents/sandbox-paths.ts`）
   - Action：**新增** `assertPatchParentPath`（add/move 前检查已存在父目录）与 `assertNoExistingParentAliases`（父目录段 symlink 遍历拒绝）；update 使用 strict policy；delete 使用 unlink-target policy（`allowFinalSymlinkForUnlink`/`allowFinalHardlinkForUnlink`）；sandbox 有 `hostPath` 时再次执行根目录和 alias 校验。
   - Dependencies：Phase 2 步骤 6、8。
   - Risk：高。

4. **兼容 container-only sandbox**（File: `src/agents/apply-patch.ts`）
   - Action：执行路径使用 `resolved.hostPath ?? resolved.containerPath`，展示路径优先 `relativePath`。（本部署 workspace-only 无 sandbox，但代码须正确。）
   - Risk：中。

5. **迁移 patch parser 与 update 语义**（Files: `src/agents/apply-patch.ts`, `src/agents/apply-patch-update.ts`）
   - Action：迁移 heredoc envelope 容错、同路径 move（`moveResolvesToSource`）、纯插入坐标（`changeContext && !isEndOfFile ? lineIndex : ...` + `lineIndex` 回写）、`.at()` 边界安全访问。已核实 apply-patch-update.ts 仅此两处真实差异；4 级容错匹配与 EOF 哨兵重试已存在，标点归一化 regex 版为等价重构。
   - Dependencies：步骤 2。
   - Risk：中。

6. **实现 no-op 不写盘（无 terminate）**（File: `src/agents/apply-patch.ts`）
   - Action：写前按换行归一化（`normalizeUpdateComparison`）比较内容；无实际变化时不写盘、返回 `No changes made to ...`。noOp 仅在「所有 hunk 都 no-op」时置位（混合 hunk 保持上游静默省略语义，决策 10）。**不返回 `terminate` 字段**（决策 3）；`terminate` 支持随独立 pi-agent 升级 PR 交付。
   - Risk：中；必须保留 CRLF 和 EOF 状态测试。残余风险：无 terminate 时模型可能重复提交 no-op patch，靠文本提示 + 一轮自愈缓解。

（原「outputSchema」步骤已按 Decision Summary 定案删除：当前分支无消费链，不迁移。）

### Phase 4: 模型门禁与工具注册

1. **提取模型策略**（Files: `src/agents/apply-patch-model-policy.ts`, `src/agents/apply-patch-model-policy.test.ts`）
   - Action：从 `pi-tools.ts` 提取 `isApplyPatchAllowedForModel`（upstream-verbatim）；内联大小写/空白归一化（等价 normalization-core 的 `toLowerCase`/`trim`），不引入 `@openclaw/normalization-core`。支持裸 ID 与完整 ID；部署不配置白名单（决策 8），未来收窄时只使用完整 ID。
   - Risk：低。

2. **移除 Provider 硬编码限制**（File: `src/agents/pi-tools.ts`）
   - Action：删除 `isOpenAIProvider()`；注册条件改为 `enabled === true && isApplyPatchAllowedForModel(...)`。
   - Why：决策 8/9 的前提——otr、micu、sss、duckcoding 均是 OpenAI-compatible Provider 但 Provider 名不等于 `openai`，原门禁导致 apply_patch 从未注册。
   - Risk：低；空白名单代表允许所有模型（决策 7）是部署既定姿态，扩大授权是预期效果，收口手段是 `enabled` 开关与可选 `allowModels`。

3. **保留现有安全门**（Files: `src/agents/pi-tools.ts`, `src/agents/pi-tools.policy.ts`）
   - Action：保持 `workspaceOnly || applyPatch.workspaceOnly !== false`、只读 sandbox 禁用以及 `exec` allowlist 对 `apply_patch` 的别名授权。
   - Risk：低。

4. **更新配置类型、帮助文本与裸 ID 告警**（Files: `src/config/types.tools.ts`, `src/config/schema.help.ts` 及加载层）
   - Action：将说明从「OpenAI models」改为「allowlisted/all models（空 allowModels = 全放行）」；加载时对无 `/` 的 `allowModels` 条目发中性告警（措辞见决策 12），不阻断启动、不改 zod schema 结构；schema 保持兼容。
   - Why：决策 12——把「未来收窄用完整 ID」从纸面指引变成运行时提示；裸 ID 在多 relay 拓扑下是合法收窄写法，故仅 warn。
   - Risk：低。

### Phase 5: 文档与部署配置

1. **更新工具文档**（Files: `docs/tools/apply-patch.md`, `docs/tools/index.md`, `docs/zh-CN/tools/apply-patch.md`, `docs/zh-CN/tools/index.md`）
   - Action：删除 OpenAI-only 表述；说明空名单 = 全放行语义与默认禁用，附可选完整 `provider/model` 白名单收窄示例与裸 ID 告警。
   - Risk：低。

2. **远端部署代码**（Files: deployment artifacts）
   - Action：integration PR 合并后，按现有部署流程更新远端 `~/github/openclaw-integration` 并构建；Gateway 重启前经用户确认。
   - Why：此时 `applyPatch` 未配置保持禁用；但 fs-safe 迁移与 sandbox-paths 收紧**部署即生效**（决策 9）。
   - Risk：中；部署即生效风险由下一步媒体冒烟兜底。

3. **部署后媒体冒烟（配置变更前）**（Files: none；远端非生产会话）
   - Action：在**未改配置**（apply_patch 仍禁用）状态下执行 Smoke Stage A。
   - Why：决策 9——先单独验证「部署即生效」风险；媒体/staging 回归在此暴露时直接回滚代码 PR，不涉及配置。
   - Dependencies：步骤 2。
   - Risk：低。

4. **远端配置变更 + 仓库回写**（Files: 远端 `~/.openclaw/openclaw.json`, 本机 `../openclaw-workspace/openclaw.json`）
   - Action（决策 6）：步骤 3 通过后，直接编辑远端活动配置加入下方 `applyPatch` 块；再把同一块回写本机 workspace 仓库副本并提交作记录。不做整文件覆盖，避免冲掉远端近期变更（两份文件已存在漂移，远端更新；副本定位为最终与远端一致的忠实记录，整体收敛留后续）。
   - Dependencies：步骤 3 通过。
   - Risk：中；漂移是已知遗留问题。

目标配置块（决策 8：纯开关，无 `allowModels`）：

```json
{
  "tools": {
    "exec": {
      "applyPatch": {
        "enabled": true,
        "workspaceOnly": true
      }
    }
  }
}
```

5. **apply_patch 冒烟验证**（Files: none；经 `ssh xiaolu@172.16.120.245` 只读检查 + 非生产会话）
   - Action：执行 Smoke Stage B。
   - Dependencies：步骤 4。
   - Risk：低。

## Testing Strategy

### Unit Tests

- `src/agents/apply-patch-model-policy.test.ts`
  - 空 `allowModels`（部署形态）返回 true（全放行）。
  - 完整 Provider/model 匹配（含 `otr/gpt-5.6-sol`）；大小写与首尾空白归一化。
  - model ID 自带 `/` 时，完整 `provider/modelId` 命中，同模型异 Provider 拒绝，未加 Provider 的 namespaced ID 不跨 Provider 命中。
  - Provider 不同但 model ID 相同：裸条目命中、完整条目不命中。
  - 空 model ID、空白条目。
- `src/agents/path-policy.test.ts`
  - 相对路径、绝对路径、根路径、父目录逃逸。
  - `..foo` 合法文件名。
  - Windows drive、大小写保留和 extended-length path。
- `src/infra/boundary-file-read.test.ts`
  - `openRootFile`/`root` helper 导出。
  - descriptor bounded read 和超限 `too-large` → `RangeError`。
- `src/infra/path-alias-guards.test.ts`（POSIX 共享 fixture，`it.runIf(process.platform !== "win32")`）
  - strict policy 拒绝 symlink/hardlink。
  - unlink-target 只允许删除最终别名。
- `src/infra/fs-safe.test.ts`（改写，按条件→code 矩阵断言）
  - facade 行为：symlink 拒绝、root 逃逸、too-large、not-found 语义与旧手写实现等价。

### 条件→code 对照矩阵（决策 11）

迁移前固化映射表，作为 5 调用方迁移与回归的硬依据：fixture（逃逸路径 / 最终 symlink / symlink 父目录 / 目录而非文件 / too-large / not-found）× {手写版, fs-safe 版} 的实测 code。

2026-07-30 在 macOS 上以真实文件、符号链接和目录 fixture 实测（临时目录先 `realpath`）：

```text
逃逸路径      old open=invalid-path  openRoot=validation  root.read=outside-workspace
最终 symlink  old open=invalid-path  openRoot=ok          root.read=symlink
symlink 父层  old open=invalid-path  openRoot=validation  root.read=outside-workspace
目录          old open=invalid-path  openRoot=validation  root.read=not-file
too-large     old open=N/A           openRoot=N/A         root.read=too-large
not-found     old open=not-found     openRoot=path        root.read=not-found
```

直接文件读取的迁移矩阵：

```text
最终 symlink  old read=symlink    fs-safe read=symlink
目录          old read=not-file   fs-safe read=not-file
too-large     old read=too-large  fs-safe read=too-large
not-found     old read=not-found  fs-safe read=not-found
```

结论：5 个既有调用方不能用 `openRootFile` 替代旧 rooted helper，否则最终 symlink 会从拒绝变为放行，且失败类型不再是 `FsSafeError`。需要 descriptor 的 rooted 调用方改用 `root(rootDir).open(relativePath, { hardlinks: "allow", nonBlockingRead: true })`；直接绝对路径调用方改用 `root(dirname).read(basename, { hardlinks: "allow", nonBlockingRead: true })`。两个显式选项分别保留旧实现接受硬链接和通过 `O_NONBLOCK` 拒绝 FIFO 而不阻塞的语义。`apply_patch` 的固定 descriptor 读取仍按上游使用 `openRootFile`，并叠加此前的 strict alias guard。

编译审计另发现 `extensions/webui-artifacts/src/webui-artifact-tool.ts` 仍直接依赖已删除的 `SafeOpenError`/`openFileWithinRoot`，一并按相同 descriptor 语义迁移，并由 hardlink/FIFO 回归测试锁定。2026-07-31 合并最新基线 #107 时，新加入的 `extensions/feishu/src/subagent-handoff-delivery.ts` 也依赖旧 helper；该调用方同步迁移，并将 plugin SDK 出口更新为 `FsSafeError`/`root`/`OpenResult`。

### fs-safe 调用方迁移回归

逐文件运行既有测试，确认 `FsSafeError` 迁移后错误分支行为不变（按矩阵）：

- `src/web/media`（`not-found` / `not-file` / else→`invalid-path`）。
- `src/browser/paths`（`not-found`）。
- `src/canvas-host/file-resolver`（`instanceof` → `null`）。
- `src/media/server`（`invalid-path` / `not-found`，补 `symlink`/`path-alias`/`not-file`→400）。
- `src/media/store`（`toSaveMediaSourceError` 全 code 映射；`path-mismatch` 按矩阵去留）。

### sandbox-paths 收紧回归（POSIX fixture）

- `src/agents/sandbox-paths.test.ts`（`it.runIf(process.platform !== "win32")`）：strict 默认下硬链接拒绝、unlink 双参数语义。
- 8 个调用方的既有定向测试：`bash-tools`、`pi-tools.read`、`message-action-params`、`stage-sandbox-media` 等，确认硬链接收紧无误伤（审计已阴性）。

### apply_patch Behavioral Tests

扩展 `src/agents/apply-patch.test.ts`，至少覆盖：

- add、update、delete、move 和同路径 move。
- 大小写不敏感文件系统上的 case-only move：目标文件保留、内容正确、目录项大小写更新。
- 上下文插入（`changeContext` 锚定坐标）和多个插入点坐标稳定。
- EOF 插入、标点归一化、heredoc envelope。
- no-op 不写盘、不改变 mtime、CRLF/EOF 状态保持；结果**不含 `terminate`**；混合 hunk（部分 no-op）按上游语义静默省略 no-op 文件（决策 10）。
- 相对与绝对路径逃逸。
- 父目录 symlink、最终 symlink、broken symlink、hardlink（POSIX fixture）。
- 删除最终 symlink 本身。
- sandbox `hostPath` 越界拒绝（代码正确性，本部署不触发）。
- sandbox 只有 `containerPath` 时仍执行成功（代码正确性）。
- abort 前和多 hunk 中途 abort。

### Tool Registration Tests

- 更新 `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`：
  - `enabled: true` 且未配置 `allowModels` 时，任意 Provider/模型注册（含 `otr/gpt-5.6-sol`、`qwen-openai/qwen/qwen3.6-27b` 正例，即部署全放行模式，决策 8）。
  - 配置 `allowModels` 时按完整 ID 收窄：命中注册、未命中不注册、同模型 ID 的未授权 Provider 不注册（机制保留，部署不使用）。
  - `isOpenAIProvider` 已删除：provider=`openai` 与 provider=`otr` 行为一致。
  - 未配置 `enabled` 时不注册。
- 更新 `src/agents/pi-tools-agent-config.test.ts`：
  - global/agent-specific 配置优先级。
  - `workspaceOnly` 默认和显式 `false`。
  - 只读 sandbox 不注册。
- 保持 `src/agents/pi-tools.policy.test.ts`：
  - `allow: ["exec"]` 允许 `apply_patch`。
  - 显式 deny 仍优先。
- 扩展 `src/agents/pi-tools.sandbox-mounted-paths.workspace-only.test.ts`：
  - host/container 路径映射和越界拒绝（代码正确性）。
- 新增裸 ID 告警测试（决策 12）：`allowModels` 含无 `/` 条目时加载发中性 warn；完整 ID 不触发；均不阻断启动。

### Dependency and Runtime Verification

按顺序执行窄范围验证：

1. `pnpm install --frozen-lockfile`，确认 lockfile 与 fs-safe 安装可复现。
2. 对新增和修改文件运行 formatter check。
3. 运行上述定向 Vitest 文件，不运行全量 `pnpm test` 或 `pnpm test:fast`。
4. 运行类型检查。
5. `git diff --check`。

### Deployment Smoke Test

远端主机（`ssh xiaolu@172.16.120.245`）使用临时工作区和非生产会话验证，分两个阶段（决策 9）：

**Stage A（代码部署后、配置变更前；apply_patch 仍禁用）**

1. Feishu 文件收发抽查，确认 fs-safe 迁移无回归。
2. 发送硬链接文件，预期被拒（sandbox-paths 收紧负例）。
3. 任一模型工具清单不含 `apply_patch`（未配置保持禁用）。

**Stage B（配置变更后）**

1. 工具清单包含 `apply_patch`：至少抽查 primary `otr/gpt-5.6-sol` 与 `qwen-openai/qwen/qwen3.6-27b` 各一（决策 8 全放行正例）。
2. 在工作区内执行 add、update、delete。
3. 使用 `../`、绝对外部路径、父目录 symlink 和 hardlink 触发拒绝。
4. no-op patch 不修改文件 mtime。
5. 重启或会话重建后配置仍生效。

Gateway 重启必须在实施阶段单独获得用户确认。

## Risks & Mitigations

- **两类部署风险不可混同（决策 9）**
  - 「部署即生效」类：fs-safe 迁移 + sandbox-paths 收紧，代码上线瞬间作用于 Feishu 媒体链路，`enabled` 配置无法兜底，唯一回退是回滚代码 PR。Mitigation：Stage A 媒体冒烟（Feishu 收发 + 硬链接拒绝）置于配置变更之前。
  - 「配置门控」类：apply_patch 注册/执行，代码默认禁用，`enabled=false` 即可兜底。Mitigation：先部署代码，Stage A 通过后再开配置。
- **条件→code 映射漂移（决策 11）**
  - Mitigation：迁移前产出对照矩阵；`media/server` 补 case 保持 HTTP 零漂移；`media/store` 按矩阵决定 `path-mismatch` 去留；逐调用方跑既有测试。
- **fs-safe 终态迁移影响媒体生产链路**
  - Mitigation：矩阵锁定行为；Stage A 冒烟含 Feishu 文件收发抽查；回归时整体回滚 PR。
- **sandbox-paths 硬链接收紧误伤现有链路（决策 2）**
  - Mitigation：审计已阴性（无持久 `nlink>1`；WebChat attachment 的瞬时硬链接会立即解除源链接；`assertNoHardlinkedFinalPath` 仅查已存在 `nlink>1`）；8 个调用方定向测试；确有依赖硬链接的调用方时按调用方显式放宽并记录。
- **配置仓库副本与远端活动配置双向漂移**（已存在，遗留问题）
  - Mitigation：本次采用「远端加块 + 仓库回写」局部变更，不整文件覆盖；漂移收敛不在本 PR 范围。
- **全 Provider 启用后弱模型 patch 兼容性**（决策 8 接受的质量风险）
  - Mitigation：安全边界（workspace-only、alias 防护、工具策略、只读 sandbox）对所有模型一致生效，失败形态仅是 patch 应用报错；观察到特定模型滥用时用 `allowModels` 收窄或 `enabled=false` 关闭（机制已由单测锁定）。
- **symlink/hardlink 检查存在平台差异**（决策 13）
  - Mitigation：使用 `@openclaw/fs-safe` policy；POSIX 共享 fixture 在 macOS+Linux 真实执行（`runIf(!==win32)`）、Windows skip；macOS 注意 `/tmp`→`/private/tmp` 与 APFS 大小写不敏感卫生；Linux 部署环境由 Stage A 冒烟补证。
- **无 terminate 时模型可能循环重试 no-op patch**（决策 3 残余风险）
  - Mitigation：`No changes made...` 文本提示 + 一轮自愈（决策 10）；terminate 随独立 pi-agent 升级 PR 交付。
- **no-op 归一化掩盖真实换行变化**
  - Mitigation：覆盖 LF、CRLF、无末尾换行、空文件和单空行测试。

## Rollback Plan

分流（决策 9）：媒体/staging 回归（部署即生效类）直接回滚 integration PR，改配置无意义；apply_patch 行为问题（配置门控类）按下列步骤先关配置。

1. 在远端 `~/.openclaw/openclaw.json` 中删除 `tools.exec.applyPatch` 或将 `enabled` 设为 `false`，并回写仓库副本。
2. 经用户确认重启 Gateway，验证所有模型工具清单均不再包含 `apply_patch`。
3. 若仅配置回滚不能恢复稳定性（含 fs-safe 迁移引发的媒体链路回归），再回滚 integration PR。
4. 保留 fs-safe 依赖时也不得让未配置的 `apply_patch` 自动启用。

## Success Criteria

- [ ] integration PR 引入 `@openclaw/fs-safe@0.4.4` 和要求的安全 facade。
- [ ] `src/infra/fs-safe.ts` 为上游 152 行 facade 逐字复制；`SafeOpenError` 及手写实现已删除；条件→code 对照矩阵已产出；5 个调用方全部迁 `FsSafeError` 且既有测试通过、对外行为零漂移。
- [ ] `path-policy.ts`、`boundary-file-read.ts`、`path-alias-guards.ts`、`fs-safe-defaults.ts` 有对应单元测试。
- [ ] `assertSandboxPath` strict 默认拒绝硬链接；8 个调用方定向测试通过；审计无持久 `nlink>1` 依赖。
- [ ] `apply_patch` 的 add/update/delete/move/no-op 行为与参考基线一致（不含 terminate / outputSchema）；混合 hunk 保持上游静默省略。
- [ ] workspace-only 模式拒绝 traversal、symlink、hardlink 和父目录 alias 逃逸。
- [ ] container-only sandbox 路径可执行（代码正确性），hostPath 越界被拒绝。
- [ ] case-only move 在大小写不敏感文件系统上不丢文件，并按目标大小写完成 rename。
- [ ] `enabled: true` 且未配置 `allowModels` 时，所有 Provider/模型注册工具（运行时抽查含 primary `otr/gpt-5.6-sol` 与 qwen）。
- [ ] `allowModels` 收窄机制由单元测试锁定（完整 ID 命中/未命中/同模型异 Provider 负例）。
- [ ] namespaced model ID 必须使用完整 provider/modelId，不能经裸 ID 跨 Provider 授权。
- [ ] `openclaw/plugin-sdk` 保留 deprecated safe-open 兼容出口，外部插件的旧命名导入和基础读取行为可用。
- [ ] 裸 `allowModels` 条目加载发中性告警，完整 ID 不触发，均不阻断启动。
- [ ] Stage A 媒体冒烟在配置变更之前通过。
- [ ] 未配置 `enabled`、工具策略拒绝或只读 sandbox 时不注册工具。
- [ ] pi-\* 保持 `0.54.1`；实现中不存在 runtime 无法消费的 `terminate` / `outputSchema` 伪字段。
- [ ] 链接测试 POSIX 共享 fixture 在 macOS 与 Linux 真实执行（`runIf(!==win32)`），CI=Linux 覆盖部署 OS。
- [ ] 远端 Gateway（`~/.openclaw/openclaw.json` 默认路径）配置为 `{enabled:true, workspaceOnly:true}` 且无 `allowModels`，有运行时证据；仓库副本已回写。
- [ ] 未经用户确认不执行 Gateway 重启。
