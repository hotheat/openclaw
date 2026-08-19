import type { Readable } from "node:stream";

const INIT_PATH = "/api/v1/openclaw/internal/artifacts/init";
const ARTIFACT_PATH = "/api/v1/openclaw/internal/artifacts";
const REQUIRED_UPLOAD_HEADERS = new Set(["content-md5", "content-type", "x-oss-meta-sha256"]);
const INIT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 30_000;

export const ARTIFACT_SESSION_LIMIT_CODE = "ARTIFACT_SESSION_LIMIT_REACHED";

export type ArtifactInitInput = {
  sessionKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  md5Base64: string;
  sourceToolCallId?: string;
  anchorToolCallId?: string;
};

export type ArtifactUploadTarget = {
  url: string;
  headers: Record<string, string>;
};

export type ArtifactInitResult = {
  artifactId: string;
  upload: ArtifactUploadTarget;
};

export type ArtifactUploadInput = {
  target: ArtifactUploadTarget;
  body: Readable;
  sizeBytes: number;
  signal?: AbortSignal;
};

export interface ArtifactTransport {
  init(input: ArtifactInitInput, signal?: AbortSignal): Promise<ArtifactInitResult>;
  upload(input: ArtifactUploadInput): Promise<void>;
  complete(artifactId: string, signal?: AbortSignal): Promise<void>;
  abort(artifactId: string): Promise<void>;
}

export class ArtifactApiError extends Error {
  constructor(
    readonly phase: "init" | "upload" | "complete" | "abort",
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`Artifact request failed (phase=${phase}, status=${status ?? "unknown"})`);
    this.name = "ArtifactApiError";
  }
}

type ArtifactClientConfig = {
  endpoint?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

function normalizeEndpoint(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Artifact endpoint is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Artifact endpoint is invalid");
  }
  return raw.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return null;
    }
    result[key] = item;
  }
  return result;
}

function validateInitResult(value: unknown): ArtifactInitResult {
  if (!isRecord(value) || !isRecord(value.upload)) {
    throw new ArtifactApiError("init");
  }
  const artifactId = typeof value.artifactId === "string" ? value.artifactId.trim() : "";
  const url = typeof value.upload.url === "string" ? value.upload.url.trim() : "";
  const headers = readStringRecord(value.upload.headers);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(artifactId) || !headers) {
    throw new ArtifactApiError("init");
  }
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ArtifactApiError("init");
  }
  const headerNames = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (![...REQUIRED_UPLOAD_HEADERS].every((name) => headerNames.has(name))) {
    throw new ArtifactApiError("init");
  }
  return { artifactId, upload: { url, headers } };
}

function signalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromInput = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromInput();
  } else {
    signal?.addEventListener("abort", abortFromInput, { once: true });
  }
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Artifact request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromInput);
    },
  };
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      return undefined;
    }
    if (typeof payload.code === "string") {
      return payload.code;
    }
    return isRecord(payload.detail) && typeof payload.detail.code === "string"
      ? payload.detail.code
      : undefined;
  } catch {
    return undefined;
  }
}

export class ArtifactClient implements ArtifactTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ArtifactClientConfig) {
    this.endpoint = normalizeEndpoint(config.endpoint);
    this.apiKey = config.apiKey?.trim() ?? "";
    if (!this.apiKey) {
      throw new Error("Artifact API key is missing");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async init(input: ArtifactInitInput, signal?: AbortSignal): Promise<ArtifactInitResult> {
    const timedSignal = signalWithTimeout(signal, INIT_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${INIT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(input),
        signal: timedSignal.signal,
      });
      if (!response.ok) {
        throw new ArtifactApiError("init", response.status, await readErrorCode(response));
      }
      return validateInitResult((await response.json()) as unknown);
    } finally {
      timedSignal.dispose();
    }
  }

  async upload(input: ArtifactUploadInput): Promise<void> {
    const headers = new Headers(input.target.headers);
    headers.set("content-length", String(input.sizeBytes));
    const timedSignal = signalWithTimeout(input.signal, UPLOAD_TIMEOUT_MS);
    const request: RequestInit & { duplex: "half" } = {
      method: "PUT",
      headers,
      body: input.body as unknown as BodyInit,
      duplex: "half",
      signal: timedSignal.signal,
    };
    try {
      const response = await this.fetchImpl(input.target.url, request);
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        throw new ArtifactApiError("upload", response.status);
      }
    } finally {
      timedSignal.dispose();
    }
  }

  async complete(artifactId: string, signal?: AbortSignal): Promise<void> {
    await this.postArtifactAction(artifactId, "complete", signal);
  }

  async abort(artifactId: string): Promise<void> {
    await this.postArtifactAction(artifactId, "abort", AbortSignal.timeout(5_000));
  }

  private async postArtifactAction(
    artifactId: string,
    action: "complete" | "abort",
    signal?: AbortSignal,
  ): Promise<void> {
    const timedSignal = signalWithTimeout(
      signal,
      action === "complete" ? COMPLETE_TIMEOUT_MS : 5_000,
    );
    try {
      const response = await this.fetchImpl(
        `${this.endpoint}${ARTIFACT_PATH}/${encodeURIComponent(artifactId)}/${action}`,
        {
          method: "POST",
          headers: { "x-api-key": this.apiKey },
          signal: timedSignal.signal,
        },
      );
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        throw new ArtifactApiError(action, response.status);
      }
    } finally {
      timedSignal.dispose();
    }
  }
}
