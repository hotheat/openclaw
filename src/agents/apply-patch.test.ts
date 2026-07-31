import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyPatch } from "./apply-patch.js";
import type { ContainerPathSandboxFsBridge } from "./sandbox/fs-bridge.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildAddFilePatch(targetPath: string): string {
  return `*** Begin Patch
*** Add File: ${targetPath}
+escaped
*** End Patch`;
}

async function expectOutsideWriteRejected(params: {
  dir: string;
  patchTargetPath: string;
  outsidePath: string;
}) {
  const patch = buildAddFilePatch(params.patchTargetPath);
  await expect(applyPatch(patch, { cwd: params.dir })).rejects.toThrow(/Path escapes sandbox root/);
  await expect(fs.readFile(params.outsidePath, "utf8")).rejects.toBeDefined();
}

function createMemorySandbox(initialFiles: Record<string, string> = {}) {
  const files = new Map(
    Object.entries(initialFiles).map(([filePath, contents]) => [`/sandbox/${filePath}`, contents]),
  );
  const bridge = {
    resolvePath: ({ filePath }: { filePath: string }) => ({
      relativePath: filePath,
      containerPath: `/sandbox/${filePath}`,
    }),
    readFile: vi.fn(async ({ filePath }: { filePath: string }) =>
      Buffer.from(files.get(filePath) ?? "", "utf8"),
    ),
    writeFile: vi.fn(async ({ filePath, data }: { filePath: string; data: Buffer | string }) => {
      files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
    }),
    remove: vi.fn(async ({ filePath }: { filePath: string }) => {
      files.delete(filePath);
    }),
    mkdirp: vi.fn(async () => {}),
    rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const contents = files.get(from);
      if (contents !== undefined) {
        files.set(to, contents);
        files.delete(from);
      }
    }),
    stat: vi.fn(async ({ filePath }: { filePath: string }) => {
      const contents = files.get(filePath);
      return contents === undefined
        ? null
        : { type: "file" as const, size: Buffer.byteLength(contents), mtimeMs: 0 };
    }),
  } satisfies ContainerPathSandboxFsBridge;
  return { files, bridge };
}

describe("applyPatch", () => {
  it("adds a file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(path.join(dir, "hello.txt"), "utf8");

      expect(contents).toBe("hello\n");
      expect(result.summary.added).toEqual(["hello.txt"]);
    });
  });

  it("accepts in-workspace names that start with two dots", async () => {
    await withTempDir(async (dir) => {
      const patch = buildAddFilePatch("..notes.txt");

      await expect(applyPatch(patch, { cwd: dir })).resolves.toMatchObject({
        summary: { added: ["..notes.txt"] },
      });
      await expect(fs.readFile(path.join(dir, "..notes.txt"), "utf8")).resolves.toBe("escaped\n");
    });
  });

  it("updates and moves a file", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "source.txt");
      await fs.writeFile(source, "foo\nbar\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const dest = path.join(dir, "dest.txt");
      const contents = await fs.readFile(dest, "utf8");

      expect(contents).toBe("foo\nbaz\n");
      await expect(fs.stat(source)).rejects.toBeDefined();
      expect(result.summary.modified).toEqual(["dest.txt"]);
    });
  });

  it("updates in place when the move target resolves to the source", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "source.txt");
      await fs.writeFile(source, "foo\nbar\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ./source.txt
@@
 foo
-bar
+baz
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });

      await expect(fs.readFile(source, "utf8")).resolves.toBe("foo\nbaz\n");
      expect(result.summary.modified).toEqual(["source.txt"]);
    });
  });

  it("preserves case-only moves on case-insensitive filesystems", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "Source.txt");
      const target = path.join(dir, "source.txt");
      await fs.writeFile(source, "before\n", "utf8");
      const targetAliasesSource = await fs
        .stat(target)
        .then(() => true)
        .catch(() => false);
      if (!targetAliasesSource) {
        return;
      }

      const patch = `*** Begin Patch
*** Update File: Source.txt
*** Move to: source.txt
@@
-before
+after
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });

      await expect(fs.readFile(target, "utf8")).resolves.toBe("after\n");
      expect(await fs.readdir(dir)).toEqual(["source.txt"]);
      expect(result.summary.modified).toEqual(["source.txt"]);
    });
  });

  it("does not rewrite no-op hunks and omits no-op files from mixed summaries", async () => {
    await withTempDir(async (dir) => {
      const unchanged = path.join(dir, "unchanged.txt");
      const changed = path.join(dir, "changed.txt");
      await fs.writeFile(unchanged, "foo\r\nbar\r\n", "utf8");
      await fs.writeFile(changed, "before\n", "utf8");
      const before = await fs.stat(unchanged);
      const patch = `*** Begin Patch
*** Update File: unchanged.txt
@@
 foo
-bar
+bar
*** Update File: changed.txt
@@
-before
+after
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const after = await fs.stat(unchanged);

      expect(result.noOp).toBeUndefined();
      expect(result.summary).toEqual({ added: [], modified: ["changed.txt"], deleted: [] });
      expect(result.text).not.toContain("unchanged.txt");
      await expect(fs.readFile(unchanged, "utf8")).resolves.toBe("foo\r\nbar\r\n");
      await expect(fs.readFile(changed, "utf8")).resolves.toBe("after\n");
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  });

  it("returns a no-op result without terminate and preserves EOF state", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "source.txt");
      await fs.writeFile(target, "foo\nbar", "utf8");
      const before = await fs.stat(target);
      const patch = `*** Begin Patch
*** Update File: source.txt
@@
 foo
-bar
+bar
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const after = await fs.stat(target);

      expect(result.noOp).toBe(true);
      expect(result.text).toBe("No changes made to source.txt.");
      expect(result).not.toHaveProperty("terminate");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("foo\nbar");
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  });

  it("applies context-only insertions using original coordinates", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "source.txt");
      await fs.writeFile(target, "a\nb\nc\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: source.txt
@@ a
+after-a
@@ b
+after-b
*** End Patch`;

      await applyPatch(patch, { cwd: dir });

      await expect(fs.readFile(target, "utf8")).resolves.toBe("a\nafter-a\nb\nafter-b\nc\n");
    });
  });

  it("normalizes generated punctuation while matching update hunks", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "source.txt");
      await fs.writeFile(target, "a\u2014b\u2019c\u00A0d\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: source.txt
@@
-a-b'c d
+updated
*** End Patch`;

      await applyPatch(patch, { cwd: dir });

      await expect(fs.readFile(target, "utf8")).resolves.toBe("updated\n");
    });
  });

  it("supports end-of-file inserts", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "end.txt");
      await fs.writeFile(target, "line1\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`;

      await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("line1\nline2\n");
    });
  });

  it("deletes regular files", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "delete.txt");
      await fs.writeFile(target, "delete\n", "utf8");
      const patch = `*** Begin Patch
*** Delete File: delete.txt
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });

      expect(result.summary.deleted).toEqual(["delete.txt"]);
      await expect(fs.lstat(target)).rejects.toBeDefined();
    });
  });

  it("rejects path traversal outside cwd by default", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      try {
        await expectOutsideWriteRejected({
          dir,
          patchTargetPath: relativeEscape,
          outsidePath: escapedPath,
        });
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("rejects absolute paths outside cwd by default", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(os.tmpdir(), `openclaw-apply-patch-${Date.now()}.txt`);

      try {
        await expectOutsideWriteRejected({
          dir,
          patchTargetPath: escapedPath,
          outsidePath: escapedPath,
        });
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("allows absolute paths within cwd by default", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "nested", "inside.txt");
      const patch = `*** Begin Patch
*** Add File: ${target}
+inside
*** End Patch`;

      await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("inside\n");
    });
  });

  it("rejects symlink escape attempts by default", async () => {
    await withTempDir(async (dir) => {
      const outside = path.join(path.dirname(dir), "outside-target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(outside, "initial\n", "utf8");
      await fs.symlink(outside, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+pwned
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Symlink escapes sandbox root/);
      const outsideContents = await fs.readFile(outside, "utf8");
      expect(outsideContents).toBe("initial\n");
      await fs.rm(outside, { force: true });
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects broken symlinks and hardlink aliases by default",
    async () => {
      await withTempDir(async (dir) => {
        const outsideDir = await fs.mkdtemp(
          path.join(path.dirname(dir), "openclaw-patch-outside-"),
        );
        try {
          const outsideTarget = path.join(outsideDir, "target.txt");
          const brokenLink = path.join(dir, "broken.txt");
          const hardlink = path.join(dir, "hardlink.txt");
          await fs.writeFile(outsideTarget, "initial\n", "utf8");
          await fs.symlink(path.join(outsideDir, "missing.txt"), brokenLink);
          await fs.link(outsideTarget, hardlink);

          const update = (target: string) => `*** Begin Patch
*** Update File: ${target}
@@
-initial
+changed
*** End Patch`;

          await expect(applyPatch(update("broken.txt"), { cwd: dir })).rejects.toThrow(/symlink/i);
          await expect(applyPatch(update("hardlink.txt"), { cwd: dir })).rejects.toThrow(
            /hard.?link/i,
          );
          await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("initial\n");
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    },
  );

  it("rejects symlinks that resolve within cwd by default", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "target.txt");
      const linkPath = path.join(dir, "link.txt");
      await fs.writeFile(target, "initial\n", "utf8");
      await fs.symlink(target, linkPath);

      const patch = `*** Begin Patch
*** Update File: link.txt
@@
-initial
+updated
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/symlink/i);
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("initial\n");
    });
  });

  it("rejects delete path traversal via symlink directories by default", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = path.join(path.dirname(dir), `outside-dir-${process.pid}-${Date.now()}`);
      const outsideFile = path.join(outsideDir, "victim.txt");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(outsideFile, "victim\n", "utf8");

      const linkDir = path.join(dir, "linkdir");
      await fs.symlink(outsideDir, linkDir);

      const patch = `*** Begin Patch
*** Delete File: linkdir/victim.txt
*** End Patch`;

      try {
        await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
          /Symlink escapes sandbox root/,
        );
        const stillThere = await fs.readFile(outsideFile, "utf8");
        expect(stillThere).toBe("victim\n");
      } finally {
        await fs.rm(outsideFile, { force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects add and move targets whose parent is a symlink",
    async () => {
      await withTempDir(async (dir) => {
        const outsideDir = await fs.mkdtemp(
          path.join(path.dirname(dir), "openclaw-patch-outside-"),
        );
        try {
          await fs.symlink(outsideDir, path.join(dir, "link"));
          await fs.writeFile(path.join(dir, "source.txt"), "before\n", "utf8");

          const addPatch = `*** Begin Patch
*** Add File: link/added.txt
+unsafe
*** End Patch`;
          const movePatch = `*** Begin Patch
*** Update File: source.txt
*** Move to: link/moved.txt
@@
-before
+after
*** End Patch`;

          await expect(applyPatch(addPatch, { cwd: dir })).rejects.toThrow(/alias|symlink/i);
          await expect(applyPatch(movePatch, { cwd: dir })).rejects.toThrow(/alias|symlink/i);
          await expect(fs.readFile(path.join(dir, "source.txt"), "utf8")).resolves.toBe("before\n");
          await expect(fs.lstat(path.join(outsideDir, "added.txt"))).rejects.toBeDefined();
          await expect(fs.lstat(path.join(outsideDir, "moved.txt"))).rejects.toBeDefined();
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    },
  );

  it("allows path traversal when workspaceOnly is explicitly disabled", async () => {
    await withTempDir(async (dir) => {
      const escapedPath = path.join(
        path.dirname(dir),
        `escaped-allow-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      const relativeEscape = path.relative(dir, escapedPath);

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      try {
        const result = await applyPatch(patch, { cwd: dir, workspaceOnly: false });
        expect(result.summary.added.length).toBe(1);
        const contents = await fs.readFile(escapedPath, "utf8");
        expect(contents).toBe("escaped\n");
      } finally {
        await fs.rm(escapedPath, { force: true });
      }
    });
  });

  it("allows deleting a symlink itself even if it points outside cwd", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(path.dirname(dir), "openclaw-patch-outside-"));
      try {
        const outsideTarget = path.join(outsideDir, "target.txt");
        await fs.writeFile(outsideTarget, "keep\n", "utf8");

        const linkDir = path.join(dir, "link");
        await fs.symlink(outsideDir, linkDir);

        const patch = `*** Begin Patch
*** Delete File: link
*** End Patch`;

        const result = await applyPatch(patch, { cwd: dir });
        expect(result.summary.deleted).toEqual(["link"]);
        await expect(fs.lstat(linkDir)).rejects.toBeDefined();
        const outsideContents = await fs.readFile(outsideTarget, "utf8");
        expect(outsideContents).toBe("keep\n");
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("uses container paths when the sandbox bridge has no host path", async () => {
    const memory = createMemorySandbox({ "source.txt": "before\n" });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-before
+after
*** End Patch`;

    const result = await applyPatch(patch, {
      cwd: "/local/workspace",
      sandbox: {
        root: "/local/workspace",
        bridge: memory.bridge,
      },
    });

    expect(memory.files.get("/sandbox/source.txt")).toBe("after\n");
    expect(result.summary.modified).toEqual(["source.txt"]);
  });

  it("rejects sandbox host paths outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const outside = path.join(path.dirname(dir), "outside.txt");
      const memory = createMemorySandbox();
      memory.bridge.resolvePath = vi.fn(() => ({
        hostPath: outside,
        relativePath: "outside.txt",
        containerPath: "/sandbox/outside.txt",
      }));
      const patch = buildAddFilePatch("outside.txt");

      await expect(
        applyPatch(patch, {
          cwd: dir,
          sandbox: { root: dir, bridge: memory.bridge },
        }),
      ).rejects.toThrow(/Path escapes sandbox root/);
      expect(memory.bridge.writeFile).not.toHaveBeenCalled();
    });
  });

  it("aborts before work and between patch hunks", async () => {
    await withTempDir(async (dir) => {
      const before = new AbortController();
      before.abort();
      await expect(
        applyPatch(buildAddFilePatch("before.txt"), {
          cwd: dir,
          signal: before.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    const between = new AbortController();
    const memory = createMemorySandbox();
    memory.bridge.writeFile.mockImplementationOnce(
      async ({ filePath, data }: { filePath: string; data: Buffer | string }) => {
        memory.files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
        between.abort();
      },
    );
    const patch = `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: second.txt
+second
*** End Patch`;

    await expect(
      applyPatch(patch, {
        cwd: "/local/workspace",
        sandbox: { root: "/local/workspace", bridge: memory.bridge as never },
        signal: between.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(memory.files.has("/sandbox/first.txt")).toBe(true);
    expect(memory.files.has("/sandbox/second.txt")).toBe(false);
  });
});
