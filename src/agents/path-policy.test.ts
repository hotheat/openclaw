import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveSandboxInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox-paths.js", () => ({
  resolveSandboxInputPath: resolveSandboxInputPathMock,
}));

import {
  toRelativeSandboxPath,
  toRelativeWorkspacePath,
  resolvePathFromInput,
} from "./path-policy.js";

beforeEach(() => {
  resolveSandboxInputPathMock.mockReset();
  resolveSandboxInputPathMock.mockImplementation((filePath: string, cwd: string) => {
    if (
      filePath.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(filePath) ||
      filePath.startsWith("\\\\?\\")
    ) {
      return filePath;
    }
    return `${cwd}/${filePath}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace path policy", () => {
  it("accepts relative paths and dot-dot-prefixed filenames", () => {
    expect(toRelativeWorkspacePath("/workspace/root", "src/file.ts")).toBe("src/file.ts");
    expect(toRelativeWorkspacePath("/workspace/root", "/workspace/root/..file.txt")).toBe(
      "..file.txt",
    );
  });

  it("rejects the root and parent traversal unless root access is explicit", () => {
    expect(() => toRelativeWorkspacePath("/workspace/root", "/workspace/root")).toThrow(
      "Path escapes workspace root",
    );
    expect(toRelativeWorkspacePath("/workspace/root", "/workspace/root", { allowRoot: true })).toBe(
      "",
    );
    expect(() => toRelativeWorkspacePath("/workspace/root", "/workspace/root/../file.txt")).toThrow(
      "Path escapes workspace root",
    );
  });

  it("reports sandbox boundaries separately", () => {
    expect(() => toRelativeSandboxPath("/sandbox/root", "/outside/file.txt")).toThrow(
      "Path escapes sandbox root (/sandbox/root)",
    );
  });

  it("resolves relative input from cwd", () => {
    expect(resolvePathFromInput("../file.txt", "/workspace/root")).toBe("/workspace/file.txt");
  });
});

describe("workspace path policy on Windows", () => {
  it("preserves case and strips extended-length prefixes", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const root = "C:\\Users\\User\\OpenClaw";
    expect(
      toRelativeWorkspacePath(
        root,
        "\\\\?\\C:\\Users\\User\\OpenClaw\\src\\Components\\MyComponent.tsx",
      ),
    ).toBe("src\\Components\\MyComponent.tsx");
  });

  it("rejects another drive or directory", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    expect(() =>
      toRelativeWorkspacePath("C:\\Users\\User\\OpenClaw", "C:\\Users\\User\\Other\\file.txt"),
    ).toThrow("Path escapes workspace root");
  });
});
