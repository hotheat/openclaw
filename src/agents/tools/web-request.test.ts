import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, fetchWithWebTimeout, WebRequestTimeoutError } from "./web-request.js";

describe.sequential("fetchWithWebTimeout", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await __testing.closeEnvProxyDispatcher();
  });

  it("rejects at the hard deadline when fetch ignores abort", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));

    await expect(
      fetchWithWebTimeout("https://example.com", {}, { timeoutMs: 20, fetchFn }),
    ).rejects.toBeInstanceOf(WebRequestTimeoutError);
  });

  it("rejects immediately when the external signal aborts", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const request = fetchWithWebTimeout(
      "https://example.com",
      {},
      {
        timeoutMs: 1_000,
        signal: controller.signal,
        fetchFn,
      },
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a response that arrives after the hard deadline", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
    } as unknown as Response;
    const fetchFn = vi.fn(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(response), 30)),
    );

    await expect(
      fetchWithWebTimeout("https://example.com", {}, { timeoutMs: 10, fetchFn }),
    ).rejects.toBeInstanceOf(WebRequestTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the hard deadline active while reading the response body", async () => {
    const response = new Response(
      new ReadableStream({
        start() {},
      }),
    );
    const result = await fetchWithWebTimeout(
      "https://example.com",
      {},
      {
        timeoutMs: 20,
        fetchFn: vi.fn().mockResolvedValue(response),
      },
    );

    await expect(result.text()).rejects.toBeInstanceOf(WebRequestTimeoutError);
  });

  it("keeps the external signal active while reading the response body", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    const response = new Response(
      new ReadableStream({
        start() {},
      }),
    );
    const result = await fetchWithWebTimeout(
      "https://example.com",
      {},
      {
        timeoutMs: 1_000,
        signal: controller.signal,
        fetchFn: vi.fn().mockResolvedValue(response),
      },
    );

    controller.abort(cancellation);

    await expect(result.text()).rejects.toBe(cancellation);
  });

  it.each(["HTTP_PROXY", "ALL_PROXY"])(
    "fails once when %s drops the HTTPS CONNECT tunnel",
    async (proxyEnv) => {
      let connectAttempts = 0;
      const sockets = new Set<net.Socket>();
      const proxy = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", () => {
          connectAttempts += 1;
          socket.destroy();
        });
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const address = proxy.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP proxy address");
      }
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      vi.stubEnv("HTTP_PROXY", "");
      vi.stubEnv("HTTPS_PROXY", "");
      vi.stubEnv("http_proxy", "");
      vi.stubEnv("https_proxy", "");
      vi.stubEnv("ALL_PROXY", "");
      vi.stubEnv("all_proxy", "");
      vi.stubEnv("NO_PROXY", "");
      vi.stubEnv("no_proxy", "");
      vi.stubEnv(proxyEnv, proxyUrl);

      try {
        await expect(
          fetchWithWebTimeout("https://example.com", {}, { timeoutMs: 1_000 }),
        ).rejects.toMatchObject({
          cause: {
            code: "UND_ERR_PRX_CONN",
          },
        });
        expect(connectAttempts).toBe(1);
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        proxy.close();
        await once(proxy, "close");
      }
    },
  );
});
