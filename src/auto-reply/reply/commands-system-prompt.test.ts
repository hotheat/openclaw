import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
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
}));

vi.mock("../../agents/pi-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => []),
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

import { resolveCommandsSystemPromptBundle } from "./commands-system-prompt.js";

describe("resolveCommandsSystemPromptBundle", () => {
  it("passes runtime security policy into buildAgentSystemPrompt", async () => {
    const cfg = {
      agents: {
        defaults: {
          securityPolicyPath: "/tmp/custom-policy.md",
        },
      },
    };

    await resolveCommandsSystemPromptBundle({
      workspaceDir: "/tmp/workspace",
      cfg,
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
    } as never);

    expect(mocks.readRuntimeSecurityPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.readRuntimeSecurityPolicy).toHaveBeenCalledWith(cfg);
    expect(mocks.buildAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        securityPolicyPrompt: "Rule A\nRule B",
        runtimeInfo: expect.objectContaining({
          channel: "feishu",
        }),
      }),
    );
  });
});
