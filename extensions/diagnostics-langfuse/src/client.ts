import type { PropagateAttributesParams } from "@langfuse/tracing";
import type { ResolvedLangfuseConfig } from "./config.js";
import { maskSensitiveData } from "./mask.js";

export type LangfuseObservation = {
  id?: string;
  traceId?: string;
  startObservation?: (
    name: string,
    attributes?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => LangfuseObservation;
  update?: (attributes: Record<string, unknown>) => unknown;
  end?: (...args: unknown[]) => unknown;
};

export type LangfuseTraceClient = {
  authCheck?: () => Promise<boolean> | boolean;
  createTraceId: (seed?: string) => Promise<string>;
  propagateAttributes: <T>(params: PropagateAttributesParams, fn: () => T) => T;
  startObservation: (
    name: string,
    attributes?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => LangfuseObservation;
  flush?: () => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
};

export type LangfuseClientFactory = (
  config: ResolvedLangfuseConfig,
) => Promise<LangfuseTraceClient> | LangfuseTraceClient;

type DynamicImport = (specifier: string) => Promise<Record<string, unknown>>;

export const importRuntimeModule: DynamicImport = (specifier) => import(specifier);

export const createDefaultLangfuseClient: LangfuseClientFactory = async (config) => {
  const [tracing, otel, traceBase, clientModule] = await Promise.all([
    importRuntimeModule("@langfuse/tracing"),
    importRuntimeModule("@langfuse/otel"),
    importRuntimeModule("@opentelemetry/sdk-trace-base"),
    importRuntimeModule("@langfuse/client"),
  ]);
  const LangfuseSpanProcessor = otel.LangfuseSpanProcessor as new (
    params: Record<string, unknown>,
  ) => unknown;
  const BasicTracerProvider = traceBase.BasicTracerProvider as new (
    params: Record<string, unknown>,
  ) => { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  const LangfuseClient = clientModule.LangfuseClient as new (params: Record<string, unknown>) => {
    api?: { projects?: { get?: () => Promise<unknown> } };
  };
  const setLangfuseTracerProvider = tracing.setLangfuseTracerProvider as (
    provider: unknown,
  ) => void;
  const startObservation = tracing.startObservation as LangfuseTraceClient["startObservation"];
  const createTraceId = tracing.createTraceId as LangfuseTraceClient["createTraceId"];
  const propagateAttributes =
    tracing.propagateAttributes as LangfuseTraceClient["propagateAttributes"];

  const provider = new BasicTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.host,
        flushInterval: Math.max(1, Math.ceil(config.flushIntervalMs / 1000)),
        timeout: Math.max(1, Math.ceil(config.timeoutMs / 1000)),
        mask: ({ data }: { data: unknown }) => maskSensitiveData(data),
        shouldExportSpan: ({ otelSpan }: { otelSpan?: { name?: string } }) =>
          typeof otelSpan?.name === "string" && otelSpan.name.startsWith("openclaw."),
      }),
    ],
  });
  setLangfuseTracerProvider(provider);

  const apiClient = new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.host,
    timeout: Math.max(1, Math.ceil(config.timeoutMs / 1000)),
  });

  return {
    async authCheck() {
      await apiClient.api?.projects?.get?.();
      return true;
    },
    createTraceId,
    propagateAttributes,
    startObservation,
    flush: async () => {
      await provider.forceFlush?.();
    },
    shutdown: async () => {
      try {
        await provider.shutdown?.();
      } finally {
        setLangfuseTracerProvider(null);
      }
    },
  };
};
