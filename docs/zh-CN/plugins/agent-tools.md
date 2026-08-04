---
read_when:
  - 你想在插件中添加新的智能体工具
  - 你需要通过允许列表使工具可选启用
summary: 在插件中编写智能体工具（模式、可选工具、允许列表）
title: 插件智能体工具
x-i18n:
  generated_at: "2026-02-03T07:53:22Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 4479462e9d8b17b664bf6b5f424f2efc8e7bedeaabfdb6a93126e051e635c659
  source_path: plugins/agent-tools.md
  workflow: 15
---

# 插件智能体工具

OpenClaw 插件可以注册**智能体工具**（JSON 模式函数），这些工具在智能体运行期间暴露给 LLM。工具可以是**必需的**（始终可用）或**可选的**（选择启用）。

智能体工具在主配置的 `tools` 下配置，或在每个智能体的 `agents.list[].tools` 下配置。允许列表/拒绝列表策略控制智能体可以调用哪些工具。

## 基本工具

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## 可选工具（选择启用）

可选工具**永远不会**自动启用。用户必须将它们添加到智能体允许列表中。

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

在 `agents.list[].tools.allow`（或全局 `tools.allow`）中启用可选工具：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // 特定工具名称
            "workflow", // 插件 id（启用该插件的所有工具）
            "group:plugins", // 所有插件工具
          ],
        },
      },
    ],
  },
}
```

## 副作用与用户可见交付

声明工具在自动只读恢复期间是否可以安全运行：

```ts
api.registerTool({
  name: "records",
  description: "Read or update records",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "update"] },
    },
    required: ["action"],
  },
  sideEffect: "mutating",
  sideEffectByAction: {
    get: "read_only",
  },
  async execute(_id, params) {
    // ...
  },
});
```

- `sideEffect` 将默认值设为 `read_only` 或 `mutating`。
- `sideEffectByAction` 按规范化后的 `action` 值覆盖默认声明。Action 名称会去除首尾空格、转为小写，并将空格和连字符规范化为下划线。
- 未声明 `sideEffect` 的插件工具默认按 `mutating` 处理。
- 只有在上一次工具结果未决时仍可安全重试的调用，才能声明为 `read_only`。

仅当工具成功返回即可确认结果已经交付给当前用户时，才设置 `deliveryEffect: "user_facing"`。成功的用户可见交付可以直接满足运行完成条件，无需额外的 assistant 回复。仅生成待后续交付的数据不符合该语义。

其他影响工具可用性的配置选项：

- 仅包含插件工具名称的允许列表被视为插件选择启用；核心工具保持启用，除非你在允许列表中也包含核心工具或组。
- `tools.profile` / `agents.list[].tools.profile`（基础允许列表）
- `tools.byProvider` / `agents.list[].tools.byProvider`（特定提供商的允许/拒绝）
- `tools.sandbox.tools.*`（沙箱隔离时的沙箱工具策略）

## 规则 + 提示

- 工具名称**不能**与核心工具名称冲突；冲突的工具会被跳过。
- 允许列表中使用的插件 id 不能与核心工具名称冲突。
- 对于触发副作用或需要额外二进制文件/凭证的工具，优先使用 `optional: true`。
