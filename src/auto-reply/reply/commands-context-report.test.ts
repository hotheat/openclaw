import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCommandsSystemPromptBundle: vi.fn(async () => ({
    systemPrompt: "system prompt",
    tools: [],
    warnings: [
      {
        code: "tools.create_failed",
        message: "Tool construction failed; report uses empty tool list.",
      },
    ],
    skillsPrompt: "",
    bootstrapFiles: [],
    injectedFiles: [],
    sandboxRuntime: { mode: "off", sandboxed: false },
  })),
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: mocks.resolveCommandsSystemPromptBundle,
}));

import { buildContextReply } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(commandBodyNormalized: string, truncated: boolean): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized,
      channel: "telegram",
      senderIsOwner: true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: null,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      totalTokens: 123,
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 150_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            missing: false,
            rawChars: truncated ? 200_000 : 10_000,
            injectedChars: truncated ? 20_000 : 10_000,
            truncated,
          },
        ],
        skills: {
          promptChars: 10,
          entries: [{ name: "checks", blockChars: 10 }],
        },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }],
        },
      },
    },
    cfg: {},
    ctx: {},
    commandBody: "",
    commandArgs: [],
    resolvedElevatedLevel: "off",
  } as unknown as HandleCommandsParams;
}

describe("buildContextReply", () => {
  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain(
      "Causes: 1 file(s) exceeded max/file; raw total exceeded max/total.",
    );
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
  });

  it.each(["list", "detail"])("shows tool-construction warnings in %s output", async (mode) => {
    const params = {
      ...makeParams(`/context ${mode}`, false),
      sessionEntry: {
        totalTokens: 123,
        inputTokens: 100,
        outputTokens: 23,
      },
    } as HandleCommandsParams;

    const result = await buildContextReply(params);

    expect(result.text).toContain("⚠ Tool construction failed; report uses empty tool list.");
  });

  it("includes tool-construction warnings in json output", async () => {
    const params = {
      ...makeParams("/context json", false),
      sessionEntry: {
        totalTokens: 123,
        inputTokens: 100,
        outputTokens: 23,
      },
    } as HandleCommandsParams;

    const result = await buildContextReply(params);
    const payload = JSON.parse(result.text ?? "");

    expect(payload.warnings).toEqual([
      {
        code: "tools.create_failed",
        message: "Tool construction failed; report uses empty tool list.",
      },
    ]);
  });
});
