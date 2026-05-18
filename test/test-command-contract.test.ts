import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("test command contract", () => {
  it("keeps the default test script aligned with the fast CI lane and preserves a full suite escape hatch", async () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    expect(scripts.test).toBe("pnpm test:fast");
    expect(scripts["test:fast"]).toBe("node scripts/test-fast.mjs");
    expect(scripts["test:full"]).toBe("node scripts/test-parallel.mjs");
    expect(scripts["test:all"]).toContain("pnpm test:full");
  });
});
