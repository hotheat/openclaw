import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { FsSafeError, readLocalFileSafely, root } from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("fs-safe facade", () => {
  it("reads local files and preserves direct-read error codes", async () => {
    const dir = await fs.realpath(await tempDirs.make("openclaw-fs-safe-"));
    const file = path.join(dir, "payload.txt");
    await fs.writeFile(file, "hello");

    const result = await readLocalFileSafely({ filePath: file });
    expect(result.buffer.toString("utf8")).toBe("hello");
    expect(result.stat.size).toBe(5);

    await expect(readLocalFileSafely({ filePath: dir })).rejects.toMatchObject({
      code: "not-file",
    });
    await expect(readLocalFileSafely({ filePath: file, maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(
      readLocalFileSafely({ filePath: path.join(dir, "missing.txt") }),
    ).rejects.toBeInstanceOf(FsSafeError);
    await expect(
      readLocalFileSafely({ filePath: path.join(dir, "missing.txt") }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it.runIf(process.platform !== "win32")(
    "preserves rooted symlink, alias, directory, size, and missing-path codes",
    async () => {
      const workspace = await fs.realpath(await tempDirs.make("openclaw-fs-safe-root-"));
      const outside = await fs.realpath(await tempDirs.make("openclaw-fs-safe-outside-"));
      const file = path.join(workspace, "payload.txt");
      const outsideFile = path.join(outside, "outside.txt");
      await fs.writeFile(file, "hello");
      await fs.writeFile(outsideFile, "outside");
      await fs.symlink(file, path.join(workspace, "final-link"));
      await fs.symlink(outside, path.join(workspace, "parent-link"));

      const fsRoot = await root(workspace);
      await expect(fsRoot.open("final-link")).rejects.toMatchObject({ code: "symlink" });
      await expect(fsRoot.open("parent-link/outside.txt")).rejects.toMatchObject({
        code: "outside-workspace",
      });
      await expect(fsRoot.open(".")).rejects.toMatchObject({ code: "not-file" });
      await expect(fsRoot.read("payload.txt", { maxBytes: 4 })).rejects.toMatchObject({
        code: "too-large",
      });
      await expect(fsRoot.open("missing.txt")).rejects.toMatchObject({ code: "not-found" });
      await expect(
        fsRoot.open(path.join("..", path.basename(outside), "outside.txt")),
      ).rejects.toMatchObject({ code: "outside-workspace" });
    },
  );
});
