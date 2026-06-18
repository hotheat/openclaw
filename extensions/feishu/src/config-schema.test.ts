import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    expect(result.requireMention).toBe(true);
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("accepts blockStreaming at top-level and account level", () => {
    const result = FeishuConfigSchema.parse({
      blockStreaming: true,
      accounts: {
        main: {
          blockStreaming: false,
        },
      },
    });

    expect(result.blockStreaming).toBe(true);
    expect(result.accounts?.main?.blockStreaming).toBe(false);
  });

  it("accepts core blockStreamingCoalesce fields at top-level and account level", () => {
    const result = FeishuConfigSchema.parse({
      blockStreamingCoalesce: {
        minChars: 400,
        maxChars: 1200,
        idleMs: 250,
      },
      accounts: {
        main: {
          blockStreamingCoalesce: {
            minChars: 300,
            maxChars: 900,
            idleMs: 0,
          },
        },
      },
    });

    expect(result.blockStreamingCoalesce).toEqual({
      minChars: 400,
      maxChars: 1200,
      idleMs: 250,
    });
    expect(result.accounts?.main?.blockStreamingCoalesce).toEqual({
      minChars: 300,
      maxChars: 900,
      idleMs: 0,
    });
  });

  it("rejects non-core blockStreamingCoalesce fields", () => {
    const result = FeishuConfigSchema.safeParse({
      blockStreamingCoalesce: {
        enabled: true,
        minDelayMs: 100,
        maxDelayMs: 500,
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path.join(".") === "verificationToken"),
      ).toBe(true);
    }
  });

  it("accepts top-level webhook mode with verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      appId: "cli_top",
      appSecret: "secret_top",
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main",
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join(".") === "accounts.main.verificationToken",
        ),
      ).toBe(true);
    }
  });

  it("accepts account webhook mode inheriting top-level verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main",
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
