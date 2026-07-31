---
summary: "Apply multi-file patches with the apply_patch tool"
read_when:
  - You need structured file edits across multiple files
  - You want to document or debug patch-based edits
title: "apply_patch Tool"
---

# apply_patch tool

Apply file changes using a structured patch format. This is ideal for multi-file
or multi-hunk edits where a single `edit` call would be brittle.

The tool accepts a single `input` string that wraps one or more file operations:

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

## Parameters

- `input` (required): Full patch contents including `*** Begin Patch` and `*** End Patch`.

## Notes

- Patch paths support relative paths (from the workspace directory) and absolute paths.
- `tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.
- Use `*** Move to:` within an `*** Update File:` hunk to rename files.
- `*** End of File` marks an EOF-only insert when needed.
- Experimental and disabled by default. Enable with `tools.exec.applyPatch.enabled`.
- When `allowModels` is omitted or empty, every provider/model is eligible.
- To narrow access, use full `provider/model` entries in
  `tools.exec.applyPatch.allowModels`. Bare model IDs match that model on every provider and emit
  a startup warning.
- Tool allow/deny policy and read-only sandbox restrictions still take precedence.
- Config is only under `tools.exec`.

```json5
{
  tools: {
    exec: {
      applyPatch: {
        enabled: true,
        workspaceOnly: true,
        // Optional: allowModels: ["otr/gpt-5.6-sol"],
      },
    },
  },
}
```

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
