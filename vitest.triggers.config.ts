import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter(
  (pattern) =>
    pattern !== "src/auto-reply/reply.triggers*.test.ts" &&
    pattern !== "src/auto-reply/reply.triggers/**/*.test.ts",
);

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [
      "src/auto-reply/reply.triggers*.test.ts",
      "src/auto-reply/reply.triggers/**/*.test.ts",
    ],
    exclude,
  },
});
