# OpenClaw M2 真机冒烟清单

用于验证多会话、子 agent、技能回显和 WebUI artifact 链路。先完成定向自动化测试，再在同一测试环境依次部署 Gateway、BFF 和前端。

## 验收结果（2026-07-16）

- 通过：Gateway 重启与 RPC probe、BFF health 与 subagents feature、指定 direct `main` URL 实际收发、private group 实际收发、陌生 group 回退、双 session 页面级运行隔离。
- 通过：跨 agent `researcher` child 发现、只读面板 live 工具活动、完成态与刷新恢复；父/子技能名称分别回显 `researcher-delegation`、`taskflow`，工具详情未进入 DOM。
- 通过：父会话 `webui_artifact_publish`、live 文件卡、下载跳转、刷新恢复；扩展专用 API key 轮换后再次发布成功。
- 自动化通过：agent-frontend `142/142` 常规测试、`73/73` 组件测试、远端新增定向 `8/8`、type-check、Biome、生产构建；既有三仓定向测试覆盖 child/target/session/artifact 越权与文件校验边界。
- 运维待办：对象存储 AccessKey 需要云侧权限轮换。测试直连端口因本地 `localhost:5173` 验收仍依赖 `172.16.120.245:8004/8002`，暂不关闭。

## 部署前检查

- Gateway 与 BFF 的目标分支已构建，数据库 migration 已升级到最新 head。
- BFF 已同步非管理员 SERVICE `openclaw-artifact-extension`，扩展侧已注入该服务的 API key。
- 私有对象存储、Redis binding 和 artifact feature 已启用；浏览器及日志中没有服务 API key、object key 或预签名 URL。
- 生产拓扑仅把 BFF 绑定到宿主机回环地址并通过反向代理暴露浏览器路由。测试环境若要求浏览器直连 BFF，可临时绑定测试网地址，验收后恢复生产拓扑。
- Gateway 配置允许并启用 `webui-artifacts`，扩展 endpoint 指向同宿主机 BFF internal 路由。

## 基础链路

- 登录后进入 direct target，`bridge.hello` 的 target 和 URL 中 target 一致。
- 进入当前用户可见的 private group；公开、陌生或已撤权 group 被拒绝。
- 新建两个 session，分别发送消息；切换时旧 WebSocket 关闭，新连接的 `clientSessionId` 与 URL 一致。
- session A 的消息、runId、toolCallId 不出现在 session B；切回 A 后 history/reconcile 收敛到终态。
- 发送、中止、刷新恢复、断网重连、foreign run、Markdown 和普通工具卡保持 M1 行为。

## 子 agent 与技能

- 父会话调用 `sessions_spawn` 后出现子任务卡；跨 agent child 也能发现。
- 打开子任务面板可看到历史、后续流式消息和工具活动；面板没有发送、中止、steer、kill 或继续对话入口。
- 刷新后重新发现 active child，并恢复 history 与后续 tool events；已超过 registry 保留期的 child 显示稳定降级文案。
- 父、子会话读取 `.../skills/planner/SKILL.md` 时显示“使用技能：planner”；普通 read 不误报且绝对路径不进入 DOM。
- 工具只显示状态和派生名称；参数、结果、原始错误、耗时和详情入口不进入 DOM。
- child streaming 不改变父 Composer 的 `isRunning`，也不能取消父 own run。
- 浏览器提交 raw child session key、未授权 opaque child id 或其他 target 的 child id 时，BFF default deny。

## Artifact

- 父 WebUI 会话调用 `webui_artifact_publish` 后，即使没有文本回复也出现文件卡；下载内容与原文件一致。
- 刷新或断线漏掉 live event 后，`artifacts.list` 恢复 ready 文件卡；每次下载重新取得短期 URL。
- 其他用户、target、session、raw session key 请求 list/download 均被拒绝；private group 撤权后立即拒绝。
- WebChat 的 `message(filePath/media/...)` 不进入 Feishu outbox；显式 Feishu channel 和真实 target 的发送保持原行为。
- 子 agent、外部 channel、未绑定 session 不能调用 `webui_artifact_publish`。
- 错误 MD5、错误 size、错误 SHA256、可执行 MIME、符号链接逃逸、FIFO、执行中替换和超过 100 MB 的文件均失败且不发布 available event。
- 同一 `sourceToolCallId` 重试幂等；并发第 51 个 pending/ready artifact 返回 `ARTIFACT_SESSION_LIMIT_REACHED`。
- 断连宽限期内迟到 publish 可完成并由 list 恢复；binding 过期或 Redis 不可用时仅关闭 artifact，聊天仍可用。

## 安全与收口

- Gateway scopes 仍为 `operator.read/operator.write`，BFF allowlist 不含审批或管理方法。
- 普通日志、WebSocket、history 和浏览器持久状态不含 API key、object key、预签名 URL 或宿主机绝对路径。
- 检查 BFF/Gateway/前端运行日志，无 migration、插件加载、鉴权、上传清理或重连异常。
- 关闭测试环境临时端口暴露；记录镜像、Git revision、migration head 和验证时间。
