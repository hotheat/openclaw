import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Api, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";

export { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

type ModelRegistryRegisterConfig = Parameters<ModelRegistry["registerProvider"]>[1];

type JsonRecord = Record<string, unknown>;

type ParsedModelOverlay = {
  models: Map<string, RawModelOverlay>;
  providerApiKeys: Map<string, string>;
};

type RawModelOverlay = Pick<Model<Api>, "id" | "provider"> &
  Partial<Omit<Model<Api>, "id" | "provider">>;

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function createAuthStorage(AuthStorageLike: unknown, path: string) {
  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  if (typeof withFactory.create === "function") {
    return withFactory.create(path) as AuthStorage;
  }
  return new (AuthStorageLike as { new (path: string): unknown })(path) as AuthStorage;
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseInput(value: unknown): ("text" | "image")[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const input = value.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return input.length > 0 ? input : undefined;
}

function parseCost(value: unknown): Model<Api>["cost"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    input: typeof value.input === "number" ? value.input : 0,
    output: typeof value.output === "number" ? value.output : 0,
    cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
    cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
  };
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      const resolved = resolveRawConfigString(headerValue);
      if (resolved) {
        headers[key] = resolved;
      }
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function resolveRawConfigString(value: string): string | undefined {
  const normalized = normalizeOptionalSecretInput(value);
  if (!normalized) {
    return undefined;
  }
  const envRef = /^\$\{([A-Z0-9_]+)\}$/.exec(normalized);
  return envRef ? normalizeOptionalSecretInput(process.env[envRef[1]]) : normalized;
}

function mergeHeaders(
  providerHeaders: Record<string, string> | undefined,
  modelHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = { ...providerHeaders, ...modelHeaders };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function hasAuthorizationHeader(headers?: Record<string, string>): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");
}

function withoutAuthorizationHeader(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "authorization") {
      next[key] = value;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function mergeRawModelHeaders(
  baseHeaders: Record<string, string> | undefined,
  overlayHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const safeBaseHeaders = hasAuthorizationHeader(overlayHeaders)
    ? baseHeaders
    : withoutAuthorizationHeader(baseHeaders);
  return mergeHeaders(safeBaseHeaders, overlayHeaders);
}

function completeRawModelOverlay(overlay: RawModelOverlay): Model<Api> | undefined {
  if (!overlay.api || !overlay.baseUrl) {
    return undefined;
  }
  return {
    id: overlay.id,
    name: overlay.name ?? overlay.id,
    api: overlay.api,
    provider: overlay.provider,
    baseUrl: overlay.baseUrl,
    reasoning: overlay.reasoning ?? false,
    input: overlay.input ?? ["text"],
    cost: overlay.cost ?? { ...DEFAULT_COST },
    contextWindow: overlay.contextWindow ?? 128_000,
    maxTokens: overlay.maxTokens ?? 16_384,
    headers: overlay.headers,
    compat: overlay.compat,
  };
}

function mergeRawModelOverlay(base: Model<Api>, overlay: RawModelOverlay): Model<Api> {
  return {
    ...base,
    ...overlay,
    name: overlay.name ?? base.name,
    api: overlay.api ?? base.api,
    baseUrl: overlay.baseUrl ?? base.baseUrl,
    reasoning: overlay.reasoning ?? base.reasoning,
    input: overlay.input ?? base.input,
    cost: overlay.cost ?? base.cost,
    contextWindow: overlay.contextWindow ?? base.contextWindow,
    maxTokens: overlay.maxTokens ?? base.maxTokens,
    headers: mergeRawModelHeaders(base.headers, overlay.headers),
    compat: overlay.compat ?? base.compat,
  };
}

function mergeModelLists(primary: Model<Api>[], overlay: Iterable<RawModelOverlay>): Model<Api>[] {
  const merged = [...primary];
  for (const model of overlay) {
    const index = merged.findIndex(
      (entry) => entry.provider === model.provider && entry.id === model.id,
    );
    if (index >= 0) {
      merged[index] = mergeRawModelOverlay(merged[index], model);
      continue;
    }
    const completed = completeRawModelOverlay(model);
    if (completed) {
      merged.push(completed);
    }
  }
  return merged;
}

class OpenClawModelRegistry extends ModelRegistry {
  private readonly rawModelsJsonPath: string;
  private rawModels = new Map<string, RawModelOverlay>();
  private rawProviderApiKeys = new Map<string, string>();
  private dynamicProviderApiKeys = new Map<string, string>();

  constructor(authStorage: AuthStorage, modelsJsonPath: string) {
    super(authStorage, modelsJsonPath);
    this.rawModelsJsonPath = modelsJsonPath;
    this.refreshRawOverlay();
  }

  override refresh(): void {
    super.refresh();
    this.refreshRawOverlay();
  }

  override getAll(): Model<Api>[] {
    return mergeModelLists(super.getAll(), this.rawModels.values());
  }

  override getAvailable(): Model<Api>[] {
    return this.getAll().filter((model) => this.hasAuthForProvider(model.provider));
  }

  override find(provider: string, modelId: string): Model<Api> | undefined {
    const overlay = this.rawModels.get(modelKey(provider, modelId));
    const base = super.find(provider, modelId);
    if (overlay && base) {
      return mergeRawModelOverlay(base, overlay);
    }
    if (overlay) {
      return completeRawModelOverlay(overlay);
    }
    return base;
  }

  override async getApiKey(model: Model<Api>): Promise<string | undefined> {
    return this.getApiKeyForProvider(model.provider);
  }

  override async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const apiKey = await super.getApiKeyForProvider(provider);
    return apiKey ?? this.resolveFallbackApiKey(provider);
  }

  override registerProvider(providerName: string, config: ModelRegistryRegisterConfig): void {
    super.registerProvider(providerName, config);
    if (config.apiKey) {
      this.dynamicProviderApiKeys.set(providerName, config.apiKey);
    } else {
      this.dynamicProviderApiKeys.delete(providerName);
    }
    this.installFallbackResolver();
  }

  private refreshRawOverlay(): void {
    const overlay = parseRawModelOverlay(this.rawModelsJsonPath);
    this.rawModels = overlay.models;
    this.rawProviderApiKeys = overlay.providerApiKeys;
    this.installFallbackResolver();
  }

  private installFallbackResolver(): void {
    this.authStorage.setFallbackResolver((provider) => this.resolveFallbackApiKey(provider));
  }

  private resolveFallbackApiKey(provider: string): string | undefined {
    const apiKeyConfig =
      this.dynamicProviderApiKeys.get(provider) ?? this.rawProviderApiKeys.get(provider);
    return apiKeyConfig ? resolveRawConfigString(apiKeyConfig) : undefined;
  }

  private hasAuthForProvider(provider: string): boolean {
    return this.authStorage.hasAuth(provider) || !!this.resolveFallbackApiKey(provider);
  }
}

function parseRawModelOverlay(modelsJsonPath: string): ParsedModelOverlay {
  const overlay: ParsedModelOverlay = {
    models: new Map(),
    providerApiKeys: new Map(),
  };
  if (!existsSync(modelsJsonPath)) {
    return overlay;
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
  } catch {
    return overlay;
  }

  if (!isRecord(config) || !isRecord(config.providers)) {
    return overlay;
  }

  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }

    const providerApiKey = optionalString(providerConfig.apiKey);
    if (providerApiKey) {
      overlay.providerApiKeys.set(providerName, providerApiKey);
    }

    const modelDefs = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    if (modelDefs.length === 0) {
      continue;
    }

    const baseUrl = optionalString(providerConfig.baseUrl);
    const providerApi = optionalString(providerConfig.api);

    const providerHeaders = parseHeaders(providerConfig.headers);
    for (const modelDef of modelDefs) {
      if (!isRecord(modelDef)) {
        continue;
      }
      const id = optionalString(modelDef.id);
      const api = optionalString(modelDef.api) ?? providerApi;
      if (!id) {
        continue;
      }

      const headers = mergeHeaders(providerHeaders, parseHeaders(modelDef.headers));
      const name = optionalString(modelDef.name);
      const reasoning = optionalBoolean(modelDef.reasoning);
      const input = parseInput(modelDef.input);
      const cost = parseCost(modelDef.cost);
      const contextWindow = optionalPositiveNumber(modelDef.contextWindow);
      const maxTokens = optionalPositiveNumber(modelDef.maxTokens);

      const model: RawModelOverlay = {
        id,
        provider: providerName,
      };
      if (name) {
        model.name = name;
      }
      if (api) {
        model.api = api as Api;
      }
      if (baseUrl) {
        model.baseUrl = baseUrl;
      }
      if (reasoning !== undefined) {
        model.reasoning = reasoning;
      }
      if (input) {
        model.input = input;
      }
      if (cost) {
        model.cost = cost;
      }
      if (contextWindow !== undefined) {
        model.contextWindow = contextWindow;
      }
      if (maxTokens !== undefined) {
        model.maxTokens = maxTokens;
      }
      if (headers) {
        model.headers = headers;
      }
      if (isRecord(modelDef.compat)) {
        model.compat = modelDef.compat as Model<Api>["compat"];
      }
      overlay.models.set(modelKey(providerName, id), model);
    }
  }

  return overlay;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): AuthStorage {
  return createAuthStorage(AuthStorage, path.join(agentDir, "auth.json"));
}

export function discoverModels(authStorage: AuthStorage, agentDir: string): ModelRegistry {
  return new OpenClawModelRegistry(authStorage, path.join(agentDir, "models.json"));
}
