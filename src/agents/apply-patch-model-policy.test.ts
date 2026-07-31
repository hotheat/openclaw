import { describe, expect, it } from "vitest";
import { isApplyPatchAllowedForModel } from "./apply-patch-model-policy.js";

describe("isApplyPatchAllowedForModel", () => {
  it("allows every provider and model when the allowlist is empty", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "qwen-openai",
        modelId: "qwen/qwen3.6-27b",
      }),
    ).toBe(true);
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "deepseek",
        modelId: "deepseek-v4-pro",
        allowModels: [],
      }),
    ).toBe(true);
  });

  it("matches normalized full provider/model entries", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: " OTR ",
        modelId: " GPT-5.6-SOL ",
        allowModels: [" otr/gpt-5.6-sol "],
      }),
    ).toBe(true);
  });

  it("lets bare model ids match across providers", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "micu",
        modelId: "gpt-5.6-sol",
        allowModels: ["gpt-5.6-sol"],
      }),
    ).toBe(true);
  });

  it("rejects the same model on another provider when the entry is fully qualified", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "micu",
        modelId: "gpt-5.6-sol",
        allowModels: ["otr/gpt-5.6-sol"],
      }),
    ).toBe(false);
  });

  it("scopes namespaced model ids with the full provider prefix", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "qwen-openai",
        modelId: "qwen/qwen3.6-27b",
        allowModels: ["qwen-openai/qwen/qwen3.6-27b"],
      }),
    ).toBe(true);
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "other",
        modelId: "qwen/qwen3.6-27b",
        allowModels: ["qwen-openai/qwen/qwen3.6-27b"],
      }),
    ).toBe(false);
  });

  it("does not treat namespaced model ids as bare cross-provider entries", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "qwen-openai",
        modelId: "qwen/qwen3.6-27b",
        allowModels: ["qwen/qwen3.6-27b"],
      }),
    ).toBe(false);
  });

  it("rejects missing model ids and blank allowlist entries", () => {
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "otr",
        allowModels: ["otr/gpt-5.6-sol"],
      }),
    ).toBe(false);
    expect(
      isApplyPatchAllowedForModel({
        modelProvider: "otr",
        modelId: "gpt-5.6-sol",
        allowModels: ["  "],
      }),
    ).toBe(false);
  });
});
