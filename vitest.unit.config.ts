import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { include?: string[]; exclude?: string[] } }).test ?? {};
const include = (
  baseTest.include ?? ["src/**/*.test.ts", "extensions/**/*.test.ts", "test/format-error.test.ts"]
).filter((pattern) => !pattern.includes("extensions/"));
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include,
    exclude: [
      ...exclude,
      // Keep the default PR gate focused on repo-core regression coverage.
      "src/gateway/**",
      "extensions/**",
      "src/browser/**",
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
      // Keep remaining provider/media-heavy integration cases off the default PR fast lane.
      "src/agents/tools/web-fetch*.test.ts",
      "src/agents/tools/web-tools.fetch.test.ts",
      "src/memory/batch-*.test.ts",
      "src/memory/embeddings*.test.ts",
      "src/memory/manager.batch.test.ts",
      "src/canvas-host/server.test.ts",
      "src/slack/monitor/media.test.ts",
      "src/telegram/bot.create-telegram-bot.test.ts",
      "src/web/media.test.ts",
      "src/commands/chutes-oauth.test.ts",
      "src/agents/pi-tools-agent-config.test.ts",
    ],
  },
});
