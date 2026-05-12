import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;
const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = (baseTest.exclude ?? []).filter(
  (pattern) =>
    pattern !== "src/agents/pi-embedded-runner*.test.ts" &&
    pattern !== "src/agents/pi-embedded-runner/**/*.test.ts",
);

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: [
      "src/agents/pi-embedded-runner*.test.ts",
      "src/agents/pi-embedded-runner/**/*.test.ts",
    ],
    exclude,
  },
});
