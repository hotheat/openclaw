import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("feishuPlugin.agentPrompt.messageToolHints", () => {
  it("explains explicit targeting for current-group attachments", () => {
    const hints = feishuPlugin.agentPrompt?.messageToolHints?.({ cfg: {} as OpenClawConfig }) ?? [];

    expect(hints).toEqual(expect.any(Array));
    expect(
      hints.some((hint) => hint.includes("omit `target` to send to the current conversation")),
    ).toBe(true);
    expect(
      hints.some(
        (hint) =>
          hint.includes("filePath` (or `path`)") &&
          hint.includes("If you are sending to the current conversation, you may omit `target`"),
      ),
    ).toBe(true);
  });
});

describe("feishuPlugin config schema", () => {
  const mediaLimitKeys = [
    "mediaMaxMb",
    "inboundMediaMaxMb",
    "outboundFileMaxMb",
    "outboundImageMaxMb",
  ];

  it("rejects zero media limits consistently with runtime config validation", () => {
    const properties = feishuPlugin.configSchema?.schema.properties as Record<
      string,
      Record<string, unknown>
    >;

    for (const key of mediaLimitKeys) {
      expect(properties[key]).toMatchObject({ type: "number", exclusiveMinimum: 0 });
      expect(properties[key]).not.toHaveProperty("minimum");
    }
  });

  it("exposes media limit overrides on per-account configs", () => {
    const properties = feishuPlugin.configSchema?.schema.properties as Record<string, unknown>;
    const accountsSchema = properties.accounts as {
      additionalProperties: { properties: Record<string, Record<string, unknown>> };
    };
    const accountProperties = accountsSchema.additionalProperties.properties;

    for (const key of mediaLimitKeys) {
      expect(accountProperties[key]).toMatchObject({ type: "number", exclusiveMinimum: 0 });
      expect(accountProperties[key]).not.toHaveProperty("minimum");
    }
  });

  it("exposes block streaming coalesce overrides on top-level and per-account configs", () => {
    const properties = feishuPlugin.configSchema?.schema.properties as Record<string, unknown>;
    const accountsSchema = properties.accounts as {
      additionalProperties: { properties: Record<string, Record<string, unknown>> };
    };
    const expected = {
      type: "object",
      additionalProperties: false,
      properties: {
        minChars: { type: "integer", minimum: 1 },
        maxChars: { type: "integer", minimum: 1 },
        idleMs: { type: "integer", minimum: 0 },
      },
    };

    expect(properties.blockStreamingCoalesce).toMatchObject(expected);
    expect(accountsSchema.additionalProperties.properties.blockStreamingCoalesce).toMatchObject(
      expected,
    );
  });
});
