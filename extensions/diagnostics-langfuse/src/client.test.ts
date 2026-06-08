import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLangfuseClient } from "./client.js";

const langfuseMocks = vi.hoisted(() => ({
  setLangfuseTracerProvider: vi.fn(),
  startObservation: vi.fn(),
  createTraceId: vi.fn(async () => "trace-id"),
  langfuseSpanProcessor: vi.fn(function LangfuseSpanProcessor() {}),
  providerShutdown: vi.fn(),
  providerForceFlush: vi.fn(),
  basicTracerProvider: vi.fn(function BasicTracerProvider() {
    return {
      forceFlush: langfuseMocks.providerForceFlush,
      shutdown: langfuseMocks.providerShutdown,
    };
  }),
  langfuseClient: vi.fn(function LangfuseClient() {
    return { api: { projects: { get: vi.fn() } } };
  }),
}));

const mockVirtualModule = vi.mock as unknown as (
  specifier: string,
  factory: () => Record<string, unknown>,
  options: { virtual: true },
) => void;

mockVirtualModule(
  "@langfuse/tracing",
  () => ({
    setLangfuseTracerProvider: langfuseMocks.setLangfuseTracerProvider,
    startObservation: langfuseMocks.startObservation,
    createTraceId: langfuseMocks.createTraceId,
  }),
  { virtual: true },
);

mockVirtualModule(
  "@langfuse/otel",
  () => ({
    LangfuseSpanProcessor: langfuseMocks.langfuseSpanProcessor,
  }),
  { virtual: true },
);

mockVirtualModule(
  "@opentelemetry/sdk-trace-base",
  () => ({
    BasicTracerProvider: langfuseMocks.basicTracerProvider,
  }),
  { virtual: true },
);

mockVirtualModule(
  "@langfuse/client",
  () => ({
    LangfuseClient: langfuseMocks.langfuseClient,
  }),
  { virtual: true },
);

describe("diagnostics-langfuse client module loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports runtime modules from a jiti-loaded plugin without VM dynamic import callback errors", async () => {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".js"],
    });
    const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "client.ts");
    const clientModule = jiti(clientPath) as {
      importRuntimeModule?: (specifier: string) => Promise<Record<string, unknown>>;
    };

    const fsModule = await clientModule.importRuntimeModule?.("node:fs");

    expect(typeof fsModule?.readFileSync).toBe("function");
  });

  it("clears the Langfuse tracer provider on shutdown", async () => {
    const client = await createDefaultLangfuseClient({
      enabled: true,
      host: "http://localhost:3005",
      publicKey: "pk",
      secretKey: "sk",
      flushIntervalMs: 1000,
      timeoutMs: 1000,
      captureMode: "safe",
      serviceName: "openclaw-gateway",
    });

    await client.shutdown?.();

    expect(langfuseMocks.providerShutdown).toHaveBeenCalledTimes(1);
    expect(langfuseMocks.setLangfuseTracerProvider).toHaveBeenLastCalledWith(null);
  });
});
