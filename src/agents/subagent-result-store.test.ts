import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistSubagentResultSnapshot,
  readSubagentResultSnapshot,
  resetSubagentResultStoreForTests,
} from "./subagent-result-store.js";

describe("subagent result store", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-result-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    resetSubagentResultStoreForTests();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("persists an immutable reference bound to the child session", async () => {
    const resultRef = await persistSubagentResultSnapshot({
      announceId: "announce:run-1",
      sessionKey: "agent:research:child",
      result: "complete findings",
    });

    await expect(
      readSubagentResultSnapshot({ resultRef, sessionKey: "agent:research:child" }),
    ).resolves.toBe("complete findings");
    await expect(
      readSubagentResultSnapshot({ resultRef, sessionKey: "agent:research:other" }),
    ).resolves.toBeUndefined();
    await expect(
      readSubagentResultSnapshot({ resultRef: "../invalid", sessionKey: "agent:research:child" }),
    ).resolves.toBeUndefined();

    const changedResultRef = await persistSubagentResultSnapshot({
      announceId: "announce:run-1",
      sessionKey: "agent:research:child",
      result: "updated findings",
    });
    expect(changedResultRef).not.toBe(resultRef);
    await expect(
      readSubagentResultSnapshot({ resultRef, sessionKey: "agent:research:child" }),
    ).resolves.toBe("complete findings");
  });
});
