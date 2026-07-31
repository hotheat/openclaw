import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("apply_patch allowModels config warnings", () => {
  it("warns for bare ids without blocking configuration loading", () => {
    const result = validateConfigObjectWithPlugins({
      tools: {
        exec: {
          applyPatch: {
            enabled: true,
            allowModels: ["gpt-5.6-sol"],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual({
      path: "tools.exec.applyPatch.allowModels.0",
      message:
        'allowModels entry "gpt-5.6-sol" has no provider prefix and matches this model on ALL providers; use "provider/model" to scope to one provider',
    });
  });

  it("does not warn for fully qualified ids or an empty allowlist", () => {
    for (const allowModels of [[], ["otr/gpt-5.6-sol"]]) {
      const result = validateConfigObjectWithPlugins({
        tools: { exec: { applyPatch: { enabled: true, allowModels } } },
      });

      expect(result.ok).toBe(true);
      expect(result.warnings.filter((warning) => warning.path.includes("applyPatch"))).toEqual([]);
    }
  });
});
