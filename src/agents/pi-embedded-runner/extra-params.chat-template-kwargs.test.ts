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

function runChatTemplateKwargsCase(params: {
  configured: unknown;
  payload?: Record<string, unknown>;
  extraParamsOverride?: Record<string, unknown>;
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
}) {
  const provider = "qwen-openai";
  const modelId = "qwen/qwen3.8-27b";
  const payload = params.payload ?? { model: modelId, messages: [] };
  const baseStreamFn: StreamFn = (model, _context, options) => {
    invokeOnPayloadCompat(options, payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(
    agent,
    {
      agents: {
        defaults: {
          models: {
            [`${provider}/${modelId}`]: {
              params: {
                chatTemplateKwargs: params.configured,
              },
            },
          },
        },
      },
    },
    provider,
    modelId,
    params.extraParamsOverride,
    params.thinkingLevel,
  );

  const model = {
    api: "openai-completions",
    provider,
    id: modelId,
    compat: {
      thinkingFormat: "qwen",
    },
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, {});

  return payload;
}

describe("extra-params: chatTemplateKwargs passthrough", () => {
  it("injects configured values into chat_template_kwargs", () => {
    const payload = runChatTemplateKwargsCase({
      configured: {
        preserve_thinking: true,
      },
    });

    expect(payload.chat_template_kwargs).toEqual({
      preserve_thinking: true,
    });
  });

  it("preserves existing keys and overrides configured keys", () => {
    const payload = runChatTemplateKwargsCase({
      configured: {
        preserve_thinking: true,
      },
      payload: {
        model: "qwen/qwen3.8-27b",
        messages: [],
        chat_template_kwargs: {
          enable_thinking: true,
          preserve_thinking: false,
        },
      },
    });

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: true,
    });
  });

  it("lets runtime extra params replace model-level kwargs", () => {
    const payload = runChatTemplateKwargsCase({
      configured: {
        preserve_thinking: true,
      },
      extraParamsOverride: {
        chatTemplateKwargs: {
          preserve_thinking: false,
        },
      },
    });

    expect(payload.chat_template_kwargs).toEqual({
      preserve_thinking: false,
    });
  });

  it("ignores non-object values", () => {
    const payload = runChatTemplateKwargsCase({
      configured: ["preserve_thinking"],
    });

    expect(payload).not.toHaveProperty("chat_template_kwargs");
  });

  it.each([
    {
      thinkingLevel: "low",
      reasoningEffort: "low",
    },
    {
      thinkingLevel: "medium",
      reasoningEffort: "medium",
    },
    {
      thinkingLevel: "high",
      reasoningEffort: "xhigh",
    },
  ] as const)(
    "maps $thinkingLevel thinking to Qwen request fields",
    ({ thinkingLevel, reasoningEffort }) => {
      const payload = runChatTemplateKwargsCase({
        configured: {
          preserve_thinking: false,
        },
        thinkingLevel,
      });

      expect(payload.chat_template_kwargs).toEqual({
        preserve_thinking: false,
        enable_thinking: true,
      });
      expect(payload.reasoning_effort).toBe(reasoningEffort);
    },
  );

  it("maps off thinking to the Qwen chat template and clears stale effort", () => {
    const payload = runChatTemplateKwargsCase({
      configured: {
        enable_thinking: true,
        preserve_thinking: false,
      },
      payload: {
        model: "qwen/qwen3.8-27b",
        messages: [],
        reasoning_effort: "xhigh",
        chat_template_kwargs: {
          enable_thinking: true,
          preserve_thinking: true,
        },
      },
      thinkingLevel: "off",
    });

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: false,
      preserve_thinking: false,
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("applies runtime thinking after configured chat template kwargs", () => {
    const payload = runChatTemplateKwargsCase({
      configured: {
        enable_thinking: false,
        preserve_thinking: false,
      },
      thinkingLevel: "medium",
    });

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: true,
      preserve_thinking: false,
    });
    expect(payload.reasoning_effort).toBe("medium");
  });
});
