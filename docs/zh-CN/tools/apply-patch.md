---
read_when:
  - 你需要跨多个文件进行结构化编辑
  - 你想要记录或调试基于补丁的编辑
summary: 使用 apply_patch 工具应用多文件补丁
title: apply_patch 工具
x-i18n:
  generated_at: "2026-02-01T21:39:24Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 8cec2b4ee3afa9105fc3dd1bc28a338917df129afc634ac83620a3347c46bcec
  source_path: tools/apply-patch.md
  workflow: 15
---

# apply_patch 工具

使用结构化补丁格式应用文件更改。这非常适合多文件
或多段编辑，在这些场景下单次 `edit` 调用会很脆弱。

该工具接受一个 `input` 字符串，其中包含一个或多个文件操作：

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## 参数

- `input`（必需）：完整的补丁内容，包括 `*** Begin Patch` 和 `*** End Patch`。

## 说明

- 补丁路径支持相对于工作区的路径和绝对路径。
- `tools.exec.applyPatch.workspaceOnly` 默认为 `true`，会拒绝工作区外路径、符号链接和硬链接别名。
- 在 `*** Update File:` 段中使用 `*** Move to:` 可重命名文件。
- 需要时使用 `*** End of File` 标记仅在文件末尾的插入。
- 实验性功能，默认禁用。通过 `tools.exec.applyPatch.enabled` 启用。
- 未配置 `allowModels` 或配置为空数组时，所有 Provider/模型均可使用。
- 如需收窄，请在 `tools.exec.applyPatch.allowModels` 中配置完整
  `provider/model`。裸模型 ID 会匹配所有 Provider，并在启动时产生告警。
- 工具 allow/deny 策略和只读 sandbox 仍优先生效。
- 配置仅在 `tools.exec` 下。

```json5
{
  tools: {
    exec: {
      applyPatch: {
        enabled: true,
        workspaceOnly: true,
        // 可选：allowModels: ["otr/gpt-5.6-sol"],
      },
    },
  },
}
```

## 示例

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
