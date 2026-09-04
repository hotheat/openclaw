import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
  createOpenClawCodingTools: vi.fn(() => []),
  logWarn: vi.fn(),
  readRuntimeSecurityPolicy: vi.fn(async () => "Rule A\nRule B"),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: mocks.buildAgentSystemPrompt,
}));

vi.mock("../../agents/security-policy.js", () => ({
  readRuntimeSecurityPolicy: mocks.readRuntimeSecurityPolicy,
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({ bootstrapFiles: [], contextFiles: [] })),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({ prompt: "", skills: [], resolvedSkills: [] })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => "test"),
  skillsSnapshotHasMissingFiles: vi.fn(() => false),
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../../agents/tool-summaries.js", () => ({
  buildToolSummaryMap: vi.fn(() => ({})),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveSessionAgentIds: vi.fn(() => ({
    sessionAgentId: "main",
    defaultAgentId: "main",
  })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.4" })),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: {
      host: "host",
      os: "linux",
      arch: "x64",
      node: "v22",
      model: "openai/gpt-5.4",
      defaultModel: "openai/gpt-5.4",
    },
    userTimezone: "Asia/Shanghai",
    userTime: undefined,
    userTimeFormat: "24",
  })),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false, mode: "off" })),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
}));

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: mocks.logWarn,
  })),
}));

import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(): HandleCommandsParams {
  return {
    workspaceDir: "/tmp/workspace",
    cfg: {
      agents: {
        defaults: {
          securityPolicyPath: "/tmp/custom-policy.md",
        },
      },
    },
    sessionKey: "agent:main",
    sessionEntry: undefined,
    command: {
      channel: "feishu",
      senderIsOwner: false,
    },
    provider: "openai",
    model: "gpt-5.4",
    agentId: "main",
    elevated: { allowed: false },
    resolvedElevatedLevel: "off",
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    ctx: { SessionKey: "agent:main" },
  } as unknown as HandleCommandsParams;
}

describe("resolveCommandsSystemPromptBundle", () => {
  it("passes runtime security policy into buildAgentSystemPrompt", async () => {
    const params = makeParams();

    await resolveCommandsSystemPromptBundle(params);

    expect(mocks.readRuntimeSecurityPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.readRuntimeSecurityPolicy).toHaveBeenCalledWith(params.cfg);
    expect(mocks.buildAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        securityPolicyPrompt: "Rule A\nRule B",
        runtimeInfo: expect.objectContaining({
          channel: "feishu",
        }),
      }),
    );
  });

  it("logs and exposes a warning when tool construction fails without polluting the prompt", async () => {
    mocks.createOpenClawCodingTools.mockImplementationOnce(() => {
      throw new TypeError("tool factory failed");
    });

    const bundle = await resolveCommandsSystemPromptBundle(makeParams());

    expect(bundle.tools).toEqual([]);
    expect(bundle.warnings).toEqual([
      {
        code: "tools.create_failed",
        message: "Tool construction failed; report uses empty tool list.",
      },
    ]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "failed to construct tools for system prompt report",
      expect.objectContaining({
        sessionKey: "agent:main",
        agentId: "main",
        channel: "feishu",
        provider: "openai",
        model: "gpt-5.4",
        errorType: "TypeError",
        errorMessage: "tool factory failed",
      }),
    );
    expect(bundle.systemPrompt).not.toContain("Tool construction failed");
  });
});
