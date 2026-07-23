import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import type { GatewayRequestContext } from "./types.js";

const steerEmbeddedPiRunMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  steerEmbeddedPiRun: steerEmbeddedPiRunMock,
}));

const { chatHandlers } = await import("./chat.js");

function createContext(runId = "run-1", sessionKey = "agent:main:main") {
  const now = Date.now();
  return {
    chatAbortControllers: new Map([
      [
        runId,
        {
          controller: new AbortController(),
          sessionId: "session-1",
          sessionKey,
          startedAtMs: now,
          expiresAtMs: now + 30_000,
          steerIdempotencyKeys: new Set<string>(),
        },
      ],
    ]),
    logGateway: {
      debug: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

async function invokeSteer(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  respond = vi.fn(),
) {
  await chatHandlers["chat.steer"]({
    params,
    respond: respond as never,
    context,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

beforeEach(() => {
  steerEmbeddedPiRunMock.mockReset().mockReturnValue({ status: "accepted" });
});

describe("chat.steer", () => {
  const params = {
    sessionKey: "agent:main:main",
    runId: "run-1",
    idempotencyKey: "steer-1",
    message: "Cafe\u0301\u0001",
  };

  it("sanitizes and injects exactly once for a repeated idempotency key", async () => {
    const context = createContext();
    const firstRespond = await invokeSteer(context, params);
    const secondRespond = await invokeSteer(context, params);

    expect(steerEmbeddedPiRunMock).toHaveBeenCalledTimes(1);
    expect(steerEmbeddedPiRunMock).toHaveBeenCalledWith("session-1", "Café");
    expect(firstRespond).toHaveBeenCalledWith(
      true,
      { runId: "run-1", status: "accepted" },
      undefined,
      { runId: "run-1" },
    );
    expect(secondRespond).toHaveBeenCalledWith(
      true,
      { runId: "run-1", status: "accepted" },
      undefined,
      { cached: true, runId: "run-1" },
    );
  });

  it("returns diagnostic not-steerable results without recording idempotency", async () => {
    const context = createContext();
    steerEmbeddedPiRunMock.mockReturnValue({
      status: "not_steerable",
      reason: "compacting",
    });

    const respond = await invokeSteer(context, params);

    expect(respond).toHaveBeenCalledWith(
      true,
      { runId: "run-1", status: "not_steerable", reason: "compacting" },
      undefined,
      { runId: "run-1" },
    );
    expect(context.chatAbortControllers.get("run-1")?.steerIdempotencyKeys.size).toBe(0);
  });

  it("treats a run that already ended as an expected race", async () => {
    const context = createContext();
    context.chatAbortControllers.clear();

    const respond = await invokeSteer(context, params);

    expect(steerEmbeddedPiRunMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, {
      runId: "run-1",
      status: "not_steerable",
      reason: "run_inactive",
    });
  });

  it("rejects session mismatches, null bytes, whitespace, and additional fields", async () => {
    const mismatch = await invokeSteer(createContext("run-1", "agent:other:main"), params);
    expect(mismatch.mock.calls.at(-1)?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);

    const nullByte = await invokeSteer(createContext(), { ...params, message: "bad\u0000input" });
    expect(nullByte.mock.calls.at(-1)?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);

    const whitespace = await invokeSteer(createContext(), { ...params, message: " \n " });
    expect(whitespace.mock.calls.at(-1)?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);

    const additional = await invokeSteer(createContext(), { ...params, sessionId: "forged" });
    expect(additional.mock.calls.at(-1)?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(steerEmbeddedPiRunMock).not.toHaveBeenCalled();
  });
});
