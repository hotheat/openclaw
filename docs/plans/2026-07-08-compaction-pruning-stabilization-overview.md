# Compaction & Pruning 稳定化：六层漏斗总览

> 本文是对 `2026-07-08-compaction-pruning-stabilization.md` 实现计划的架构性总结，便于回顾与分享。
> 配套实现见 PR #79（`fix/compaction-pruning-stabilization`）。

## TL;DR

把原来「估算 → 超线 → 模型摘要 → 超时 → 空转 → 重复」的**单点重路径**，改成一个**比例递减的六层漏斗**：前两层（源头封顶 + 确定性裁剪）把大多数长会话拦在 compaction 线以下；中间两层（输入预算 + 调用预算）让真触发时也快得起、跑得完；最后一层 emergency 保证无论如何都落状态。第 0 层校准和第 6 层解耦，确保这套比例对 OTR/DeepSeek 等非 Anthropic 模型同样生效。

---

## 1. 背景：崩溃场景与死循环

一个 **3.0 MB 的超长会话**（约 **45 万 tokens**）在 preflight 估算阶段超过 context window + reserveTokens，触发**模型摘要式 compaction**。`compaction-safeguard` 把海量历史分块、**串行多次调用模型**做摘要，**300 秒安全网超时后 abort，却没有落下任何 compaction entry**。后果：

> 下一轮 prompt 又把同一个膨胀会话原样送进同样的 compaction 路径，每轮都卡死重来，永远走不出去。

---

## 2. 根因：比例自缩放套路与「静默回退」陷阱

### 2.1 套路：所有阈值都是 contextWindow 的比例

系统支持一堆不同窗口的模型（32K / 200K / 1M…）。阈值不写绝对值，而写成 `contextWindow` 的比例，让阈值跟着模型自动缩放：

```
preflight 目标   = contextWindow × 0.6
单条 toolResult  = contextWindow × 0.04 / 0.03
compaction 输入  = contextWindow × 0.5
emergency 尾部   = contextWindow × 0.3
compaction 触发线 = contextWindow − reserveTokens
```

只要 `contextWindow` 准确，这套比例对任何模型都自动合适。这是 **single-source-of-truth**（单一数据源）设计——`contextWindow` 是唯一真实来源，6 个阈值都从它派生。正常情况下这是优点：DRY、内部一致、自适应。

### 2.2 为什么失真：单点错误扇出

阈值 = 比例 × contextWindow。当 `contextWindow` 被静默回退到 `DEFAULT_CONTEXT_TOKENS = 200000`、而真实窗口是别的值时，**每个阈值的绝对值都按同一个错误基础去算**，没有任何一个能幸免：

```
真实值错了 → 0.6×错、0.04×错、0.5×错 → 六层漏斗全偏
```

举例：**模型真实窗口只有 128K**，但配置缺失 → 系统静默当成 200K。

| 阈值                              | 系统以为（按 200K） | 本应（按 128K） | 后果                                                |
| --------------------------------- | ------------------- | --------------- | --------------------------------------------------- |
| preflight 目标 0.6                | 120K                | 77K             | 塞 120K 历史，真实 128K 窗口装不下 → **overflow**   |
| compaction 触发线（window − 20K） | 180K                | 108K            | 真实 108K 就该压，系统拖到 180K 才压 → **晚压 70K** |
| 单条 toolResult 0.04×4            | 32K 字符            | 20K 字符        | 一条输出就吃掉真实窗口 1/4                          |

反向也成立：真实窗口 > 200K（如 1M）时，系统在 120K 就过早裁剪，**过度裁剪**、白丢上下文——不致命，但浪费。

### 2.3 这个套路特别坑的三个性质

1. **静默**：回退不报错、不告警，系统照常跑，只是数字错了。
2. **内部自洽**：所有阈值共享同一个错的基础，**它们之间的关系仍然成立**（0.6 < 1.0、0.5 < 0.6、0.3 < 0.5 都还对）。系统按自己的标准检查一切正常——它错得很「协调」。
3. **扇出**：一个配置错，六层同时偏，调任何单一比例都修不好，必须修源头。

### 2.4 → 所以第 0 层必须最先做

正因为这个套路，「校准 base 值」是整个漏斗的前提而不是优化项。兼容策略是：已枚举模型优先使用自己的 `contextWindow`；动态 fallback 模型可以用全局 `models.defaultContextWindow` 显式声明默认窗口；如果仍落到内置 `DEFAULT_CONTEXT_TOKENS = 200000`，run/compact 会告警但保持旧配置可运行。

---

## 3. 六层漏斗（逐层）

每往下一层处境越糟，所以**保留比例递减、手段递进**。

### 第 0 层：校准基础值（必须先做）

- workspace/custom provider 可以通过全局 `models.defaultContextWindow` 给动态 fallback 模型声明默认窗口。
- 若 fallback 模型仍落到 `DEFAULT_CONTEXT_TOKENS = 200000`，保持兼容继续运行，但输出 warning，建议显式配置 provider 默认窗口或逐模型 `contextWindow`。
- 内置已知模型允许 default 兜底，不拦。
- **这一层不通过，下面所有比例都无意义。**

### 第 1 层：单条 toolResult 源头封顶（写入即裁）

最早的关口，在 toolResult 写入 JSONL 前就限死。

| 工具类型                                              | 占比                       | 硬顶 | 200K 窗口下实际值 |
| ----------------------------------------------------- | -------------------------- | ---- | ----------------- |
| 文件类（`read`/`file`/`read_file`/`*_read`/`*_file`） | `contextWindow × 0.04 × 4` | 40K  | 32K 字符          |
| `web_fetch` / `exec` / 通用 / unknown                 | `contextWindow × 0.03 × 4` | 20K  | 20K（被硬顶压住） |

> 占比作用在 **token** 上，× `CHARS_PER_TOKEN_ESTIMATE = 4` 转字符，再取与硬顶的较小值。旧逻辑是固定 400K 字符（≈10 万 token）一条，单条就能撑爆。新逻辑下单条最多占窗口 3–4%，3MB / 45 万 token 的膨胀从源头攒不起来。
>
> 注：实现里把「通用 toolResult」合并进了 3%/20K 档（只有文件类读取工具享受 4%/40K）。

### 第 2 层：preflight 确定性裁剪（估算前先压）

在 token 估算**之前**跑，不依赖 provider/TTL。

- **门槛**：仅当历史 > `contextWindow × 0.6` 才裁；否则原样不动 → 保住 Anthropic prompt cache。
- **目标**：压到 `contextWindow × 0.6`。
- **保护**：最近 **2 个** assistant turn 不动。
- **手段**：soft trim（按第 1 层上限截断 head+tail）→ hard clear（web_fetch/exec 旧输出替换成 placeholder）→ 从队首丢消息 + 清 orphan toolResult。

**这是整条链路的转折点。** 以崩溃案例算：262144 窗口、20000 reserve，compaction 触发线 = 242144 token。原本 45 万 token 直接超线触发模型摘要；裁剪后压到 ≤ 157K（0.6 × 262144），**根本到不了 compaction 线**。模型摘要式 compaction 从「默认路径」退化成「兜底路径」。

### 第 3 层：compaction 输入预算（真触发也喂不大）

万一第 2 层后仍超线、进了 compaction，在调摘要模型**之前**对输入副本裁剪：

- `pruneMessagesForSummarizationBudget` 把输入压到 `contextWindow × 0.5`（≈131K），丢最旧整条消息，前面插 synthetic note 告知摘要模型有省略。
- `summarizeInStages` 的 `maxChunks` 默认 **2**，超出 chunk 丢弃并写 deterministic dropped note。

→ 永远不会把 45 万 token 级别的历史整坨丢给摘要模型。

### 第 4 层：摘要调用预算（直接杀死 300s 超时）

300 秒死等的**直接根因**修复：

- `SummaryCallBudget`：一次 compaction 生命周期内 `maxCalls = 2`，跨 dropped / history / turn-prefix 三类摘要**共享计数**。
- 预算耗尽 → 返回 deterministic fallback summary（**这是终态**，由 SDK 正常落 entry，**不升级到 emergency**，避免双 entry）。

→ 旧行为：N 个 chunk × 串行模型调用 → 必然撞 300s。新行为：最多 2 次模型调用。

### 第 5 层：emergency compaction（终极止血）

上面全失败的兜底（timeout / error / append 失败）：

- **不调模型**，纯确定性。
- 保留最近 **1 个** user turn（尝试扩到 2），`tailBudget = min(keepRecentTokens, contextWindow × 0.3, 60000)`。
- 清 orphan toolResult → 生成本地 summary → append entry → rebuild context。
- append 前用 `preCompactionCount` 水位做幂等检测，防 timeout 竞态下双 entry（见 §4 加固）。

→ 保证状态**必然推进**。45 万 token transcript 每轮重复进 compaction 的死循环被切断。

### 第 6 层：pruning 门禁解耦 + TTL

让上面的机制对所有 provider 都生效：

- 显式配置的 pruning 注册只看 `contextPruning.mode`，不再被 `isCacheTtlEligibleProvider()` 的 Anthropic 白名单拦住 → OTR/DeepSeek 等也能裁。
- Anthropic auth 自动开启的 `cache-ttl` 默认仍由 `isCacheTtlEligibleProvider()` 保护，只作用在 Anthropic-compatible 会话上。
- `isCacheTtlEligibleProvider()` 退回**只管 Anthropic 缓存默认路径**。
- 默认 pruning TTL `1h → 5m`。

---

## 4. 比例漏斗图

每往下一层处境越糟，保留比例**递减**、手段**递进**：

```
第1层  单条 item   ≤ contextWindow × 0.04 / 0.03     （源头写死）
第2层  preflight   ≤ contextWindow × 0.6             （估算前确定性压）
第3层  compaction  ≤ contextWindow × 0.5             （真摘要也限输入）
第5层  emergency   ≤ contextWindow × 0.3             （兜底只保尾巴）
```

---

## 5. 加固：emergency 路径的两处 review 修复

实现合并后，针对第 5 层止血路径又补了两处加固（commit `e11c1ca17c`）：

1. **late 正常 SDK compaction 不算终态 → 双 entry**
   原幂等检测只认「带匹配 metadata 的 emergency entry」。若原 `session.compact()` 在 abort grace 内 settle 成功并写了**正常** compaction entry，emergency 仍会再 append 一个 → 重复 summary + 对已压缩历史多裁一次。
   **修法**：换成 `preCompactionCount` 水位——只要 `countCompactionEntries(entries) > preCompactionCount` 就 bail，无论落地的是 emergency 还是正常 compaction。

2. **裸 `model.contextWindow` → NaN → 止血失败**
   `compact.ts` 把裸 `model.contextWindow` 传进 emergency；无 metadata 的模型该值为 `undefined`，而 `calculateTailBudgetTokens()` 里 `Math.max(1, undefined) === NaN`，导致 `keptTokens > tailBudget` 判断永远 false → 保留完整超长尾部 → 止血失败。
   **修法**：`compact.ts` 改用 `resolveContextWindowInfo()` 解析有效窗口（与 run/preflight 一致）；`calculateTailBudgetTokens()` 对非有限输入兜底成 `DEFAULT_CONTEXT_TOKENS`，堵掉 NaN 陷阱。

---

## 6. 验收要点

- 3 MB transcript 在 compaction timeout 后会写入 emergency compaction entry。
- 同一会话下一轮不会再次把原 45 万 token 历史送入模型摘要式 compaction。
- 一次 compaction 生命周期内 `generateSummary()` 最多调用 2 次。
- `web_fetch` / `exec` 大输出在写入 JSONL 前已被截断并保留 metadata。
- preflight token estimate 使用裁剪后的 `activeSession.messages`。
- `summarizeInStages()` 不再接收超过 compaction 输入预算的消息集合。
- `firstKeptEntryId` 从 branch entry 序列解析，非 message entry 不会打乱保留边界。
- emergency 写入前检测 compaction 水位，timeout 竞态下不会重复 append（含 late 正常 compaction）。
- OTR/DeepSeek 等显式开启 `contextPruning` 的 provider 会注册 pruning；Anthropic auth 自动开启的 cache TTL 仍由 `isCacheTtlEligibleProvider()` 保护。
- contextWindow 来源在日志中可诊断，workspace/custom fallback provider 使用 200k 默认窗口时会告警，且可用全局 `models.defaultContextWindow` 消除默认兜底。

---

## 7. 一句话浓缩

**比例自缩放是个好套路，但它的命门是 base 值必须真实；静默回退把「唯一真实来源」变成了「唯一错误来源」，于是全套比例一起失真。** 解法不是再调某个比例，而是用一个比例递减的六层漏斗：源头封顶 + 确定性裁剪拦在 compaction 线以下，输入预算 + 调用预算让真触发也跑得完，emergency 保证无论如何都落状态——而第 0 层校准和第 6 层解耦，确保这套比例对非 Anthropic 模型同样生效。
