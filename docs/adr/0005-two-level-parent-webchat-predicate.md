# 父 WebChat 判定拆成双层谓词：session 形状与 channel 准入分离

Status: accepted (2026-07-28)

按交付界面裁剪工具需要一个共享的「这是不是父 WebChat 会话」判定，替代散落在三处、宽松度各不相同的字符串判断。直觉方案是一个函数 `isParentWebchatSessionContext({ channel, sessionKey })`，所有调用点共用。

但这样做会**静默切断 researcher 导出到 WebChat 的交付**。现有的 `subagent_handoff_delivery` 与工具注册的 channel 准入规则本来就不同：

| 调用点                            | session key  | channel                                             |
| --------------------------------- | ------------ | --------------------------------------------------- |
| `webui_artifact_publish` 工具注册 | 五段 webchat | 必须 ∈ {webchat, internal}，**缺失即拒绝**          |
| `subagent_handoff_delivery`       | 五段 webchat | `!channel \|\| webchat \|\| internal`，**允许缺失** |

`requesterOrigin` 在事件类型上是可选的（`src/agents/subagent-announce.ts:116`）。正常 WebChat spawn 通常会捕获 `webchat` 或 `internal`，但事件类型、旧持久化记录和 handoff 传递链都明确允许缺失，因此这条兼容合同真实存在。用单一严格谓词替换后，hook 会直接 `return`，文件不发布，**且没有任何错误可见**。

决定导出**两个层次**：

```ts
// 纯 session key 形状判定
export function isParentWebchatSessionKey(sessionKey?: string): boolean;

// 形状 + channel 准入；channel 缺失返回 false
export function isParentWebchatSessionContext(params: {
  channel?: string;
  sessionKey?: string;
}): boolean;
```

核心工具裁剪、`message` 纵深保护、`webui_artifact_publish` 注册使用后者；`subagent_handoff_delivery` 只复用前者，并在调用点显式写出自己的 channel 组合。

第二个参数用中性的 `channel`：`pi-tools` 传入 `messageProvider`，插件传入 `messageChannel`，不把某个调用方的命名带进共享 API。

## Considered Options

1. **单一 `isParentWebchatSessionContext()`，所有调用点共用（被否决）**：最符合「单一事实源」的直觉，也是原计划的写法。但它把两个语义不同的准入规则强行合并，代价是 handoff 的 channel 缺失兼容被悄悄收紧，researcher 文件不再发布到 WebChat，且失败静默。
2. **单一函数 + `allowMissingChannel` 选项（被否决）**：能同时表达两种规则。但宽松模式藏在一个布尔参数里，其他调用方很容易顺手打开；调用点读起来也看不出 handoff 为什么特殊。显式组合把「为什么这里更宽松」留在了它该在的位置。
3. **维持现状，三处各自判断（被否决）**：`message-tool.ts` 用的是 `sessionKey.includes(":webchat:")`，比另外两处宽松得多；三份判断继续独立漂移正是本次要消除的问题。

## Consequences

- 「单一事实源」落在**真正共享的那部分**——五段 `agent:{agentId}:webchat:{namespace}:{sessionId}` 的形状判定；channel 准入由各调用点按自身语义决定。
- `subagent_handoff_delivery` 的宽松策略在调用点可见，不需要读 helper 实现就能理解。
- **实施约束（非可选风险）**：任何把 handoff 判定换成 `isParentWebchatSessionContext()` 的改动都会造成静默回归。必须有一条「合法 WebChat key + `requesterOrigin.channel` 缺失时仍发布 artifact」的正例测试守住这条边界。
- `control-ui` 明确**不属于**父 WebChat 交付界面，由负例测试固化。Control UI 与 WebChat 已在 `docs/plans/2026-07-16-control-ui-webchat-channel-separation.md` 中分离为不同 channel。
- `message` 的运行时拒绝逻辑（`assertWebchatMessageBoundary()`）保留为纵深保护：动态隐藏减少误调用，运行时拒绝防止旧入口和显式构造场景旁路。
- 两个谓词都是纯 `(channel, sessionKey)` 函数，不依赖 run 触发来源。这使得 WebChat 会话里 `sessionTarget="main"` 的 cron 也落入 WebChat 裁剪、失去主动即时投递（结果仍写入 transcript，`sessionTarget="isolated"` 不受影响）。这是有意接受的收窄——为 cron 引入触发来源参数会破坏谓词的纯粹性；若未来产品明确要求该能力，应单独设计 cron delivery 合约。
