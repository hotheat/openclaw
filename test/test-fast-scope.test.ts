import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("test:fast scope", () => {
  it("keeps high-cost integration surfaces out of the fast core suite", async () => {
    const configUrl = pathToFileURL(path.resolve(process.cwd(), "vitest.unit.config.ts")).href;
    const configModule = await import(configUrl);
    const config = configModule.default as { test?: { exclude?: string[] } };
    const exclude = config.test?.exclude ?? [];

    expect(exclude).toEqual(
      expect.arrayContaining([
        "src/agents/**",
        "src/auto-reply/**",
        "src/channels/**",
        "src/cli/**",
        "src/commands/**",
        "src/cron/**",
        "src/discord/**",
        "src/imessage/**",
        "src/line/**",
        "src/signal/**",
        "src/slack/**",
        "src/telegram/**",
        "src/tui/**",
        "src/web/**",
        "src/agents/tools/web-fetch*.test.ts",
        "src/agents/tools/web-tools.fetch.test.ts",
        "src/memory/batch-*.test.ts",
        "src/memory/embeddings*.test.ts",
        "src/memory/manager.batch.test.ts",
        "src/canvas-host/server.test.ts",
      ]),
    );
  });
});
