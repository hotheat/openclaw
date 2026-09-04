import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const watchMock = vi.fn(() => ({
  on: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("chokidar", () => {
  return {
    default: { watch: watchMock },
  };
});

describe("ensureSkillsWatcher", () => {
  it("ignores node_modules, dist, .git, and Python venvs by default", async () => {
    const mod = await import("./refresh.js");
    mod.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(mod.DEFAULT_SKILLS_WATCH_IGNORED);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills", "SKILL.md")),
        posix(path.join("/tmp/workspace", "skills", "*", "SKILL.md")),
      ]),
    );
    expect(targets.every((target) => target.includes("SKILL.md"))).toBe(true);
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;

    // Node/JS paths
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/dist/index.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.git/config"))).toBe(true);

    // Python virtual environments and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/scripts/.venv/bin/python"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/venv/lib/python3.10/site.py"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/__pycache__/module.pyc"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.mypy_cache/3.10/foo.json"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.pytest_cache/v/cache"))).toBe(true);

    // Build artifacts and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/build/output.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.cache/data.json"))).toBe(true);

    // Should NOT ignore normal skill files
    expect(ignored.some((re) => re.test("/tmp/.hidden/skills/index.md"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/SKILL.md"))).toBe(false);
  });
});

describe("skillsSnapshotHasMissingFiles", () => {
  const makeSnapshot = (filePath?: string) => ({
    prompt: "",
    skills: [],
    ...(filePath === undefined
      ? {}
      : {
          resolvedSkills: [
            {
              name: "handoff",
              description: "",
              filePath,
              baseDir: path.dirname(filePath),
              source: "workspace",
              disableModelInvocation: false,
            },
          ],
        }),
  });

  it("returns false for undefined or file-less snapshots", async () => {
    const mod = await import("./refresh.js");

    expect(mod.skillsSnapshotHasMissingFiles(undefined)).toBe(false);
    expect(mod.skillsSnapshotHasMissingFiles(makeSnapshot())).toBe(false);
  });

  it("returns true when a resolved skill file no longer exists", async () => {
    const mod = await import("./refresh.js");

    const snapshot = makeSnapshot(
      path.join("/definitely-missing-skills-root", "handoff", "SKILL.md"),
    );

    expect(mod.skillsSnapshotHasMissingFiles(snapshot)).toBe(true);
  });

  it("returns false while every resolved skill file still exists", async () => {
    const mod = await import("./refresh.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-refresh-missing-"));
    try {
      const skillDir = path.join(root, "handoff");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      fs.writeFileSync(skillFile, "---\nname: handoff\ndescription: handoff skill\n---\nbody");

      expect(mod.skillsSnapshotHasMissingFiles(makeSnapshot(skillFile))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
