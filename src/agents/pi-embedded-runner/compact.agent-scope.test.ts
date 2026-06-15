import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { __testing } from "./compact.js";

describe("compact agent scope", () => {
  const cfg = {
    agents: {
      list: [{ id: "main", default: true }, { id: "vision" }],
    },
  } as OpenClawConfig;

  it("resolves the routed session agent before tool creation", () => {
    const scope = __testing.resolveCompactionAgentScope({
      sessionKey: "agent:vision:telegram:dm:123",
      config: cfg,
    });

    expect(scope.defaultAgentId).toBe("main");
    expect(scope.sessionAgentId).toBe("vision");
    expect(scope.isDefaultAgent).toBe(false);
  });

  it("uses the resolved session agent in before_compaction hook context", () => {
    const hookCtx = __testing.buildBeforeCompactionHookContext({
      sessionAgentId: "vision",
      sessionKey: "agent:vision:telegram:dm:123",
      sessionId: "s1",
      workspaceDir: "/tmp/workspace",
      messageChannel: "telegram",
      messageProvider: "telegram",
    });

    expect(hookCtx.agentId).toBe("vision");
    expect(hookCtx.agentId).not.toBe("agent");
  });
});
