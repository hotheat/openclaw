import { describe, expect, it } from "vitest";
import {
  formatThinkingLevels,
  listThinkingLevelLabels,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
} from "./thinking.js";

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });
});

describe("listThinkingLevels", () => {
  it("includes xhigh for codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-5.2-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex")).toContain("xhigh");
    expect(listThinkingLevels(undefined, "gpt-5.3-codex-spark")).toContain("xhigh");
  });

  it("includes xhigh for openai gpt-5.2", () => {
    expect(listThinkingLevels("openai", "gpt-5.2")).toContain("xhigh");
  });

  it("includes xhigh for official openai gpt-5.4 models", () => {
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
  });

  it("includes xhigh for official openai gpt-5.5 models", () => {
    expect(listThinkingLevels("openai", "gpt-5.5")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.5")).toContain("xhigh");
  });

  it("does not hardcode custom gpt-5.4 providers as xhigh-capable", () => {
    expect(listThinkingLevels("sss", "gpt-5.4")).not.toContain("xhigh");
    expect(listThinkingLevels("micu", "gpt-5.4")).not.toContain("xhigh");
    expect(listThinkingLevels("duckcoding", "gpt-5.4")).not.toContain("xhigh");
  });

  it("includes xhigh for custom providers that advertise supported reasoning efforts", () => {
    const catalog = [
      {
        provider: "sss",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
      {
        provider: "micu",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ];

    expect(listThinkingLevels("sss", "gpt-5.4", catalog)).toContain("xhigh");
    expect(listThinkingLevels("micu", "gpt-5.4", catalog)).toContain("xhigh");
    expect(formatThinkingLevels("sss", "gpt-5.4", ", ", catalog)).toBe(
      "off, minimal, low, medium, high, xhigh",
    );
  });

  it("includes xhigh for DeepSeek V4 models", () => {
    expect(listThinkingLevels("deepseek", "deepseek-v4-pro")).toContain("xhigh");
    expect(listThinkingLevels("deepseek", "deepseek-v4-flash")).toContain("xhigh");
  });

  it("includes xhigh for github-copilot gpt-5.2 refs", () => {
    expect(listThinkingLevels("github-copilot", "gpt-5.2")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.2-codex")).toContain("xhigh");
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });
});

describe("listThinkingLevelLabels", () => {
  it("returns on/off for ZAI", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});
