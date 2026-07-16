import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetControlUiConfigCompatWarningsForTesting } from "../control-ui-config-compat.js";
import {
  clearSessionStoreCacheForTest,
  evaluateSessionFreshness,
  loadSessionStore,
  resolveAndPersistSessionFile,
  updateSessionStore,
} from "../sessions.js";
import type { SessionConfig } from "../types.base.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
  validateSessionId,
} from "./paths.js";
import { resolveChannelResetConfig, resolveSessionResetPolicy } from "./reset.js";
import { appendAssistantMessageToSessionTranscript } from "./transcript.js";
import type { SessionEntry } from "./types.js";

function useTempSessionsFixture(prefix: string) {
  let tempDir = "";
  let storePath = "";
  let sessionsDir = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return {
    storePath: () => storePath,
    sessionsDir: () => sessionsDir,
  };
}

describe("session path safety", () => {
  it("rejects unsafe session IDs", () => {
    const unsafeSessionIds = ["../etc/passwd", "a/b", "a\\b", "/abs"];
    for (const sessionId of unsafeSessionIds) {
      expect(() => validateSessionId(sessionId), sessionId).toThrow(/Invalid session ID/);
    }
  });

  it("resolves transcript path inside an explicit sessions dir", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";
    const resolved = resolveSessionTranscriptPathInDir("sess-1", sessionsDir, "topic/a+b");

    expect(resolved).toBe(path.resolve(sessionsDir, "sess-1-topic-topic%2Fa%2Bb.jsonl"));
  });

  it("rejects absolute sessionFile paths outside known agent sessions dirs", () => {
    const sessionsDir = "/tmp/openclaw/agents/main/sessions";

    expect(() =>
      resolveSessionFilePath(
        "sess-1",
        { sessionFile: "/tmp/openclaw/agents/work/not-sessions/abc-123.jsonl" },
        { sessionsDir },
      ),
    ).toThrow(/within sessions directory/);
  });
});

describe("resolveSessionResetPolicy", () => {
  describe("backward compatibility: resetByType.dm -> direct", () => {
    it("does not use dm fallback for group/thread types", () => {
      const sessionCfg = {
        resetByType: {
          dm: { mode: "idle" as const, idleMinutes: 45 },
        },
      } as unknown as SessionConfig;

      const groupPolicy = resolveSessionResetPolicy({
        sessionCfg,
        resetType: "group",
      });

      expect(groupPolicy.mode).toBe("daily");
      expect(groupPolicy.explicit).toBe(false);
    });
  });

  it("resolves weekly reset weekday from config", () => {
    const sessionCfg = {
      reset: { mode: "weekly", weekday: 1, atHour: 4 },
    } as unknown as SessionConfig;

    const policy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });

    expect(policy.mode).toBe("weekly");
    expect(policy.weekday).toBe(1);
    expect(policy.atHour).toBe(4);
  });
});

describe("resolveChannelResetConfig", () => {
  beforeEach(() => {
    resetControlUiConfigCompatWarningsForTesting();
  });

  it("prefers an explicit control-ui reset over the legacy webchat reset", () => {
    const controlUiReset = { mode: "idle" as const, idleMinutes: 30 };
    const legacyReset = { mode: "daily" as const, atHour: 6 };

    expect(
      resolveChannelResetConfig({
        sessionCfg: {
          resetByChannel: { "control-ui": controlUiReset, webchat: legacyReset },
        },
        channel: "control-ui",
      }),
    ).toBe(controlUiReset);
  });

  it("falls back to the legacy webchat reset and emits a migration warning", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const legacyReset = { mode: "idle" as const, idleMinutes: 45 };

    expect(
      resolveChannelResetConfig({
        sessionCfg: { resetByChannel: { webchat: legacyReset } },
        channel: "control-ui",
      }),
    ).toBe(legacyReset);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("session.resetByChannel.control-ui"),
      expect.objectContaining({ code: "OPENCLAW_CONTROL_UI_LEGACY_WEBCHAT_CONFIG" }),
    );
    emitWarning.mockRestore();
  });

  it("keeps unrelated channel reset lookup unchanged", () => {
    const discordReset = { mode: "weekly" as const, weekday: 1, atHour: 4 };

    expect(
      resolveChannelResetConfig({
        sessionCfg: { resetByChannel: { discord: discordReset } },
        channel: " Discord ",
      }),
    ).toBe(discordReset);
  });
});

describe("evaluateSessionFreshness", () => {
  it("reports staleReason=daily when daily boundary invalidates the session", () => {
    const now = new Date(2026, 0, 18, 5, 0, 0).getTime();
    const updatedAt = new Date(2026, 0, 18, 3, 0, 0).getTime();

    const result = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: { mode: "daily", weekday: 1, atHour: 4, explicit: true },
    });

    expect(result.fresh).toBe(false);
    expect(result.staleReason).toBe("daily");
  });

  it("reports staleReason=idle when idle timeout invalidates the session", () => {
    const updatedAt = new Date(2026, 0, 18, 4, 0, 0).getTime();
    const now = new Date(2026, 0, 18, 5, 1, 0).getTime();

    const result = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: { mode: "idle", weekday: 1, atHour: 4, idleMinutes: 60, explicit: true },
    });

    expect(result.fresh).toBe(false);
    expect(result.staleReason).toBe("idle");
  });

  it("prefers staleReason=idle when daily mode also has idleMinutes and idle expires first", () => {
    const updatedAt = new Date(2026, 0, 18, 4, 0, 0).getTime();
    const now = new Date(2026, 0, 18, 6, 1, 0).getTime();

    const result = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: { mode: "daily", weekday: 1, atHour: 23, idleMinutes: 60, explicit: true },
    });

    expect(result.fresh).toBe(false);
    expect(result.staleReason).toBe("idle");
  });

  it("reports staleReason=weekly after the configured weekly boundary", () => {
    const now = new Date(2026, 0, 19, 5, 0, 0).getTime(); // Monday
    const updatedAt = new Date(2026, 0, 18, 5, 0, 0).getTime(); // Sunday

    const result = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: { mode: "weekly", weekday: 1, atHour: 4, explicit: true },
    });

    expect(result.fresh).toBe(false);
    expect(result.staleReason).toBe("weekly");
    expect(result.weeklyResetAt).toBe(new Date(2026, 0, 19, 4, 0, 0).getTime());
  });

  it("keeps weekly sessions fresh before the configured weekly boundary", () => {
    const now = new Date(2026, 0, 19, 3, 59, 0).getTime(); // Monday before 04:00
    const updatedAt = new Date(2026, 0, 18, 5, 0, 0).getTime(); // Sunday

    const result = evaluateSessionFreshness({
      updatedAt,
      now,
      policy: { mode: "weekly", weekday: 1, atHour: 4, explicit: true },
    });

    expect(result.fresh).toBe(true);
    expect(result.weeklyResetAt).toBe(new Date(2026, 0, 12, 4, 0, 0).getTime());
  });
});

describe("session store lock (Promise chain mutex)", () => {
  let lockFixtureRoot = "";
  let lockCaseId = 0;
  let lockTmpDirs: string[] = [];

  async function makeTmpStore(
    initial: Record<string, unknown> = {},
  ): Promise<{ dir: string; storePath: string }> {
    const dir = path.join(lockFixtureRoot, `case-${lockCaseId++}`);
    await fsPromises.mkdir(dir);
    lockTmpDirs.push(dir);
    const storePath = path.join(dir, "sessions.json");
    if (Object.keys(initial).length > 0) {
      await fsPromises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf-8");
    }
    return { dir, storePath };
  }

  beforeAll(async () => {
    lockFixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-lock-test-"));
  });

  afterAll(async () => {
    if (lockFixtureRoot) {
      await fsPromises.rm(lockFixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    lockTmpDirs = [];
  });

  it("serializes concurrent updateSessionStore calls without data loss", async () => {
    const key = "agent:main:test";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100, counter: 0 },
    });

    const N = 4;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateSessionStore(storePath, async (store) => {
          const entry = store[key] as Record<string, unknown>;
          await Promise.resolve();
          entry.counter = (entry.counter as number) + 1;
          entry.tag = `writer-${i}`;
        }),
      ),
    );

    const store = loadSessionStore(storePath);
    expect((store[key] as Record<string, unknown>).counter).toBe(N);
  });

  it("multiple consecutive errors do not permanently poison the queue", async () => {
    const key = "agent:main:multi-err";
    const { storePath } = await makeTmpStore({
      [key]: { sessionId: "s1", updatedAt: 100 },
    });

    const errors = Array.from({ length: 3 }, (_, i) =>
      updateSessionStore(storePath, async () => {
        throw new Error(`fail-${i}`);
      }),
    );

    const success = updateSessionStore(storePath, async (store) => {
      store[key] = { ...store[key], modelOverride: "recovered" } as unknown as SessionEntry;
    });

    for (const p of errors) {
      await expect(p).rejects.toThrow();
    }
    await success;

    const store = loadSessionStore(storePath);
    expect(store[key]?.modelOverride).toBe("recovered");
  });
});

describe("appendAssistantMessageToSessionTranscript", () => {
  const fixture = useTempSessionsFixture("transcript-test-");

  it("creates transcript file and appends message for valid session", async () => {
    const sessionId = "test-session-id";
    const sessionKey = "test-session";
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });
});

describe("resolveAndPersistSessionFile", () => {
  const fixture = useTempSessionsFixture("session-file-test-");

  it("persists fallback topic transcript paths for sessions without sessionFile", async () => {
    const sessionId = "topic-session-id";
    const sessionKey = "agent:main:telegram:group:123:topic:456";
    const store = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(
      sessionId,
      fixture.sessionsDir(),
      456,
    );

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      sessionEntry: sessionStore[sessionKey],
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);

    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });

  it("creates and persists entry when session is not yet present", async () => {
    const sessionId = "new-session-id";
    const sessionKey = "agent:main:telegram:group:123";
    fs.writeFileSync(fixture.storePath(), JSON.stringify({}), "utf-8");
    const sessionStore = loadSessionStore(fixture.storePath(), { skipCache: true });
    const fallbackSessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());

    const result = await resolveAndPersistSessionFile({
      sessionId,
      sessionKey,
      sessionStore,
      storePath: fixture.storePath(),
      fallbackSessionFile,
    });

    expect(result.sessionFile).toBe(fallbackSessionFile);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
    const saved = loadSessionStore(fixture.storePath(), { skipCache: true });
    expect(saved[sessionKey]?.sessionFile).toBe(fallbackSessionFile);
  });
});
