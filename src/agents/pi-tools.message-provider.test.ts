import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const mocks = vi.hoisted(() => ({
  createOpenClawTools: vi.fn<
    (options?: {
      agentChannel?: string;
      internalExecution?: boolean;
      requireExplicitMessageTarget?: boolean;
      disableMessageTool?: boolean;
    }) => unknown[]
  >(() => []),
}));

vi.mock("./openclaw-tools.js", () => ({
  createOpenClawTools: mocks.createOpenClawTools,
}));

describe("createOpenClawCodingTools message provider", () => {
  beforeEach(() => {
    mocks.createOpenClawTools.mockClear();
  });

  it("preserves plugin channel hints for message tool context", () => {
    createOpenClawCodingTools({ messageProvider: " FeiShu " });

    const call = mocks.createOpenClawTools.mock.calls[0]?.[0] as
      | { agentChannel?: string }
      | undefined;
    expect(call?.agentChannel).toBe("feishu");
  });

  it("marks internal runs and requires explicit message targets", () => {
    createOpenClawCodingTools({
      messageProvider: "internal",
      internalExecution: true,
    });

    const call = mocks.createOpenClawTools.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      agentChannel: "internal",
      internalExecution: true,
      requireExplicitMessageTarget: true,
    });
  });

  it.each(["webchat", "internal"])(
    "disables message for a parent WebChat session reached through %s",
    (messageProvider) => {
      createOpenClawCodingTools({
        messageProvider,
        sessionKey: "agent:main:webchat:namespace:chat_1",
      });

      expect(mocks.createOpenClawTools.mock.calls[0]?.[0]).toMatchObject({
        disableMessageTool: true,
      });
    },
  );

  it.each([
    ["internal", "agent:main:main"],
    ["internal", "agent:main:subagent:child_1"],
    ["control-ui", "agent:main:webchat:namespace:chat_1"],
    ["feishu", "agent:main:webchat:namespace:chat_1"],
  ])("keeps message for channel=%s sessionKey=%s", (messageProvider, sessionKey) => {
    createOpenClawCodingTools({ messageProvider, sessionKey });

    expect(mocks.createOpenClawTools.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: false,
    });
  });

  it("preserves an explicit disableMessageTool request", () => {
    createOpenClawCodingTools({
      messageProvider: "feishu",
      sessionKey: "agent:main:main",
      disableMessageTool: true,
    });

    expect(mocks.createOpenClawTools.mock.calls[0]?.[0]).toMatchObject({
      disableMessageTool: true,
    });
  });
});
