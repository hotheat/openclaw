import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type EnvHttpProxyAgentOptions = NonNullable<ConstructorParameters<typeof EnvHttpProxyAgent>[0]>;

type EnvProxyDispatcherState = {
  dispatcher: EnvHttpProxyAgent;
  key: string;
};

type WebRequestLifetime = {
  abortPromise: Promise<never>;
  abortRequest: (error: Error) => void;
  cleanup: () => void;
  controller: AbortController;
};

let envProxyDispatcherState: EnvProxyDispatcherState | undefined;

export class WebRequestTimeoutError extends Error {
  readonly code = "WEB_REQUEST_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`Web request timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

function readEnvValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveEnvProxyOptions(): EnvHttpProxyAgentOptions {
  const allProxy = readEnvValue("all_proxy", "ALL_PROXY");
  const httpProxy = readEnvValue("http_proxy", "HTTP_PROXY") ?? allProxy;
  const httpsProxy = readEnvValue("https_proxy", "HTTPS_PROXY") ?? httpProxy;
  const noProxy = readEnvValue("no_proxy", "NO_PROXY");
  return { httpProxy, httpsProxy, noProxy };
}

function hasEnvProxy(): boolean {
  const options = resolveEnvProxyOptions();
  return Boolean(options.httpProxy || options.httpsProxy);
}

function resolveEnvProxyKey(): string {
  return [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.NO_PROXY,
    process.env.no_proxy,
  ]
    .map((value) => value ?? "")
    .join("\n");
}

function getEnvProxyDispatcher(): EnvHttpProxyAgent {
  const key = resolveEnvProxyKey();
  if (envProxyDispatcherState?.key === key) {
    return envProxyDispatcherState.dispatcher;
  }

  const previous = envProxyDispatcherState?.dispatcher;
  const dispatcher = new EnvHttpProxyAgent(resolveEnvProxyOptions());
  envProxyDispatcherState = { dispatcher, key };
  if (previous) {
    void previous.close().catch(() => {});
  }
  return dispatcher;
}

export function resolveWebFetch(): FetchLike {
  if (process.env.NODE_USE_ENV_PROXY !== "1" || !hasEnvProxy()) {
    return globalThis.fetch;
  }

  const dispatcher = getEnvProxyDispatcher();
  return async (input, init) =>
    (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as UndiciRequestInit | undefined),
      dispatcher,
    })) as unknown as Response;
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("This operation was aborted", "AbortError");
}

function createWebRequestLifetime(params: {
  timeoutMs: number;
  signal?: AbortSignal;
}): WebRequestLifetime {
  const controller = new AbortController();
  let rejectAbort: (error: Error) => void = () => {};
  let finished = false;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onExternalAbort = () => {
    abortRequest(abortErrorFromSignal(params.signal as AbortSignal));
  };
  const timeoutHandle = setTimeout(() => {
    abortRequest(new WebRequestTimeoutError(params.timeoutMs));
  }, params.timeoutMs);
  const cleanup = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timeoutHandle);
    params.signal?.removeEventListener("abort", onExternalAbort);
  };
  const abortRequest = (error: Error) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(error);
    cleanup();
    rejectAbort(error);
  };

  params.signal?.addEventListener("abort", onExternalAbort, { once: true });
  return { abortPromise, abortRequest, cleanup, controller };
}

function wrapResponseBody(response: Response, lifetime: WebRequestLifetime): Response {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    lifetime.cleanup();
    return response;
  }

  const reader = body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    lifetime.cleanup();
    try {
      reader.releaseLock();
    } catch {}
  };
  const cancelReader = (reason?: unknown) => {
    lifetime.cleanup();
    void reader
      .cancel(reason)
      .catch(() => {})
      .finally(finish);
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { value, done } = await Promise.race([reader.read(), lifetime.abortPromise]);
        if (done) {
          finish();
          streamController.close();
          return;
        }
        if (value) {
          streamController.enqueue(value);
        }
      } catch (error) {
        cancelReader(error);
        streamController.error(error);
      }
    },
    cancel(reason) {
      lifetime.abortRequest(
        reason instanceof Error
          ? reason
          : new DOMException("Response body cancelled", "AbortError"),
      );
      return reader.cancel(reason).finally(finish);
    },
  });
  const wrappedResponse = new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const wrappedProperties = new Set<PropertyKey>([
    "arrayBuffer",
    "blob",
    "body",
    "bodyUsed",
    "bytes",
    "clone",
    "formData",
    "json",
    "text",
  ]);

  return new Proxy(response, {
    get(target, property) {
      const owner = wrappedProperties.has(property) ? wrappedResponse : target;
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
}

export async function fetchWithWebTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    fetchFn?: FetchLike;
  },
): Promise<Response> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  if (options.signal?.aborted) {
    throw abortErrorFromSignal(options.signal);
  }

  const lifetime = createWebRequestLifetime({
    timeoutMs,
    signal: options.signal,
  });
  let acceptResponse = true;

  const fetchPromise = Promise.resolve()
    .then(() =>
      (options.fetchFn ?? resolveWebFetch())(input, {
        ...init,
        signal: lifetime.controller.signal,
      }),
    )
    .then((response) => {
      if (!acceptResponse) {
        void response.body?.cancel().catch(() => {});
      }
      return response;
    });

  try {
    const response = await Promise.race([fetchPromise, lifetime.abortPromise]);
    return wrapResponseBody(response, lifetime);
  } catch (error) {
    acceptResponse = false;
    lifetime.cleanup();
    void fetchPromise.catch(() => {});
    throw error;
  }
}

async function closeEnvProxyDispatcher(): Promise<void> {
  const state = envProxyDispatcherState;
  envProxyDispatcherState = undefined;
  await state?.dispatcher.close();
}

export const __testing = {
  closeEnvProxyDispatcher,
} as const;
