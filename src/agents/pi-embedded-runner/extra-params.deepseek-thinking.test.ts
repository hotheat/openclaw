import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

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

function runDeepseekCase(params: {
  applyProvider: string;
  applyModelId: string;
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
  model?: Partial<Model<"openai-completions">>;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
}) {
  const payload: Record<string, unknown> = {
    model: params.applyModelId,
    messages: [],
    reasoning_effort: "low",
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
    api: "openai-completions",
    provider: params.applyProvider,
    id: params.applyModelId,
    baseUrl: params.applyProvider === "deepseek" ? "https://api.deepseek.com" : undefined,
    ...params.model,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});

  return payload;
}

describe("extra-params: DeepSeek thinking mapping", () => {
  it("maps medium thinking to enabled high effort", () => {
    const payload = runDeepseekCase({
      applyProvider: "deepseek",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "medium",
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
  });

  it("maps xhigh thinking to enabled max effort", () => {
    const payload = runDeepseekCase({
      applyProvider: "deepseek",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "xhigh",
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("max");
  });

  it("maps off thinking to disabled and clears stale reasoning_effort", () => {
    const payload = runDeepseekCase({
      applyProvider: "deepseek",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "off",
    });

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("detects custom providers pointed at the DeepSeek base URL", () => {
    const payload = runDeepseekCase({
      applyProvider: "custom-deepseek",
      applyModelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      cfg: {
        models: {
          providers: {
            "custom-deepseek": {
              baseUrl: "https://api.deepseek.com",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      model: {
        provider: "custom-deepseek",
        baseUrl: "https://api.deepseek.com",
      },
    });

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
  });

  it("does not inject DeepSeek fields for unrelated providers", () => {
    const payload = runDeepseekCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      thinkingLevel: "high",
      model: {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(payload).not.toHaveProperty("thinking");
    expect(payload.reasoning_effort).toBe("low");
  });
});
