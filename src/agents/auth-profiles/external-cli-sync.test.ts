import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn(),
  readMiniMaxCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(),
}));

vi.mock("../cli-credentials.js", () => mocks);

import { syncExternalCliCredentials } from "./external-cli-sync.js";

describe("syncExternalCliCredentials", () => {
  beforeEach(() => {
    mocks.readCodexCliCredentialsCached.mockReset();
    mocks.readMiniMaxCliCredentialsCached.mockReset();
    mocks.readQwenCliCredentialsCached.mockReset();
  });

  it("bootstraps openai-codex default OAuth credentials from Codex CLI", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 60_000,
    });
    const store: AuthProfileStore = { version: 1, profiles: {} };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
    });
  });

  it("keeps explicit openai-codex api key profiles over Codex CLI bootstrap", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 60_000,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "api_key",
          provider: "openai-codex",
          key: "explicit-key",
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "api_key",
      provider: "openai-codex",
      key: "explicit-key",
    });
  });

  it("does not overwrite existing openai-codex OAuth token material", () => {
    mocks.readCodexCliCredentialsCached.mockReturnValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 60_000,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "local-access",
          refresh: "local-refresh",
          expires: Date.now() - 60_000,
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(false);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "local-access",
      refresh: "local-refresh",
    });
    expect(mocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
  });
});
