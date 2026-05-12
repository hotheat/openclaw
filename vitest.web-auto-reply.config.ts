import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter(
  (pattern) =>
    pattern !== "src/web/auto-reply*.test.ts" && pattern !== "src/web/auto-reply/**/*.test.ts",
);

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["src/web/auto-reply*.test.ts", "src/web/auto-reply/**/*.test.ts"],
    exclude,
  },
});
