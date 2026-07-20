# Implementation Plan: WebChat Session Namespace Unification

## Overview

将浏览器聊天会话的内部 namespace 从 `webui` 一次性迁移为 `webchat`。BFF 成为唯一 session key 铸造方，Gateway、附件物化、子任务 direct 投递和部署插件只接受 `agent:<agentId>:webchat:<clientInstanceId>:<clientSessionId>`，不保留 `webui` 兼容分支。

## Requirements

- session key 第三段固定为 `webchat`。
- `messageChannel` 继续使用 `webchat`。
- workspace 上传目录继续使用 `uploads/webchat/`。
- Researcher direct completion 只按 `webchat` 会话或 `messageChannel=webchat` 判断。
- BFF、Gateway、插件、日志和测试中的会话语义统一命名为 WebChat。
- 开发环境旧 `webui` 会话不迁移，由测试数据和运行环境清理。

## Architecture Changes

- `agent-server/app/services/openclaw_bridge_service.py`：BFF 仅构造 `:webchat:` session key。
- `src/agents/subagent-spawn.ts`、`src/agents/subagent-announce.ts`：direct completion 不再识别 `:webui:`。
- `src/gateway/chat-attachment-materialize.ts`：附件物化只接受父 WebChat session，并统一常量与审计名称。
- `extensions/webui-artifacts/index.ts`：浏览器 artifact 工具只在父 WebChat session 暴露；插件产品名和工具名暂不改变，避免把 UI 文件交付概念与 session namespace 混为一层。
- `openclaw-workspace/extensions/feishu-*`：飞书策略插件用 `messageChannel` 和 `:webchat:` 排除网页聊天上下文。

## Implementation Steps

### Phase 1: BFF Session Source of Truth

1. **替换 session namespace 常量** (`agent-server/app/common/constants/openclaw_gateway.py`)
   - Action: 将 `OPENCLAW_GATEWAY_WEBUI_NAMESPACE_SEGMENT` 改为 `OPENCLAW_GATEWAY_WEBCHAT_NAMESPACE_SEGMENT`，值固定为 `webchat`。
   - Why: session key 必须由单一常量控制。
   - Dependencies: None.
   - Risk: Medium，旧会话无法继续访问，符合本次决策。

2. **更新 BFF 构造与校验** (`agent-server/app/services/openclaw_bridge_service.py`)
   - Action: session prefix、session key 构造、错误文案和类说明统一为 WebChat。
   - Why: BFF 是浏览器不可见 Gateway session key 的唯一铸造方。
   - Dependencies: Step 1.
   - Risk: Medium。

### Phase 2: Gateway Runtime Boundaries

1. **更新 direct completion 判断** (`src/agents/subagent-spawn.ts`, `src/agents/subagent-announce.ts`)
   - Action: 仅识别 `:webchat:` 和 `messageChannel=webchat`。
   - Why: 避免 WebChat 被飞书 completion route 接管。
   - Dependencies: Phase 1.
   - Risk: High，影响子任务完成投递。

2. **更新附件物化** (`src/gateway/chat-attachment-materialize.ts`)
   - Action: session 第三段校验改为 `webchat`，常量、函数、错误和审计名同步更名。
   - Why: 上传文件只能落入受信父 WebChat session 对应 workspace。
   - Dependencies: Phase 1.
   - Risk: High，涉及文件边界。

3. **更新消息与 artifact 插件边界** (`src/agents/tools/message-tool.ts`, `extensions/webui-artifacts/index.ts`)
   - Action: 上下文函数改为 WebChat 语义并移除 `:webui:` 兼容。
   - Why: 当前网页聊天不能再被旧 namespace 识别。
   - Dependencies: Phase 1.
   - Risk: Medium。

### Phase 3: Deployment Plugins

1. **修正飞书上下文判定** (`openclaw-workspace/extensions/feishu-researcher-delegation-guard/index.js` 等)
   - Action: `messageChannel=webchat` 或 session key 含 `:webchat:` 时直接排除；飞书注入必须同时满足真实飞书通道。
   - Why: `feishu-*` agentId 表示 workspace 归属，不能代表当前投递通道。
   - Dependencies: Phase 2.
   - Risk: High，影响 Researcher handoff 和飞书附件发送。

### Phase 4: Tests and Cleanup

1. **更新定向测试**
   - Action: BFF、Gateway、artifact、附件、消息边界和子任务测试全部改用 `:webchat:`；新增旧 `:webui:` 被拒绝的断言。
   - Why: 确保无兼容回退。
   - Dependencies: Phases 1-3.
   - Risk: Low。

2. **扫描运行时代码残留**
   - Action: 检查 `:webui:`、namespace 常量和旧判断函数；历史文档中的架构记录单独更新当前有效部分。
   - Why: 让遗漏在开发阶段暴露。
   - Dependencies: All implementation steps.
   - Risk: Low。

## Testing Strategy

- BFF unit: bridge session 构造、history/list/event filtering、artifact session 校验。
- Gateway unit: attachment materialization、message boundary、subagent spawn/direct announce。
- Extension tests: artifact 工具只在 `:webchat:` 父 session 注册。
- Frontend unit/type-check: artifact 卡片和附件上传不受 namespace 切换影响。
- Remote smoke: 新建会话、上传附件、Researcher direct completion、artifact 下载；确认日志中无新 `:webui:` session。

## Risks & Mitigations

- **旧会话不可访问**：开发环境直接清理旧会话，不做迁移。
- **混合版本部署**：按 Gateway、BFF、Frontend、部署插件同一窗口更新，完成后重启 Gateway。
- **飞书误判**：以 `messageChannel` 为主，`:webchat:` 作为稳定排除条件，`agentId` 只用于确认归属。
- **跨 workspace 文件读取**：不放宽 artifact safe-open，仍先复制到当前用户 workspace。

## Success Criteria

- [ ] 新 session key 全部使用 `agent:<agentId>:webchat:<clientInstanceId>:<clientSessionId>`。
- [ ] Gateway 和插件不接受 `:webui:` 父聊天 session。
- [ ] WebChat Researcher completion 直接进入父 session，不经过飞书投递。
- [ ] 飞书真实会话仍能同步镜像并通过 outbox 发送文件。
- [ ] 上传目录保持 `uploads/webchat/`，附件和 artifact 定向测试通过。
- [ ] xiaolu-test 新会话端到端验证通过。
