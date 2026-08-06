---
read_when:
  - 你想启用 web_search、grok_search 或 web_fetch
  - 你需要设置 Brave Search 或 xAI API 密钥
  - 你正在迁移旧的 web_search provider 配置
summary: Web 搜索与抓取工具（Brave web_search、xAI grok_search、web_fetch）
title: Web 工具
---

# Web 工具

OpenClaw 提供 3 个轻量级 Web 工具：

- `web_search`：基于 Brave 的结构化搜索，返回 `title`、`url`、`description`
- `grok_search`：基于 xAI Grok 的综合搜索，返回答案文本和引用
- `web_fetch`：HTTP 获取 + 可读性提取（HTML → markdown/文本）

这些**不是**浏览器自动化。对于重 JS 页面或需要登录的网站，请使用[浏览器工具](/tools/browser)。

## 什么时候用哪个工具

### `web_search`

适合：

- 查官方文档、官网、API 参考
- 获取一组链接再继续用 `web_fetch`
- 做地区/语言定向搜索
- 使用 `site:`、`intitle:`、`filetype:` 这类搜索操作符

### `grok_search`

适合：

- 最近新闻、实时动态
- 带引用的综合答案
- 舆情、趋势、观点总结
- 使用 `source: "x"` 做 X/Twitter 定向搜索

`grok_search` **不支持** `site:`、`intitle:`、`filetype:` 这类操作符；这类需求请用 `web_search`。

### `web_fetch`

适合你已经拿到 URL，只想抓取正文内容的时候。

## 旧配置迁移

OpenClaw 不再把 `web_search` 静默路由到不同 provider。

以下旧配置会在启动时直接报错：

- `tools.web.search.provider`
- `tools.web.search.perplexity`
- `tools.web.search.grok`

迁移方式：

- Brave 配置保留在 `tools.web.search`
- xAI 配置移动到 `tools.web.grokSearch`
- 需要综合搜索时显式调用 `grok_search`

## Brave API 密钥

1. 在 <https://brave.com/search/api/> 创建 Brave Search API 账户
2. 选择 **Data for Search** 套餐，不要选择 “Data for AI”
3. 运行 `openclaw configure --section web` 保存密钥，或设置 `BRAVE_API_KEY`

推荐配置：

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BSA...",
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

## `grok_search` 的 xAI API 密钥

1. 创建 xAI 账户并生成 API 密钥
2. 在 Gateway 环境里设置 `XAI_API_KEY`，或写入 `tools.web.grokSearch.apiKey`

推荐配置：

```json5
{
  tools: {
    web: {
      grokSearch: {
        enabled: true,
        apiKey: "xai-...",
        model: "grok-4-1-fast",
        inlineCitations: false,
        timeoutSeconds: 30,
        cacheTtlMinutes: 0,
      },
    },
  },
}
```

## `web_search`

要求：

- `tools.web.search.enabled` 不能为 `false`
- `BRAVE_API_KEY` 或 `tools.web.search.apiKey`

工具参数：

- `query`（必需）
- `count`（1–10）
- `country`（可选）
- `search_lang`（可选）
- `ui_lang`（可选）
- `freshness`（可选）：`pd`、`pw`、`pm`、`py` 或 `YYYY-MM-DDtoYYYY-MM-DD`

示例：

```javascript
await web_search({
  query: "site:github.com openclaw docs",
  count: 5,
  country: "US",
  freshness: "pw",
});
```

## `grok_search`

要求：

- `tools.web.grokSearch.enabled` 不能为 `false`
- `XAI_API_KEY` 或 `tools.web.grokSearch.apiKey`

工具参数：

- `query`（必需）
- `source`（可选）：默认 `"web"`，传 `"x"` 表示搜索 X/Twitter

说明：

- `source: "x"` 会走 Grok 的 X/Twitter 搜索路径
- 返回值包含综合后的 `content`、`citations`，以及可用时的 `inlineCitations`
- 默认不缓存，因为这类查询通常强时效
- 不会自动回退到 `web_search`

示例：

```javascript
await grok_search({
  query: "latest OpenAI announcements",
});

await grok_search({
  query: "what are people saying about Tesla earnings",
  source: "x",
});
```

## `web_fetch`

要求：

- `tools.web.fetch.enabled` 不能为 `false`
- 如果要启用 Firecrawl 回退，设置 `tools.web.fetch.firecrawl.apiKey` 或 `FIRECRAWL_API_KEY`

工具参数：

- `url`（必需）
- `extractMode`（`markdown` | `text`）
- `maxChars`

说明：

- `web_fetch` 先尝试 Readability，再尝试 Firecrawl（如果已配置）
- `tools.web.fetch.timeoutSeconds` 限制单个抓取阶段（默认 30 秒）
- `tools.web.fetch.totalTimeoutSeconds` 限制包含串行回退在内的完整抓取；未配置时至少为 100 秒，且不会低于已配置的阶段超时
- 不执行 JavaScript
- 对重 JS 页面优先使用浏览器工具
- 默认缓存 15 分钟
