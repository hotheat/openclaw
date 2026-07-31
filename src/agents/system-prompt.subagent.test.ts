import { describe, expect, it } from "vitest";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";

describe("buildSubagentSystemPrompt", () => {
  it("renders depth-1 orchestrator guidance, labels, and recovery notes", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain("You CAN spawn your own sub-agents");
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain("`subagents` tool");
    expect(prompt).toContain("announce their results back to you automatically");
    expect(prompt).toContain("Do NOT repeatedly poll `subagents list`");
    expect(prompt).toContain("spawned by the main agent");
    expect(prompt).toContain("reported to the main agent");
    expect(prompt).toContain("[compacted: tool output removed to free context]");
    expect(prompt).toContain("[truncated: output exceeded context limit]");
    expect(prompt).toContain("offset/limit");
    expect(prompt).toContain("instead of full-file `cat`");
    expect(prompt).toContain("present in your actual tool list");
    expect(prompt).toContain("return the content, recipient, and channel to the main agent");
  });

  it("renders depth-2 leaf guidance with parent orchestrator labels", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc:subagent:def",
      task: "leaf task",
      childDepth: 2,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain("leaf worker");
    expect(prompt).toContain("CANNOT spawn further sub-agents");
    expect(prompt).toContain("spawned by the parent orchestrator");
    expect(prompt).toContain("reported to the parent orchestrator");
  });

  it("omits spawning guidance for depth-1 leaf agents", () => {
    const leafCases = [
      {
        name: "explicit maxSpawnDepth 1",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "research task",
          childDepth: 1,
          maxSpawnDepth: 1,
        },
        expectMainAgentLabel: false,
      },
      {
        name: "implicit default depth/maxSpawnDepth",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "basic task",
        },
        expectMainAgentLabel: true,
      },
    ] as const;

    for (const testCase of leafCases) {
      const prompt = buildSubagentSystemPrompt(testCase.input);
      expect(prompt, testCase.name).not.toContain("## Sub-Agent Spawning");
      expect(prompt, testCase.name).not.toContain("You CAN spawn");
      if (testCase.expectMainAgentLabel) {
        expect(prompt, testCase.name).toContain("spawned by the main agent");
      }
    }
  });
});
