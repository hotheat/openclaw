---
read_when:
  - 你正在迁移旧的 Perplexity web_search 配置
  - 你在找 provider 路由移除后的替代方案
summary: Perplexity Sonar 已不再支持作为 web_search provider
title: Perplexity Sonar（已移除）
---

# Perplexity Sonar（已移除）

OpenClaw 已不再支持把 Perplexity 作为 `web_search` 的 provider。

现在：

- `web_search` 固定使用 Brave
- 综合搜索单独使用 `grok_search`

## 变更内容

- 移除 `tools.web.search.provider`
- 移除 `tools.web.search.perplexity`
- 移除 `web_search` 内部 provider 自动路由

## 迁移示例

旧配置：

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
        },
      },
    },
  },
}
```

改成下面两种之一：

```json5
{
  tools: {
    web: {
      search: {
        apiKey: "BSA...",
      },
    },
  },
}
```

```json5
{
  tools: {
    web: {
      grokSearch: {
        apiKey: "xai-...",
      },
    },
  },
}
```

当前支持的完整说明请参阅 [Web 工具](/tools/web)。
