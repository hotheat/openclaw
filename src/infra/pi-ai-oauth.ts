import type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthPrompt,
  OAuthProvider,
} from "@mariozechner/pi-ai";

type OAuthProviderInfo = {
  id: string;
};

type OAuthApiKeyResult = {
  apiKey: string;
  newCredentials: OAuthCredentials;
};

type LoginOpenAICodexOptions = {
  onAuth?: (event: OAuthAuthInfo) => unknown;
  onPrompt?: (prompt: OAuthPrompt) => unknown;
  onProgress?: (message: string) => unknown;
};

type PiAiOAuthModule = {
  getOAuthApiKey?: (
    provider: OAuthProvider,
    credentials: Record<string, OAuthCredentials>,
  ) => Promise<OAuthApiKeyResult | null>;
  getOAuthProviders?: () => OAuthProviderInfo[];
  loginOpenAICodex?: (
    options: LoginOpenAICodexOptions,
  ) => Promise<OAuthCredentials | null | undefined>;
};

let piAiOAuthModulePromise: Promise<PiAiOAuthModule> | null = null;
const PI_AI_OAUTH_SUBPATH = "@mariozechner/pi-ai/oauth";
const PI_AI_PACKAGE = "@mariozechner/pi-ai";

function isMissingOAuthSubpathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
}

async function loadPiAiOAuthModule(): Promise<PiAiOAuthModule> {
  if (!piAiOAuthModulePromise) {
    piAiOAuthModulePromise = (async () => {
      try {
        return (await import(PI_AI_OAUTH_SUBPATH)) as PiAiOAuthModule;
      } catch (error) {
        if (!isMissingOAuthSubpathError(error)) {
          throw error;
        }
        return (await import(PI_AI_PACKAGE)) as PiAiOAuthModule;
      }
    })();
  }
  return await piAiOAuthModulePromise;
}

function requireModuleFunction<TKey extends keyof PiAiOAuthModule>(
  mod: PiAiOAuthModule,
  name: TKey,
): NonNullable<PiAiOAuthModule[TKey]> {
  const candidate = mod[name];
  if (typeof candidate !== "function") {
    throw new Error(`@mariozechner/pi-ai is missing required OAuth helper: ${String(name)}`);
  }
  return candidate as NonNullable<PiAiOAuthModule[TKey]>;
}

export async function getPiAiOAuthProviders(): Promise<OAuthProviderInfo[]> {
  const mod = await loadPiAiOAuthModule();
  return requireModuleFunction(mod, "getOAuthProviders")();
}

export async function getPiAiOAuthApiKey(
  provider: OAuthProvider,
  credentials: Record<string, OAuthCredentials>,
): Promise<OAuthApiKeyResult | null> {
  const mod = await loadPiAiOAuthModule();
  return await requireModuleFunction(mod, "getOAuthApiKey")(provider, credentials);
}

export async function loginOpenAICodexWithPiAi(
  options: LoginOpenAICodexOptions,
): Promise<OAuthCredentials | null> {
  const mod = await loadPiAiOAuthModule();
  const creds = await requireModuleFunction(mod, "loginOpenAICodex")(options);
  return creds ?? null;
}
