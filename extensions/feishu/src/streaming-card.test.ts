import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuStreamingSession, isRetryableFeishuStreamingError } from "./streaming-card.js";

const fetchMock = vi.fn<typeof fetch>();
let appIdSequence = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createStartedSession(log = vi.fn()) {
  appIdSequence += 1;
  fetchMock
    .mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        msg: "ok",
        tenant_access_token: `token_${appIdSequence}`,
        expire: 7200,
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({ code: 0, msg: "ok", data: { card_id: `card_${appIdSequence}` } }),
    );

  const client = {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          code: 0,
          msg: "ok",
          data: { message_id: `message_${appIdSequence}` },
        }),
      },
    },
  };
  const session = new FeishuStreamingSession(
    client as never,
    { appId: `app_${appIdSequence}`, appSecret: "secret", domain: "feishu" },
    log,
  );
  await session.start("oc_chat");
  return session;
}

describe("FeishuStreamingSession CardKit failures", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("propagates HTTP failures while finalizing content and retries the same text", async () => {
    const session = await createStartedSession();
    fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));

    const error = await session.close("final answer").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Finalize streaming card content failed: HTTP 502");
    expect(isRetryableFeishuStreamingError(error)).toBe(true);
    expect(session.isActive()).toBe(true);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }));
    await session.close("final answer");

    const finalUpdateCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/elements/content/content"),
    );
    expect(finalUpdateCalls).toHaveLength(2);
    expect(session.isActive()).toBe(false);
  });

  it("propagates CardKit business errors while finalizing content", async () => {
    const session = await createStartedSession();
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 230001, msg: "invalid sequence" }));

    const error = await session.close("final answer").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(
      "Finalize streaming card content failed: HTTP 200, code=230001, msg=invalid sequence",
    );
    expect(isRetryableFeishuStreamingError(error)).toBe(false);
    expect(session.isActive()).toBe(true);
  });

  it("keeps a failed close active and marks it closed only after a successful retry", async () => {
    const log = vi.fn();
    const session = await createStartedSession(log);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }))
      .mockRejectedValueOnce(new Error("network unavailable"));

    await expect(session.close("final answer")).rejects.toThrow(
      "Close streaming card failed: Error: network unavailable",
    );
    expect(session.isActive()).toBe(true);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Closed streaming"));

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }));
    await session.close("final answer");

    expect(session.isActive()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Closed streaming"));
  });

  it("propagates close business errors without recording success", async () => {
    const log = vi.fn();
    const session = await createStartedSession(log);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ code: 230002, msg: "card update rejected" }));

    await expect(session.close("final answer")).rejects.toThrow(
      "Close streaming card failed: HTTP 200, code=230002, msg=card update rejected",
    );
    expect(session.isActive()).toBe(true);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Closed streaming"));
  });

  it("keeps the update queue usable after a failed CardKit update", async () => {
    const session = await createStartedSession();
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 230003, msg: "update rejected" }));

    await expect(session.update("partial answer")).rejects.toThrow(
      "Update streaming card content failed: HTTP 200, code=230003, msg=update rejected",
    );

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }));
    await session.update("partial answer");

    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, msg: "ok" }));
    await session.close("partial answer");
    expect(session.isActive()).toBe(false);
  });
});
