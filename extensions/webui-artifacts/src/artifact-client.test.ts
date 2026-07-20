import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_SESSION_LIMIT_CODE, ArtifactClient } from "./artifact-client.js";

const upload = {
  url: "https://oss.invalid/presigned",
  headers: {
    "Content-MD5": "md5",
    "Content-Type": "text/plain",
    "x-oss-meta-sha256": "sha256",
  },
};

describe("ArtifactClient", () => {
  it("sends the fixed internal contract without adding sessionKey to complete or abort", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ artifactId: "artifact_1", upload }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ArtifactClient({
      endpoint: "http://127.0.0.1:8303/",
      apiKey: "service-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const input = {
      sessionKey: "agent:a:webchat:n:s",
      fileName: "report.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      sha256: "sha256",
      md5Base64: "md5",
      sourceToolCallId: "call_1",
    };

    await client.init(input);
    await client.complete("artifact_1");
    await client.abort("artifact_1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8303/api/v1/openclaw/internal/artifacts/init",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:8303/api/v1/openclaw/internal/artifacts/artifact_1/complete",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://127.0.0.1:8303/api/v1/openclaw/internal/artifacts/artifact_1/abort",
    );
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBeUndefined();
  });

  it("recognizes a nested FastAPI quota code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: ARTIFACT_SESSION_LIMIT_CODE } }), {
        status: 409,
      }),
    );
    const client = new ArtifactClient({
      endpoint: "http://127.0.0.1:8303",
      apiKey: "service-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.init({
        sessionKey: "agent:a:webchat:n:s",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        sha256: "sha256",
        md5Base64: "md5",
      }),
    ).rejects.toMatchObject({
      phase: "init",
      status: 409,
      code: ARTIFACT_SESSION_LIMIT_CODE,
    });
  });

  it("uses returned signed headers and a counted content length for PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const client = new ArtifactClient({
      endpoint: "http://127.0.0.1:8303",
      apiKey: "service-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.upload({
      target: upload,
      body: Readable.from([Buffer.from("abc")]),
      sizeBytes: 3,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { duplex?: string };
    const headers = new Headers(init.headers);
    expect(init.method).toBe("PUT");
    expect(init.duplex).toBe("half");
    expect(headers.get("content-md5")).toBe("md5");
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("x-oss-meta-sha256")).toBe("sha256");
    expect(headers.get("content-length")).toBe("3");
  });

  it("rejects an init response missing a required signed header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          artifactId: "artifact_1",
          upload: { url: upload.url, headers: { "Content-Type": "text/plain" } },
        }),
        { status: 200 },
      ),
    );
    const client = new ArtifactClient({
      endpoint: "http://127.0.0.1:8303",
      apiKey: "service-key",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.init({
        sessionKey: "agent:a:webchat:n:s",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        sha256: "sha256",
        md5Base64: "md5",
      }),
    ).rejects.toMatchObject({ phase: "init" });
  });

  it("aborts init when the phase timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason ?? new Error("aborted")),
              { once: true },
            );
          }),
      );
      const client = new ArtifactClient({
        endpoint: "http://127.0.0.1:8303",
        apiKey: "service-key",
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      const promise = client.init({
        sessionKey: "agent:a:webchat:n:s",
        fileName: "report.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        sha256: "sha256",
        md5Base64: "md5",
      });
      const rejection = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
