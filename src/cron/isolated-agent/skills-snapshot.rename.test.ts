import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "../../agents/skills.e2e-test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

const tempDirs = createTrackedTempDirs();
const config = {} as OpenClawConfig;

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("resolveCronSkillsSnapshot rename invalidation", () => {
  it("rebuilds a version-0 snapshot after the workspace skill directory was renamed", async () => {
    const workspaceDir = await tempDirs.make("cron-skills-rename-");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "handoff"),
      name: "handoff",
      description: "handoff skill",
    });

    const first = resolveCronSkillsSnapshot({
      workspaceDir,
      config,
      agentId: "default",
      isFastTestEnv: false,
    });
    expect(first.resolvedSkills?.map((skill) => skill.name)).toContain("handoff");
    // Fresh process state: the in-memory watcher version is 0, mirroring a
    // restart right after the snapshot was persisted.
    expect(first.version).toBe(0);

    // Rename lands outside the file watcher (watcher down or service stopped),
    // so the snapshot version stays 0 and version comparison alone cannot see it.
    // Mirrors workspace commit f13cf1a6: the directory moves and the SKILL.md
    // frontmatter picks up the new name.
    fs.renameSync(
      path.join(workspaceDir, "skills", "handoff"),
      path.join(workspaceDir, "skills", "durable-handoff"),
    );
    fs.writeFileSync(
      path.join(workspaceDir, "skills", "durable-handoff", "SKILL.md"),
      "---\nname: durable-handoff\ndescription: handoff skill\n---\nbody",
    );

    const second = resolveCronSkillsSnapshot({
      workspaceDir,
      config,
      agentId: "default",
      existingSnapshot: first,
      isFastTestEnv: false,
    });

    expect(second).not.toBe(first);
    expect(second.resolvedSkills?.map((skill) => skill.name)).toContain("durable-handoff");
    expect(second.resolvedSkills?.map((skill) => skill.name)).not.toContain("handoff");
  });

  it("reuses the existing snapshot while all resolved files still exist", async () => {
    const workspaceDir = await tempDirs.make("cron-skills-reuse-");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "handoff"),
      name: "handoff",
      description: "handoff skill",
    });

    const first = resolveCronSkillsSnapshot({
      workspaceDir,
      config,
      agentId: "default",
      isFastTestEnv: false,
    });

    const second = resolveCronSkillsSnapshot({
      workspaceDir,
      config,
      agentId: "default",
      existingSnapshot: first,
      isFastTestEnv: false,
    });

    expect(second).toBe(first);
  });
});
