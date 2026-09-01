import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeCommandBody } from "../commands-registry.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const steerEmbeddedPiRunAllowPendingMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  steerEmbeddedPiRunAllowPending: steerEmbeddedPiRunAllowPendingMock,
}));

import { handleSteerCommand } from "./commands-steer.js";

const cfg = { commands: { text: true } } as OpenClawConfig;

function buildParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "feishu",
    Surface: "feishu",
  });
  params.command.commandBodyNormalized = normalizeCommandBody(commandBody);
  params.sessionEntry = { sessionId: "feishu-session", updatedAt: Date.now() };
  return params;
}

beforeEach(() => {
  steerEmbeddedPiRunAllowPendingMock.mockReset().mockReturnValue({
    status: "accepted",
    mode: "steered",
  });
});

describe("handleSteerCommand", () => {
  it("does not handle the command when text commands are disabled", async () => {
    const result = await handleSteerCommand(buildParams("/steer guidance"), false);

    expect(result).toBeNull();
    expect(steerEmbeddedPiRunAllowPendingMock).not.toHaveBeenCalled();
  });

  it("steers the current Feishu session with Chinese guidance", async () => {
    const result = await handleSteerCommand(
      buildParams("/steer 先停止继续搜索，只汇总已有内容"),
      true,
    );

    expect(result).toEqual({ shouldContinue: false, reply: { text: "已注入当前运行。" } });
    expect(steerEmbeddedPiRunAllowPendingMock).toHaveBeenCalledWith(
      "feishu-session",
      "先停止继续搜索，只汇总已有内容",
    );
  });

  it("preserves multi-word guidance casing and punctuation", async () => {
    const result = await handleSteerCommand(
      buildParams("/STEER Keep APIName, 中文标点！ Then check timer.ts."),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(steerEmbeddedPiRunAllowPendingMock).toHaveBeenCalledWith(
      "feishu-session",
      "Keep APIName, 中文标点！ Then check timer.ts.",
    );
  });

  it("preserves multiline guidance from the raw command body", async () => {
    const result = await handleSteerCommand(
      buildParams("/steer 先停止继续搜索\n- 只汇总已有内容\n- 保留 APIName 大小写"),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(steerEmbeddedPiRunAllowPendingMock).toHaveBeenCalledWith(
      "feishu-session",
      "先停止继续搜索\n- 只汇总已有内容\n- 保留 APIName 大小写",
    );
  });

  it("returns usage for an empty message", async () => {
    const result = await handleSteerCommand(buildParams("/steer   "), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(steerEmbeddedPiRunAllowPendingMock).not.toHaveBeenCalled();
  });

  it("silently blocks unauthorized senders before reading run state", async () => {
    const params = buildParams("/steer secret guidance");
    params.command.isAuthorizedSender = false;
    params.command.senderId = "unauthorized-user";

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(steerEmbeddedPiRunAllowPendingMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing session entry",
      mutate: (params: ReturnType<typeof buildParams>) => (params.sessionEntry = undefined),
    },
    {
      name: "missing session id",
      mutate: (params: ReturnType<typeof buildParams>) =>
        (params.sessionEntry = { sessionId: "", updatedAt: Date.now() }),
    },
  ])("rejects $name", async ({ mutate }) => {
    const params = buildParams("/steer guidance");
    mutate(params);

    const result = await handleSteerCommand(params, true);

    expect(result?.reply?.text).toBe("当前会话不可引导。");
    expect(steerEmbeddedPiRunAllowPendingMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      runnerResult: { status: "accepted", mode: "queued" },
      expectedText: "已排队，将在运行启动时注入。",
    },
    {
      runnerResult: { status: "not_steerable", reason: "run_inactive" },
      expectedText: "当前没有可引导的运行。直接发送消息即可开始新回合。",
    },
    {
      runnerResult: { status: "not_steerable", reason: "not_streaming" },
      expectedText: "当前运行暂时不能接收引导，请稍后重试。",
    },
    {
      runnerResult: { status: "not_steerable", reason: "compacting" },
      expectedText: "当前会话正在压缩上下文，暂时不能接收引导。",
    },
  ])("maps $runnerResult to its command reply", async ({ runnerResult, expectedText }) => {
    steerEmbeddedPiRunAllowPendingMock.mockReturnValue(runnerResult);

    const result = await handleSteerCommand(buildParams("/steer guidance"), true);

    expect(result?.reply?.text).toBe(expectedText);
  });

  it.each(["/steering guidance", "/steerx guidance"])(
    "does not match the adjacent command %s",
    async (commandBody) => {
      const result = await handleSteerCommand(buildParams(commandBody), true);

      expect(result).toBeNull();
      expect(steerEmbeddedPiRunAllowPendingMock).not.toHaveBeenCalled();
    },
  );
});
