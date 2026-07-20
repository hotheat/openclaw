import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnConfigOverride,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const callGatewayMock = getCallGatewayMock();

describe("openclaw-tools: subagents (sessions_spawn allowlist)", () => {
  function setAllowAgents(allowAgents: string[]) {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents,
            },
          },
        ],
      },
    });
  }

  function mockAcceptedSpawn(acceptedAt: number) {
    let childSessionKey: string | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      if (request.method === "agent") {
        const params = request.params as { sessionKey?: string } | undefined;
        childSessionKey = params?.sessionKey;
        return { runId: "run-1", status: "accepted", acceptedAt };
      }
      if (request.method === "agent.wait") {
        return new Promise<never>(() => undefined);
      }
      return {};
    });
    return () => childSessionKey;
  }

  async function executeSpawn(callId: string, agentId: string) {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });
    return tool.execute(callId, { task: "do thing", agentId });
  }

  async function expectAllowedSpawn(params: {
    allowAgents: string[];
    agentId: string;
    callId: string;
    acceptedAt: number;
  }) {
    setAllowAgents(params.allowAgents);
    const getChildSessionKey = mockAcceptedSpawn(params.acceptedAt);

    const result = await executeSpawn(params.callId, params.agentId);

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith(`agent:${params.agentId}:subagent:`)).toBe(true);
  }

  beforeEach(() => {
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
  });

  it("sessions_spawn only allows same-agent by default", async () => {
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call6", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn forbids cross-agent spawning when not allowed", async () => {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["alpha"],
            },
          },
        ],
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call9", {
      task: "do thing",
      agentId: "beta",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("sessions_spawn allows cross-agent spawning when configured", async () => {
    await expectAllowedSpawn({
      allowAgents: ["beta"],
      agentId: "beta",
      callId: "call7",
      acceptedAt: 5000,
    });
  });

  it("sessions_spawn allows cross-agent spawning from default allowlist", async () => {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["ppt-agent"],
          },
        },
        list: [
          {
            id: "main",
          },
          {
            id: "ppt-agent",
          },
        ],
      },
    });
    const getChildSessionKey = mockAcceptedSpawn(5300);

    const result = await executeSpawn("call-defaults", "ppt-agent");

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    expect(getChildSessionKey()?.startsWith("agent:ppt-agent:subagent:")).toBe(true);
  });

  it("sessions_spawn allows any agent when allowlist is *", async () => {
    await expectAllowedSpawn({
      allowAgents: ["*"],
      agentId: "beta",
      callId: "call8",
      acceptedAt: 5100,
    });
  });

  it("sessions_spawn normalizes allowlisted agent ids", async () => {
    await expectAllowedSpawn({
      allowAgents: ["Research"],
      agentId: "research",
      callId: "call10",
      acceptedAt: 5200,
    });
  });

  it("stores parent completion delivery preference for same-agent runs", async () => {
    mockAcceptedSpawn(5400);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "feishu",
    });

    const result = await tool.execute("call-parent-delivery", {
      task: "do thing",
      completionDelivery: "parent",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completionDelivery).toBe("parent");
  });

  it("stores direct completion delivery preference for same-agent runs", async () => {
    mockAcceptedSpawn(5500);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call-direct-delivery", {
      task: "do thing",
      completionDelivery: "direct",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completionDelivery).toBe("direct");
  });

  it("rejects direct completion delivery without a deliverable target", async () => {
    mockAcceptedSpawn(5600);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "feishu",
    });

    const result = await tool.execute("call-direct-delivery-no-target", {
      task: "do thing",
      completionDelivery: "direct",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: unknown };
    expect(String(details.error)).toContain("agentTo");
    expect(callGatewayMock).not.toHaveBeenCalled();
    const runs = listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(0);
  });

  it("allows direct completion delivery to the current WebChat session", async () => {
    mockAcceptedSpawn(5650);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:feishu-ou_test:webchat:namespace:chat_1",
    });

    const result = await tool.execute("call-webchat-direct-delivery", {
      task: "do thing",
      completionDelivery: "direct",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    const runs = listSubagentRunsForRequester("agent:feishu-ou_test:webchat:namespace:chat_1");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completionDelivery).toBe("direct");
  });

  it("allows direct completion delivery from nested requester sessions without an external target", async () => {
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
          },
        },
      },
    });
    mockAcceptedSpawn(5700);
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:orchestrator",
      agentChannel: "feishu",
    });

    const result = await tool.execute("call-nested-direct-delivery", {
      task: "do nested thing",
      completionDelivery: "direct",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
    const runs = listSubagentRunsForRequester("agent:main:subagent:orchestrator");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completionDelivery).toBe("direct");
  });
});
