# 用户输入附件复用 artifact 通道与 ID 空间

Status: accepted（2026-08-04，Structured Ref Gate PASS；2026-08-05 R7 lightbox 修订）

## Context

WebChat 图片和文件需要在上传、发送、刷新、重新进入和下载之间保持同一身份。Gateway 已持有会话 transcript，agent-server 的 openclaw_artifacts 已持久保存 session_ref、principal、target、client session、direction、文件元数据和存储状态。

当前缺口有三项：

1. Gateway history 只从 materialized path 恢复图片，Markdown、TXT、PDF 等非图片附件没有结构化引用。
2. BFF 没有校验 history 附件归属，也没有返回通用附件元数据。
3. INPUT artifact materialize 完成后立即删除 OSS 原对象，导致历史下载无法在 retention 窗口内工作。

详细实施见 [WebChat 历史附件回放与消息展示计划](../plans/2026-07-23-webchat-image-message-gallery.md)。

## Decision

1. 用户输入附件继续写入 openclaw_artifacts，使用 direction=INPUT；attachmentId 与 artifactId 使用同一 ID。
2. Gateway 在 `chat.send` 时把有序 `{attachmentId, ordinal}` 写入对应 user transcript 的私有 `__openclaw.attachments`；`chat.history` 优先读取结构化引用，缺失或不合法时才从消息开头的既有 media marker 恢复候选。
3. Gateway 候选通过私有 \_\_openclaw.attachments 传给 BFF，不携带 workspace path、safeName、MIME、Base64 或 URL。
4. BFF 按 artifact ID、session_ref、principal、target、client session 和 direction=INPUT 批量校验。
5. BFF 使用数据库字段向浏览器返回 attachmentId、fileName、mimeType、sizeBytes，并删除所有 \_\_openclaw。
6. INPUT OSS 原对象保留到 READY retention，由 cleanup 统一过期。本期将全局 ready_retention_seconds 默认值从 30 天调为 180 天（INPUT 与 OUTPUT 共享，不新增独立配置项）。该保留成立的前提是 cleanup_expired() loop 正常运行；bff_server 长期不跑时退化为无限增长，触发 OSS 成本回滚（见计划 Risk 5）。
7. 前端按 MIME 分流：用户附件仅允许四种安全 raster MIME 进入 52px 缩略入口和可访问 lightbox，Markdown、TXT、PDF、SVG、HTML、`application/octet-stream` 和其他类型进入文件卡。assistant OUTPUT artifact 的历史扩展名回退使用独立判定函数，不得复用于用户消息。
8. 本期不新增 agent-server 会话表、消息表、Message-Artifact Link 或 migration。
9. 本期消息缩略入口和 lightbox 都直接加载鉴权后的原图字节；52px 入口只是 CSS 展示，不是服务端缩略图。真正缩略图仍需后续单独增加 /preview 和尺寸受限 rendition。
10. `__openclaw` 不是本期新造的命名空间：Gateway 今天已用它合成 compaction 标记（`session-utils.fs.ts` 写 `{kind:"compaction",id}`），BFF 与前端均不消费该字段（compaction 分隔线走 `payload.stream==='compaction'` 实时事件）。本期"BFF 删除 `__openclaw`"指删除整个命名空间（不只 attachments 键），compaction 标记一并剥离，不影响现有功能。
11. Gateway 出站 history 的 `__openclaw` 永远由 Gateway 自行构造，绝不透传 transcript 原始字段（Structured 分支校验后重建，Marker 分支无条件删除再按 marker 填充）。

## Data Ownership

| 数据                   | 唯一真相源                                              |
| ---------------------- | ------------------------------------------------------- |
| 会话身份和消息顺序     | Gateway session transcript                              |
| 历史消息的附件候选顺序 | Gateway transcript structured refs；marker 仅作兼容回退 |
| 附件归属和公开元数据   | agent-server openclaw_artifacts                         |
| 附件字节               | 私有 OSS                                                |

Gateway 候选只用于定位，不构成授权或公开元数据真相。BFF 必须在每次 history enrichment 和 /download 时独立校验当前浏览器 scope。

## Considered Options

1. **历史保存 Base64**
   - 否决。历史体积、序列化和回放成本不可控，也违反 Gateway 现有清理边界。

2. **把 workspace path 直接返回浏览器**
   - 否决。路径包含内部实现细节，safeName 不能恢复数据库原文件名，也不能承担授权。

3. **新增 agent-server 会话表**
   - 否决。Gateway 已是会话和消息真相源，新表会形成双写与删除同步问题。

4. **新增 Message-Artifact Link**
   - 本期否决。Gateway transcript 已能稳定保存有序私有引用，artifact 表已有完整授权和元数据；新增 link 还会形成双写和删除同步问题。

5. **Gateway transcript 结构化引用加 BFF artifact 鉴权**
   - 采用。结构化引用只保存 ID 和顺序，BFF 每次按当前 binding 重新鉴权；不新增表，并保持 Gateway、BFF 和 OSS 的既有职责。

## Consequences

### Positive

1. 图片和通用文件共享同一 attachmentId、鉴权和下载链路。
2. Gateway 不需要保存 Base64 或公开内部路径。
3. BFF 可通过一次受限批量查询完成 history enrichment。
4. 新字段可选；首次上线在同一维护窗口按 Gateway → agent-server → frontend 三步发布，窗口内旧 BFF 对 \_\_openclaw 私有引用（仅 attachmentId 与 ordinal，浏览器本就可见的低敏感值）的短暂透传为显式接受的首发风险。
5. 对象过期后仍可显示数据库元数据，文件卡不会随字节删除一起消失。

### Negative

1. INPUT 原对象保留到 READY retention，会增加 OSS 占用。
2. 新消息依赖 Gateway transcript 私有扩展字段；旧消息和异常字段仍依赖 media marker 回退。
3. 消息缩略入口和 lightbox 仍加载原图字节，会增加大图下载量和浏览器解码成本。
4. 同一会话内的消息级伪造只能由 marker 边界和 artifact scope 限制；本期不提供独立消息绑定完整性。
5. download 只按 principal_id、target_kind、target_id、client_session_id 四维 scope 加 READY 校验，不含 session_ref 与 direction；同一用户、同一 target、同一 clientSession 的不同 client instance 在持有不可猜测 attachmentId 时可下载，为已知限制。

## Reconsideration Triggers

以下任一条件成立时，重新评估 Message-Artifact Link：

1. Gateway 不再保留现有 media marker 或 materialized path 契约。
2. BFF 需要脱离 Gateway history 独立查询消息附件。
3. 产品要求消息级级联删除、跨会话复用或更强的同会话消息绑定完整性。
4. artifact ID 无法再从 materialized path 的结构化载体中无歧义恢复。

以下任一条件成立时，立项严格 client instance 下载隔离：

1. 产品或合规要求 client instance 级下载隔离。
2. clientSessionId 不再固定为 main，跨 instance 边界成为真实用户边界。

实施时下载请求需显式携带 clientInstanceId 或服务端签发的绑定令牌，由服务端解析 binding 后比对；不得直接信任浏览器提交的 session_ref。

以下任一条件成立时，新增 /preview 和尺寸受限 rendition：

1. 大图下载量或 LCP 超过产品阈值。
2. 产品要求固定像素缩略图或静态 GIF 首帧。
3. 移动网络或多图会话证明原图直出成本不可接受。
