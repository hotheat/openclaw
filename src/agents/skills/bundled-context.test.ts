import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  resetBundledSkillsContextForTest,
  resolveBundledSkillsContext,
} from "./bundled-context.js";

describe("resolveBundledSkillsContext", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
    resetBundledSkillsContextForTest();
  });

  afterEach(() => {
    envSnapshot.restore();
    resetBundledSkillsContextForTest();
  });

  it("warns once when the bundled skills directory cannot be resolved", async () => {
    delete process.env.OPENCLAW_BUNDLED_SKILLS_DIR;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-missing-bundled-"));
    const binDir = path.join(root, "bin");
    const distDir = path.join(root, "dist");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(distDir, { recursive: true });
    const argv1 = path.join(binDir, "openclaw");
    const modulePath = path.join(distDir, "skills.js");
    await fs.writeFile(argv1, "// stub", "utf-8");
    await fs.writeFile(modulePath, "// stub", "utf-8");
    const warnings: string[] = [];

    const first = resolveBundledSkillsContext({
      argv1,
      cwd: distDir,
      execPath: path.join(binDir, "node"),
      moduleUrl: pathToFileURL(modulePath).href,
      warn: (message) => warnings.push(message),
    });
    const second = resolveBundledSkillsContext({
      argv1,
      cwd: distDir,
      execPath: path.join(binDir, "node"),
      moduleUrl: pathToFileURL(modulePath).href,
      warn: (message) => warnings.push(message),
    });

    expect(first.dir).toBeUndefined();
    expect(second.dir).toBeUndefined();
    expect(first.names.size).toBe(0);
    expect(second.names.size).toBe(0);
    expect(warnings).toEqual([
      "Bundled skills directory could not be resolved; bundled skill prompt metadata and skills.status entries will be unavailable.",
    ]);
  });

  it("warns once when the bundled skills directory is empty", async () => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-bundled-"));
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = bundledDir;
    const warnings: string[] = [];

    const first = resolveBundledSkillsContext({ warn: (message) => warnings.push(message) });
    const second = resolveBundledSkillsContext({ warn: (message) => warnings.push(message) });

    expect(first.dir).toBe(bundledDir);
    expect(second.dir).toBe(bundledDir);
    expect(first.names.size).toBe(0);
    expect(second.names.size).toBe(0);
    expect(warnings).toEqual([
      `Bundled skills directory resolved but no valid skills were loaded from ${bundledDir}; bundled skill prompt metadata and skills.status entries will be unavailable.`,
    ]);
  });
});
