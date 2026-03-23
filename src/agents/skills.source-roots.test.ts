import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("buildWorkspaceSkillsPrompt source roots", () => {
  let fakeHome: string;

  beforeEach(async () => {
    fakeHome = await createTempDir("openclaw-home-");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("loads only extra, bundled, and workspace skills", async () => {
    const workspaceDir = await createTempDir("openclaw-workspace-");
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedDir = path.join(workspaceDir, ".managed");

    await writeSkill({
      dir: path.join(extraDir, "extra-only"),
      name: "extra-only",
      description: "Extra only skill",
    });
    await writeSkill({
      dir: path.join(bundledDir, "bundled-only"),
      name: "bundled-only",
      description: "Bundled only skill",
    });
    await writeSkill({
      dir: path.join(managedDir, "managed-only"),
      name: "managed-only",
      description: "Managed only skill",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "personal-only"),
      name: "personal-only",
      description: "Personal only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "project-only"),
      name: "project-only",
      description: "Project only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "workspace-only"),
      name: "workspace-only",
      description: "Workspace only skill",
    });

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      config: { skills: { load: { extraDirs: [extraDir] } } },
    });

    expect(prompt).toContain("extra-only");
    expect(prompt).toContain("bundled-only");
    expect(prompt).toContain("workspace-only");
    expect(prompt).not.toContain("managed-only");
    expect(prompt).not.toContain("personal-only");
    expect(prompt).not.toContain("project-only");
  });
});
