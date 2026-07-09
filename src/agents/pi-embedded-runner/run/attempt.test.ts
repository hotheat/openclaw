import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLlmInputEvent,
  computePreflightHistoryTarget,
  emitLlmInputHook,
  estimatePromptPreflightTokens,
  formatContextPreflightLog,
  injectHistoryImagesIntoMessages,
  prunePromptHistoryAfterEmergencyCompaction,
  rebuildPromptHistoryImagesAfterPreflightCompaction,
  resolvePromptBuildHookResult,
  runPreflightCompactionToSettled,
  shouldCompactBeforePrompt,
} from "./attempt.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

afterEach(() => {
  vi.useRealTimers();
});

describe("injectHistoryImagesIntoMessages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("injects history images and converts string content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "See /tmp/photo.png",
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(true);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(Array.isArray(firstUser?.content)).toBe(true);
    const content = firstUser?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("avoids duplicating existing image content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      } as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[0, [image]]]));

    expect(didMutate).toBe(false);
    const first = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
  });

  it("ignores non-user messages and out-of-range indices", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: "noop",
      } as unknown as AgentMessage,
    ];

    const didMutate = injectHistoryImagesIntoMessages(messages, new Map([[1, [image]]]));

    expect(didMutate).toBe(false);
    const firstAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }> | undefined;
    expect(firstAssistant?.content).toBe("noop");
  });
});

describe("resolvePromptBuildHookResult", () => {
  function createLegacyOnlyHookRunner() {
    return {
      hasHooks: vi.fn(
        (hookName: "before_prompt_build" | "before_agent_start") =>
          hookName === "before_agent_start",
      ),
      runBeforePromptBuild: vi.fn(async () => undefined),
      runBeforeAgentStart: vi.fn(async () => ({ prependContext: "from-hook" })),
    };
  }

  it("reuses precomputed legacy before_agent_start result without invoking hook again", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages: [],
      hookCtx: {},
      hookRunner,
      legacyBeforeAgentStartResult: { prependContext: "from-cache", systemPrompt: "legacy-system" },
    });

    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
    expect(result).toEqual({
      prependContext: "from-cache",
      systemPrompt: "legacy-system",
    });
  });

  it("calls legacy hook when precomputed result is absent", async () => {
    const hookRunner = createLegacyOnlyHookRunner();
    const messages = [{ role: "user", content: "ctx" }];
    const result = await resolvePromptBuildHookResult({
      prompt: "hello",
      messages,
      hookCtx: {},
      hookRunner,
    });

    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(hookRunner.runBeforeAgentStart).toHaveBeenCalledWith({ prompt: "hello", messages }, {});
    expect(result.prependContext).toBe("from-hook");
  });
});

describe("preflight context compaction", () => {
  it("includes context window source in diagnostic log", () => {
    const line = formatContextPreflightLog({
      runId: "run-1",
      sessionKey: "agent:test",
      provider: "otr",
      modelId: "workspace-model",
      estimate: {
        historyTokens: 10,
        promptTokens: 20,
        systemPromptTokens: 30,
        toolSchemaTokens: 40,
        imageTokens: 0,
        totalTokens: 100,
      },
      contextWindowTokens: 262_144,
      contextWindowSource: "modelsConfig",
      reserveTokens: 20_000,
      willCompact: false,
    });

    expect(line).toContain("contextWindow=262144");
    expect(line).toContain("contextWindowSource=modelsConfig");
  });

  it("estimates pending prompt context with safety margin", () => {
    const estimate = estimatePromptPreflightTokens({
      messages: [{ role: "user", content: "a".repeat(400) } as AgentMessage],
      prompt: "b".repeat(400),
      systemPrompt: "c".repeat(400),
      toolDefinitions: [{ function: { name: "read", parameters: { path: "string" } } }],
      promptImageCount: 1,
    });

    expect(estimate.historyTokens).toBeGreaterThan(0);
    expect(estimate.promptTokens).toBe(100);
    expect(estimate.systemPromptTokens).toBe(100);
    expect(estimate.toolSchemaTokens).toBeGreaterThan(0);
    expect(estimate.imageTokens).toBe(1200);
    expect(estimate.totalTokens).toBeGreaterThan(
      estimate.historyTokens +
        estimate.promptTokens +
        estimate.systemPromptTokens +
        estimate.toolSchemaTokens +
        estimate.imageTokens,
    );
  });

  it("counts every model-facing tool payload in the preflight estimate", () => {
    const singleToolEstimate = estimatePromptPreflightTokens({
      messages: [],
      prompt: "",
      systemPrompt: "",
      toolDefinitions: [{ name: "custom", description: "x".repeat(200) }],
      promptImageCount: 0,
    });
    const allToolsEstimate = estimatePromptPreflightTokens({
      messages: [],
      prompt: "",
      systemPrompt: "",
      toolDefinitions: [
        { name: "builtin", description: "y".repeat(200) },
        { name: "custom", description: "x".repeat(200) },
      ],
      promptImageCount: 0,
    });

    expect(allToolsEstimate.toolSchemaTokens).toBeGreaterThan(singleToolEstimate.toolSchemaTokens);
    expect(allToolsEstimate.totalTokens).toBeGreaterThan(singleToolEstimate.totalTokens);
  });

  it("triggers before prompt when estimate crosses reserved context threshold", () => {
    expect(
      shouldCompactBeforePrompt({
        estimate: {
          historyTokens: 0,
          promptTokens: 0,
          systemPromptTokens: 0,
          toolSchemaTokens: 0,
          imageTokens: 0,
          totalTokens: 91,
        },
        contextWindowTokens: 100,
        reserveTokens: 10,
      }),
    ).toBe(true);

    expect(
      shouldCompactBeforePrompt({
        estimate: {
          historyTokens: 0,
          promptTokens: 0,
          systemPromptTokens: 0,
          toolSchemaTokens: 0,
          imageTokens: 0,
          totalTokens: 90,
        },
        contextWindowTokens: 100,
        reserveTokens: 10,
      }),
    ).toBe(false);
  });

  it("redetects history image injections from rebuilt preflight compaction history", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-preflight-history-image-"));
    const imagePath = path.join(root, "first.png");
    await fs.writeFile(imagePath, Buffer.from(PNG_1X1_BASE64, "base64"));
    const rebuiltMessages: AgentMessage[] = [
      {
        role: "assistant",
        content: "summary moved before the user turn",
      } as unknown as AgentMessage,
      {
        role: "user",
        content: `Compare with ${imagePath}`,
      } as AgentMessage,
    ];

    try {
      const finalMessages = await rebuildPromptHistoryImagesAfterPreflightCompaction({
        rebuiltMessages,
        prompt: "follow up",
        workspaceDir: root,
        model: { input: ["text", "image"] },
      });

      expect(finalMessages).toBe(rebuiltMessages);
      const firstMessage = finalMessages[0] as Extract<AgentMessage, { role: "assistant" }>;
      expect(firstMessage.content).toBe("summary moved before the user turn");
      const rebuiltUser = finalMessages[1] as Extract<AgentMessage, { role: "user" }> | undefined;
      expect(Array.isArray(rebuiltUser?.content)).toBe(true);
      const content = rebuiltUser?.content as Array<{ type: string; data?: string }>;
      expect(content.some((item) => item.type === "image" && item.data)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("aborts and waits for real preflight compaction promise before surfacing timeout", async () => {
    vi.useFakeTimers();
    let rejectCompaction: ((err: Error) => void) | undefined;
    let settled = false;
    const abortCompaction = vi.fn(() => {
      expect(settled).toBe(false);
    });
    const compact = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCompaction = reject;
        }),
    );

    const resultPromise = runPreflightCompactionToSettled({
      compact,
      abortCompaction,
      timeoutMs: 10,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    rejectCompaction?.(new Error("compaction cancelled"));
    await expect(resultPromise).rejects.toThrow("Compaction timed out");
    expect(settled).toBe(true);
  });

  it("abandons the post-abort wait when preflight compaction never settles", async () => {
    vi.useFakeTimers();
    let settled = false;
    const abortCompaction = vi.fn();
    const compact = vi.fn(() => new Promise<never>(() => undefined));

    const resultPromise = runPreflightCompactionToSettled({
      compact,
      abortCompaction,
      timeoutMs: 10,
    }).catch((err) => {
      settled = true;
      return err as Error;
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    const err = await resultPromise;
    if (!(err instanceof Error)) {
      throw new Error("expected timeout error");
    }
    expect(err.message).toContain("Compaction timed out");
  });

  it("emits llm_input using the final prompt-facing history messages", async () => {
    const runLlmInput = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "llm_input"),
      runLlmInput,
    };
    const finalHistoryMessages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "compare" },
          { type: "image", data: "img" },
        ],
      } as AgentMessage,
    ];

    emitLlmInputHook({
      hookRunner: hookRunner as never,
      event: buildLlmInputEvent({
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-test",
        systemPrompt: "system",
        prompt: "follow up",
        historyMessages: finalHistoryMessages,
        imagesCount: 0,
      }),
      ctx: {
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "session-key",
        workspaceDir: "/tmp/workspace",
      },
    });

    await Promise.resolve();

    expect(runLlmInput).toHaveBeenCalledTimes(1);
    expect(runLlmInput.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      sessionId: "session-1",
      provider: "openai",
      model: "gpt-test",
      prompt: "follow up",
      historyMessages: finalHistoryMessages,
      imagesCount: 0,
    });
  });

  it("re-estimates and prunes emergency-compacted history before prompting when still over budget", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "web_fetch", arguments: {} }],
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "web_fetch",
        content: [{ type: "text", text: "w".repeat(80_000) }],
      } as unknown as AgentMessage,
      { role: "user", content: "current request" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "current answer" }],
      } as unknown as AgentMessage,
    ];

    const result = prunePromptHistoryAfterEmergencyCompaction({
      messages,
      prompt: "follow up",
      systemPrompt: "",
      toolDefinitions: [],
      promptImageCount: 0,
      contextWindowTokens: 5_000,
      reserveTokens: 500,
      repairToolUseResultPairing: false,
    });

    expect(result.pruned).toBe(true);
    expect(result.estimateAfter.totalTokens).toBeLessThan(result.estimateBefore.totalTokens);
    expect(result.withinBudget).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("truncated");
  });

  it("reports withinBudget=false when non-history components alone exceed the window", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "current request" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "current answer" }],
      } as unknown as AgentMessage,
    ];

    const result = prunePromptHistoryAfterEmergencyCompaction({
      messages,
      prompt: "follow up",
      // ~10k tokens of system prompt: by itself larger than the 4_500-token budget,
      // so no amount of history pruning can bring the prompt back within the window.
      systemPrompt: "s".repeat(40_000),
      toolDefinitions: [],
      promptImageCount: 0,
      contextWindowTokens: 5_000,
      reserveTokens: 500,
      repairToolUseResultPairing: false,
    });

    expect(result.estimateBefore.totalTokens).toBeGreaterThan(5_000 - 500);
    expect(result.targetHistoryTokens).toBe(1);
    expect(result.withinBudget).toBe(false);
    expect(result.estimateAfter.totalTokens).toBeGreaterThan(5_000 - 500);
  });
});

describe("computePreflightHistoryTarget", () => {
  const estimate = (
    overrides: Partial<Record<string, number>> = {},
  ): Parameters<typeof computePreflightHistoryTarget>[0]["estimate"] => ({
    historyTokens: 0,
    promptTokens: 0,
    systemPromptTokens: 0,
    toolSchemaTokens: 0,
    imageTokens: 0,
    totalTokens: 0,
    ...overrides,
  });

  it("keeps the 0.6 safety ceiling when the prompt leaves ample room", () => {
    // window 10_000, reserve 1_000 -> budget 9_000 -> /1.2 = 7_500; minus 300 non-history
    // = 7_200, which is above the 0.6 ceiling (6_000), so the ceiling wins.
    const target = computePreflightHistoryTarget({
      estimate: estimate({
        promptTokens: 100,
        systemPromptTokens: 100,
        toolSchemaTokens: 100,
      }),
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    expect(target).toBe(6_000);
  });

  it("tightens below the ceiling when non-history components are large", () => {
    // non-history = 4_000; budget 9_000 /1.2 = 7_500 - 4_000 = 3_500 (< ceiling 6_000).
    const target = computePreflightHistoryTarget({
      estimate: estimate({
        promptTokens: 1_000,
        systemPromptTokens: 1_500,
        toolSchemaTokens: 1_500,
      }),
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    expect(target).toBe(3_500);
  });

  it("clamps to 1 when non-history alone exceeds the window", () => {
    // non-history 12_000 already larger than the 9_000 budget -> maxHistory negative.
    const target = computePreflightHistoryTarget({
      estimate: estimate({
        promptTokens: 4_000,
        systemPromptTokens: 4_000,
        toolSchemaTokens: 4_000,
      }),
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    expect(target).toBe(1);
  });
});
