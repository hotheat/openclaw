import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent imageModel config", () => {
  it("accepts per-agent imageModel null", () => {
    const result = OpenClawSchema.safeParse({
      agents: {
        list: [
          {
            id: "qwen-group",
            model: { primary: "qwen-openai/qwen/qwen3.6-27b", fallbacks: [] },
            imageModel: null,
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});
