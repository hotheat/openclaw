import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as systemPromptModule from "../system-prompt.js";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

function createMockSession() {
  const setSystemPrompt = vi.fn();
  const session = {
    agent: { setSystemPrompt },
  } as unknown as AgentSession;
  return { session, setSystemPrompt };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applySystemPromptOverrideToSession", () => {
  it("applies a string override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const prompt = "You are a helpful assistant with custom context.";

    applySystemPromptOverrideToSession(session, prompt);

    expect(setSystemPrompt).toHaveBeenCalledWith(prompt);
    const mutable = session as unknown as { _baseSystemPrompt?: string };
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { session, setSystemPrompt } = createMockSession();

    applySystemPromptOverrideToSession(session, "  padded prompt  ");

    expect(setSystemPrompt).toHaveBeenCalledWith("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const { session, setSystemPrompt } = createMockSession();
    const override = createSystemPromptOverride("function-based prompt");

    applySystemPromptOverrideToSession(session, override);

    expect(setSystemPrompt).toHaveBeenCalledWith("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { session } = createMockSession();
    applySystemPromptOverrideToSession(session, "rebuild test");

    const mutable = session as unknown as {
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});

describe("buildEmbeddedSystemPrompt", () => {
  it("passes runtime security policy through to buildAgentSystemPrompt", async () => {
    const spy = vi
      .spyOn(systemPromptModule, "buildAgentSystemPrompt")
      .mockReturnValue("system prompt");
    const { buildEmbeddedSystemPrompt } = await import("./system-prompt.js");

    buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "host",
        os: "linux",
        arch: "x64",
        node: "v22",
        model: "openai/gpt-5.4",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "Asia/Shanghai",
      securityPolicyPrompt: "Rule A\nRule B",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        securityPolicyPrompt: "Rule A\nRule B",
      }),
    );
  });
});
