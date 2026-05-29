import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

function invokeOnPayloadCompat(
  options: SimpleStreamOptions | undefined,
  payload: unknown,
  model: Model<Api>,
) {
  (options?.onPayload as ((payload: unknown, model?: Model<Api>) => unknown) | undefined)?.(
    payload,
    model,
  );
}

function runThinkingCase(params: {
  applyProvider: string;
  applyModelId: string;
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
  payload?: Record<string, unknown>;
  model?: Partial<Model<Api>>;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
}) {
  const payload: Record<string, unknown> = params.payload ?? {
    model: params.applyModelId,
    messages: [],
  };
  const baseStreamFn: StreamFn = (model, _context, options) => {
    invokeOnPayloadCompat(options, payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(
    agent,
    params.cfg,
    params.applyProvider,
    params.applyModelId,
    undefined,
    params.thinkingLevel,
  );

  const model = {
    api: "anthropic-messages",
    provider: params.applyProvider,
    id: params.applyModelId,
    baseUrl: "https://api.kimi.com/coding/",
    ...params.model,
  } as Model<Api>;
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});

  return payload;
}

describe("extra-params: Kimi/Moonshot thinking mapping", () => {
  it("explicitly disables Kimi Coding thinking for /think off", () => {
    const payload = runThinkingCase({
      applyProvider: "kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("uses Kimi type-only thinking payload for enabled levels", () => {
    const payload = runThinkingCase({
      applyProvider: "kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "high",
      payload: {
        model: "kimi-for-coding",
        messages: [],
        thinking: { type: "enabled", budget_tokens: 16384 },
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("lets /think off override configured Kimi thinking", () => {
    const payload = runThinkingCase({
      applyProvider: "kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "off",
      cfg: {
        agents: {
          defaults: {
            models: {
              "kimi/kimi-for-coding": {
                params: { thinking: { type: "enabled" } },
              },
            },
          },
        },
      },
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("normalizes unsupported tool choice while Kimi thinking is enabled", () => {
    const payload = runThinkingCase({
      applyProvider: "kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "high",
      payload: {
        model: "kimi-for-coding",
        messages: [],
        tool_choice: { type: "tool", name: "read_file" },
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.tool_choice).toBe("auto");
  });

  it("detects configured Moonshot-compatible base URLs", () => {
    const payload = runThinkingCase({
      applyProvider: "custom-kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "high",
      cfg: {
        models: {
          providers: {
            "custom-kimi": {
              baseUrl: "https://api.moonshot.ai/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "custom-kimi",
        baseUrl: undefined,
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
  });

  it("detects runtime Kimi-compatible base URLs", () => {
    const payload = runThinkingCase({
      applyProvider: "custom-kimi",
      applyModelId: "kimi-for-coding",
      thinkingLevel: "high",
      model: {
        provider: "custom-kimi",
        baseUrl: "https://api.kimi.com/coding/",
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
  });
});
