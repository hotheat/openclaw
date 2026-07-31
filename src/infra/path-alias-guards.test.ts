import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { PATH_ALIAS_POLICIES, assertNoPathAliasEscape } from "./path-alias-guards.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("assertNoPathAliasEscape", () => {
  it.runIf(process.platform !== "win32")("rejects symlinks and hardlinks by default", async () => {
    const root = await fs.realpath(await tempDirs.make("openclaw-path-alias-"));
    const hardlinkTarget = path.join(root, "hardlink-target.txt");
    const symlink = path.join(root, "target-link.txt");
    const hardlink = path.join(root, "target-hardlink.txt");
    await fs.writeFile(hardlinkTarget, "hardlink target");
    await fs.symlink(path.join(path.dirname(root), "missing-outside.txt"), symlink);
    await fs.link(hardlinkTarget, hardlink);

    await expect(
      assertNoPathAliasEscape({
        absolutePath: symlink,
        rootPath: root,
        boundaryLabel: "sandbox root",
      }),
    ).rejects.toThrow(/symlink/i);
    await expect(
      assertNoPathAliasEscape({
        absolutePath: hardlink,
        rootPath: root,
        boundaryLabel: "sandbox root",
      }),
    ).rejects.toThrow(/hard.?link/i);
  });

  it.runIf(process.platform !== "win32")(
    "allows only the final alias for unlink-target operations",
    async () => {
      const root = await fs.realpath(await tempDirs.make("openclaw-path-alias-unlink-"));
      const target = path.join(root, "target.txt");
      const symlink = path.join(root, "target-link.txt");
      const hardlink = path.join(root, "target-hardlink.txt");
      await fs.writeFile(target, "target");
      await fs.symlink(target, symlink);
      await fs.link(target, hardlink);

      await expect(
        assertNoPathAliasEscape({
          absolutePath: symlink,
          rootPath: root,
          boundaryLabel: "sandbox root",
          policy: PATH_ALIAS_POLICIES.unlinkTarget,
        }),
      ).resolves.toBeUndefined();
      await expect(
        assertNoPathAliasEscape({
          absolutePath: hardlink,
          rootPath: root,
          boundaryLabel: "sandbox root",
          policy: PATH_ALIAS_POLICIES.unlinkTarget,
        }),
      ).resolves.toBeUndefined();
    },
  );
});
