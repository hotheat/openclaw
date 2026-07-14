import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, saveSessionStore } from "./store.js";

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

describe("Windows session store writes", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  let testDir = "";

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-session-win-"));
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    clearSessionStoreCacheForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearSessionStoreCacheForTest();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  it("rejects the save when all atomic rename attempts fail", async () => {
    const renameError = Object.assign(new Error("target is locked"), { code: "EPERM" });
    const renameSpy = vi.spyOn(fs.promises, "rename").mockRejectedValue(renameError);
    const storePath = path.join(testDir, "sessions.json");

    const saving = saveSessionStore(storePath, {
      "agent:main:main": { sessionId: "session-1", updatedAt: Date.now() },
    });
    await expect(saving).rejects.toThrow(
      `failed to replace session store after 5 attempts: ${storePath}`,
    );
    expect(renameSpy).toHaveBeenCalledTimes(5);
    await expect(fs.promises.readFile(storePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
