import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../../config/config.js";
import { modelsAuthSyncCommand } from "./auth-sync.js";

describe("models auth sync", () => {
  const previousEnv = { ...process.env };
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-auth-sync-"));
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
    process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";
    clearConfigCache();

    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            list: [{ id: "main", default: true }, { id: "kid" }],
          },
        },
        null,
        2,
      ),
    );

    await fs.mkdir(path.join(root, "agents", "main", "agent"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", "kid", "agent"), { recursive: true });

    const oauth = {
      type: "oauth",
      provider: "openai-codex",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      accountId: "acct",
    };
    await fs.writeFile(
      path.join(root, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles: { "openai-codex:default": oauth } }, null, 2),
    );
    await fs.writeFile(
      path.join(root, "agents", "main", "agent", "auth.json"),
      JSON.stringify(
        {
          "openai-codex": {
            type: "oauth",
            access: "access",
            refresh: "refresh",
            expires: oauth.expires,
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(root, "agents", "kid", "agent", "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "api_key",
              provider: "openai-codex",
              key: "old-key",
            },
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    process.env = { ...previousEnv };
    clearConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("copies source OAuth profile to all agents and writes pi auth json", async () => {
    const logs: string[] = [];
    const runtime = {
      log: (...args: unknown[]) => logs.push(args.join(" ")),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await modelsAuthSyncCommand(
      {
        provider: "openai-codex",
        fromAgent: "main",
        toAgents: "all",
        json: true,
      },
      runtime,
    );

    const summary = JSON.parse(logs.join("\n"));
    expect(summary).toMatchObject({
      provider: "openai-codex",
      profileId: "openai-codex:default",
      fromAgent: "main",
      toAgents: "all",
      targets: 2,
      profileWritten: 1,
      authJsonWritten: 1,
      skipped: 1,
    });

    const kidProfiles = JSON.parse(
      await fs.readFile(path.join(root, "agents", "kid", "agent", "auth-profiles.json"), "utf8"),
    );
    expect(kidProfiles.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "access",
      refresh: "refresh",
      accountId: "acct",
    });

    const kidAuthJson = JSON.parse(
      await fs.readFile(path.join(root, "agents", "kid", "agent", "auth.json"), "utf8"),
    );
    expect(kidAuthJson["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "access",
      refresh: "refresh",
    });
  });
});
