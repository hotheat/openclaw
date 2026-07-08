import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const mocks = vi.hoisted(() => ({
  createOpenClawTools: vi.fn<(options?: { agentChannel?: string }) => unknown[]>(() => []),
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
});
