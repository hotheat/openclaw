import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  getSessionStoreOwnershipAbortSignal,
  loadSessionStore,
  runWithSessionStoreOwnership,
  saveSessionStore,
  setSessionStoreOwnership,
  updateSessionStore,
} from "../../config/sessions.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { prependSystemEvents } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { initSessionState, persistRecentMediaSnapshotEarly } from "./session.js";

const sessionFilePersistGate = vi.hoisted(() => ({
  wait: undefined as
    | ((params: {
        sessionEntry?: {
          heartbeatLease?: { runId: string };
          heartbeatOnly?: { runId: string };
        };
      }) => Promise<void>)
    | undefined,
}));

const sessionStoreLoadGate = vi.hoisted(() => ({
  afterLoad: undefined as
    | ((params: { storePath: string; store: Record<string, SessionEntry> }) => void)
    | undefined,
}));

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (...args: Parameters<typeof actual.loadSessionStore>) => {
      const store = actual.loadSessionStore(...args);
      sessionStoreLoadGate.afterLoad?.({ storePath: args[0], store });
      return store;
    },
    resolveAndPersistSessionFile: async (
      ...args: Parameters<typeof actual.resolveAndPersistSessionFile>
    ) => {
      const result = await actual.resolveAndPersistSessionFile(...args);
      await sessionFilePersistGate.wait?.(args[0]);
      return result;
    },
  };
});

// Perf: session-store locks are exercised elsewhere; most session tests don't need FS lock files.
vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.1", name: "M2.1" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(async ({ prompt }: { prompt?: string }) => {
    if (typeof prompt === "string" && prompt.includes("Return strict JSON with this shape")) {
      return {
        payloads: [
          {
            text: JSON.stringify(
              {
                operations: [
                  {
                    op: "merge",
                    targetFactId: "fact_behavior_pref",
                    canonicalContent: "偏好基于官方文档和源码做判断",
                    confidence: 0.9,
                    reason: "新事实是对既有行为偏好的更完整重述，适合并入原事实。",
                  },
                ],
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    if (typeof prompt === "string" && prompt.includes("Return strict JSON matching this shape")) {
      return {
        payloads: [
          {
            text: JSON.stringify(
              {
                user: {
                  workContext: {
                    summary: "长期负责 OpenClaw 记忆与 session reset 机制。",
                    shouldUpdate: true,
                  },
                  personalContext: {
                    summary: "",
                    shouldUpdate: false,
                  },
                  topOfMind: {
                    summary: "当前在收敛 daily rollover 与长期记忆同步方案。",
                    shouldUpdate: true,
                  },
                },
                history: {
                  recentMonths: {
                    summary: "最近持续维护 builtin memory、rollover 和 PG 存储。",
                    shouldUpdate: true,
                  },
                  earlierContext: {
                    summary: "",
                    shouldUpdate: false,
                  },
                  longTermBackground: {
                    summary: "长期本地部署并调试 OpenClaw gateway。",
                    shouldUpdate: true,
                  },
                },
                newFacts: [
                  {
                    content: "偏好基于官方文档和源码做判断。",
                    category: "behavior",
                    confidence: 0.86,
                  },
                  {
                    content: "当前目标是让 daily rollover 自动更新长期记忆。",
                    category: "goal",
                    confidence: 0.9,
                  },
                ],
                factsToRemove: [],
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    return {
      payloads: [
        {
          text: [
            "## Daily Structured Summary",
            "",
            "- **Generated At**: 2026-01-18 05:00 UTC",
            "- **Source**: daily-rollover",
            "- **Source Sessions**: daily-session-id",
            "",
            "### 最终结论",
            "- 已用 daily structured summary 替代 transcript capture。",
            "",
            "### 已验证有效的方法",
            "- 需要剂量可追溯，并保留来源核对。",
            "",
            "### 稳定约束 / 用户偏好 / 重要决策",
            "- 偏好官方资料。",
            "- 官方未披露时要标未披露。",
            "- 用 daily structured summary 替代 transcript capture。",
            "",
            "### 待继续事项",
            "- 继续核对剂量来源。",
            "",
            "### 稳定失败教训",
            "- 不接受推断剂量。",
          ].join("\n"),
        },
      ],
    };
  }),
}));

let suiteRoot = "";
let suiteCase = 0;

afterEach(() => {
  sessionFilePersistGate.wait = undefined;
  sessionStoreLoadGate.afterLoad = undefined;
});

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

const createStorePath = makeStorePath;

describe("initSessionState heartbeat-only visibility", () => {
  it("marks heartbeat-created sessions until real inbound traffic claims them", async () => {
    const storePath = await createStorePath("openclaw-session-heartbeat-only-");
    const sessionKey = "agent:main:main";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const heartbeat = await initSessionState({
      ctx: {
        Body: "heartbeat",
        SessionKey: sessionKey,
        OriginatingChannel: "internal",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
      isHeartbeat: true,
    });
    expect(heartbeat.sessionEntry.heartbeatOnly?.runId).toBeTruthy();
    expect(heartbeat.sessionEntry.heartbeatLease?.runId).toBe(
      heartbeat.sessionEntry.heartbeatOnly?.runId,
    );
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]?.heartbeatOnly?.runId).toBe(
      heartbeat.sessionEntry.heartbeatOnly?.runId,
    );

    const claimed = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "feishu",
        From: "ou_user",
        To: "bot",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(claimed.sessionEntry.heartbeatOnly).toBeUndefined();
    expect(claimed.sessionEntry.heartbeatLease).toBeUndefined();
    expect(
      loadSessionStore(storePath, { skipCache: true })[sessionKey]?.heartbeatOnly,
    ).toBeUndefined();
    expect(
      loadSessionStore(storePath, { skipCache: true })[sessionKey]?.heartbeatLease,
    ).toBeUndefined();
  });

  it("does not restore heartbeat ownership after real inbound traffic claims the session", async () => {
    const storePath = await createStorePath("openclaw-session-heartbeat-race-");
    const sessionKey = "agent:main:main";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    let releaseHeartbeat!: () => void;
    let signalHeartbeatClaimed!: (entry: SessionEntry) => void;
    const heartbeatClaimed = new Promise<SessionEntry>((resolve) => {
      signalHeartbeatClaimed = resolve;
    });
    const continueHeartbeat = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let shouldPauseHeartbeat = true;
    sessionFilePersistGate.wait = async ({ sessionEntry }) => {
      if (!shouldPauseHeartbeat || !sessionEntry?.heartbeatOnly) {
        return;
      }
      shouldPauseHeartbeat = false;
      signalHeartbeatClaimed(sessionEntry as SessionEntry);
      await continueHeartbeat;
    };

    const staleHeartbeat = initSessionState({
      ctx: {
        Body: "heartbeat",
        SessionKey: sessionKey,
        OriginatingChannel: "internal",
        From: "heartbeat",
        To: "heartbeat",
      },
      cfg,
      commandAuthorized: true,
      isHeartbeat: true,
    });
    const claimedEntry = await heartbeatClaimed;

    const user = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "feishu",
        From: "ou_user",
        To: "bot",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(user.sessionId).toBe(claimedEntry.sessionId);
    expect(user.sessionEntry.heartbeatOnly).toBeUndefined();
    expect(user.sessionEntry.heartbeatLease).toBeUndefined();

    releaseHeartbeat();
    await expect(staleHeartbeat).rejects.toThrow("heartbeat session ownership changed");

    const finalEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(finalEntry?.sessionId).toBe(user.sessionId);
    expect(finalEntry?.heartbeatOnly).toBeUndefined();
    expect(finalEntry?.heartbeatLease).toBeUndefined();
    expect(finalEntry?.origin?.provider).toBe("feishu");
  });

  it("does not overwrite an existing real session claimed with the same session id", async () => {
    const storePath = await createStorePath("openclaw-session-heartbeat-real-race-");
    const sessionKey = "agent:main:main";
    const sessionId = "existing-user-session";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "old-user",
        origin: { provider: "telegram", from: "old-user", to: "bot" },
      },
    });

    let releaseHeartbeat!: () => void;
    let signalHeartbeatLeased!: (entry: SessionEntry) => void;
    const heartbeatLeased = new Promise<SessionEntry>((resolve) => {
      signalHeartbeatLeased = resolve;
    });
    const continueHeartbeat = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let shouldPauseHeartbeat = true;
    let heartbeatAbortSignal: AbortSignal | undefined;
    sessionFilePersistGate.wait = async ({ sessionEntry }) => {
      if (!shouldPauseHeartbeat || !sessionEntry?.heartbeatLease || sessionEntry.heartbeatOnly) {
        return;
      }
      shouldPauseHeartbeat = false;
      signalHeartbeatLeased(sessionEntry as SessionEntry);
      await continueHeartbeat;
    };

    const staleHeartbeat = runWithSessionStoreOwnership(async () => {
      heartbeatAbortSignal = getSessionStoreOwnershipAbortSignal();
      return await initSessionState({
        ctx: {
          Body: "heartbeat",
          SessionKey: sessionKey,
          OriginatingChannel: "internal",
          From: "heartbeat",
          To: "heartbeat",
        },
        cfg,
        commandAuthorized: true,
        isHeartbeat: true,
      });
    });
    const leasedEntry = await heartbeatLeased;
    expect(leasedEntry.sessionId).toBe(sessionId);
    expect(leasedEntry.heartbeatOnly).toBeUndefined();
    expect(heartbeatAbortSignal?.aborted).toBe(false);

    const user = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "feishu",
        From: "ou_user",
        To: "bot",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(user.sessionId).toBe(sessionId);
    expect(user.sessionEntry.heartbeatLease).toBeUndefined();
    expect(heartbeatAbortSignal?.aborted).toBe(true);
    const abortReason = heartbeatAbortSignal?.reason;
    expect(abortReason).toBeInstanceOf(Error);
    expect((abortReason as Error).message).toBe("heartbeat session ownership changed");

    releaseHeartbeat();
    await expect(staleHeartbeat).rejects.toThrow("heartbeat session ownership changed");

    const finalEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(finalEntry?.sessionId).toBe(sessionId);
    expect(finalEntry?.heartbeatLease).toBeUndefined();
    expect(finalEntry?.heartbeatOnly).toBeUndefined();
    expect(finalEntry?.lastChannel).toBe("feishu");
    expect(finalEntry?.lastTo).toBe("bot");
    expect(finalEntry?.origin?.provider).toBe("feishu");
  });

  it("revokes a heartbeat lease created after the user reads the session store", async () => {
    const storePath = await createStorePath("openclaw-session-heartbeat-stale-snapshot-");
    const sessionKey = "agent:main:main";
    const sessionId = "existing-user-session";
    const runId = "late-heartbeat-run";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "old-user",
        origin: { provider: "telegram", from: "old-user", to: "bot" },
      },
    });

    let heartbeatAbortSignal: AbortSignal | undefined;
    let staleHeartbeat: Promise<void> | undefined;
    sessionStoreLoadGate.afterLoad = ({ storePath: loadedStorePath, store }) => {
      if (loadedStorePath !== storePath || store[sessionKey]?.heartbeatLease) {
        return;
      }
      sessionStoreLoadGate.afterLoad = undefined;
      const currentStore = JSON.parse(fsSync.readFileSync(storePath, "utf-8")) as Record<
        string,
        SessionEntry
      >;
      currentStore[sessionKey] = {
        ...currentStore[sessionKey],
        heartbeatLease: { runId },
      };
      fsSync.writeFileSync(storePath, JSON.stringify(currentStore), "utf-8");
      staleHeartbeat = runWithSessionStoreOwnership(async () => {
        heartbeatAbortSignal = getSessionStoreOwnershipAbortSignal();
        setSessionStoreOwnership({
          storePath,
          sessionKey,
          sessionId,
          runId,
          heartbeatOnly: false,
        });
        await new Promise<void>((resolve) => {
          if (heartbeatAbortSignal?.aborted) {
            resolve();
            return;
          }
          heartbeatAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
      });
    };

    const user = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "feishu",
        From: "ou_user",
        To: "bot",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(staleHeartbeat).toBeDefined();
    expect(heartbeatAbortSignal?.aborted).toBe(true);
    await staleHeartbeat;
    expect(user.sessionEntry.heartbeatLease).toBeUndefined();
    const finalEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(finalEntry?.heartbeatLease).toBeUndefined();
    expect(finalEntry?.origin?.provider).toBe("feishu");
  });

  it("rejects later heartbeat store writes after ownership is cleared", async () => {
    const storePath = await createStorePath("openclaw-session-heartbeat-late-write-");
    const sessionKey = "agent:main:main";
    const sessionId = "heartbeat-session";
    const runId = "heartbeat-run";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        heartbeatLease: { runId },
        heartbeatOnly: { runId },
      },
    });

    await expect(
      runWithSessionStoreOwnership(async () => {
        setSessionStoreOwnership({
          storePath,
          sessionKey,
          sessionId,
          runId,
          heartbeatOnly: true,
        });
        await fs.writeFile(
          storePath,
          JSON.stringify({
            [sessionKey]: {
              sessionId,
              updatedAt: Date.now(),
              origin: { provider: "feishu", from: "ou_user", to: "bot" },
            },
          }),
        );
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = {
            ...store[sessionKey],
            heartbeatLease: { runId },
            heartbeatOnly: { runId },
          };
        });
      }),
    ).rejects.toThrow("heartbeat session ownership changed");

    const finalEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(finalEntry?.sessionId).toBe(sessionId);
    expect(finalEntry?.heartbeatLease).toBeUndefined();
    expect(finalEntry?.heartbeatOnly).toBeUndefined();
    expect(finalEntry?.origin?.provider).toBe("feishu");
  });
});

describe("initSessionState recent image snapshots", () => {
  it("keeps the first full init as a new session after early image snapshot persistence", async () => {
    const storePath = await createStorePath("openclaw-session-early-image-");
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;
    const ctx = {
      Body: "<media:image>",
      BodyForAgent: "<media:image>",
      RawBody: "<media:image>",
      CommandBody: "<media:image>",
      SessionKey: "agent:main:feishu:direct:ou_1",
      SenderId: "ou_1",
      AccountId: "default",
      MediaPath: "/tmp/inbound-image.jpg",
      MediaType: "image/jpeg",
    };

    await persistRecentMediaSnapshotEarly({ ctx, cfg });

    const earlyStore = loadSessionStore(storePath, { skipCache: true });
    expect(earlyStore[ctx.SessionKey]?.recentMediaSnapshot?.paths).toEqual([
      "/tmp/inbound-image.jpg",
    ]);
    expect(earlyStore[ctx.SessionKey]?.pendingRecentMediaSnapshotInit).toBe(true);

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionEntry.pendingRecentMediaSnapshotInit).toBeUndefined();

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[result.sessionKey]?.pendingRecentMediaSnapshotInit).toBeUndefined();
    expect(store[result.sessionKey]?.recentMediaSnapshot?.paths).toEqual([
      "/tmp/inbound-image.jpg",
    ]);
  });

  it("persists the latest inbound image on the session entry", async () => {
    const storePath = await createStorePath("openclaw-session-recent-image-");
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "<media:image>",
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        CommandBody: "<media:image>",
        SessionKey: "agent:main:feishu:direct:ou_1",
        SenderId: "ou_1",
        AccountId: "default",
        MediaPath: "/tmp/inbound-image.jpg",
        MediaType: "image/jpeg",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.recentMediaSnapshot).toEqual({
      kind: "image",
      messageId: undefined,
      messageIdFull: undefined,
      senderId: "ou_1",
      accountId: "default",
      threadId: undefined,
      capturedAt: expect.any(Number),
      paths: ["/tmp/inbound-image.jpg"],
      urls: undefined,
      types: ["image/jpeg"],
      pendingFollowup: true,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[result.sessionKey]?.recentMediaSnapshot?.paths).toEqual([
      "/tmp/inbound-image.jpg",
    ]);
  });

  it("rehydrates the latest image onto the next text-only turn in the same session", async () => {
    const storePath = await createStorePath("openclaw-session-rehydrate-image-");
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    await initSessionState({
      ctx: {
        Body: "<media:image>",
        BodyForAgent: "<media:image>",
        RawBody: "<media:image>",
        CommandBody: "<media:image>",
        SessionKey: "agent:main:feishu:direct:ou_1",
        SenderId: "ou_1",
        AccountId: "default",
        MediaPath: "/tmp/inbound-image.jpg",
        MediaType: "image/jpeg",
      },
      cfg,
      commandAuthorized: true,
    });

    const result = await initSessionState({
      ctx: {
        Body: "解释这个图片",
        BodyForAgent: "解释这个图片",
        RawBody: "解释这个图片",
        CommandBody: "解释这个图片",
        SessionKey: "agent:main:feishu:direct:ou_1",
        SenderId: "ou_1",
        AccountId: "default",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.MediaPath).toBe("/tmp/inbound-image.jpg");
    expect(result.sessionCtx.MediaType).toBe("image/jpeg");
    expect(result.sessionEntry.recentMediaSnapshot?.pendingFollowup).toBe(false);

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[result.sessionKey]?.recentMediaSnapshot?.pendingFollowup).toBe(false);
  });
});

describe("initSessionState thread forking", () => {
  it("forks a new session from the parent session file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await saveSessionStore(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).toBeTruthy();
    expect(result.sessionEntry.displayName).toBe(threadLabel);

    const newSessionFile = result.sessionEntry.sessionFile;
    if (!newSessionFile) {
      throw new Error("Missing session file for forked thread");
    }
    const [headerLine] = (await fs.readFile(newSessionFile, "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const parsedHeader = JSON.parse(headerLine) as {
      parentSession?: string;
    };
    expect(parsedHeader.parentSession).toBe(parentSessionFile);
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await saveSessionStore(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const first = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);

    const second = await initSessionState({
      ctx: {
        Body: "Thread reply 2",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    warn.mockRestore();
  });

  it("records topic-specific session files when MessageThreadId is present", async () => {
    const root = await makeCaseDir("openclaw-topic-session-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello topic",
        SessionKey: "agent:main:telegram:group:123:topic:456",
        MessageThreadId: 456,
      },
      cfg,
      commandAuthorized: true,
    });

    const sessionFile = result.sessionEntry.sessionFile;
    expect(sessionFile).toBeTruthy();
    expect(path.basename(sessionFile ?? "")).toBe(
      `${result.sessionEntry.sessionId}-topic-456.jsonl`,
    );
  });
});

describe("initSessionState RawBody", () => {
  it("triggerBodyNormalized correctly extracts commands when Body contains context but RawBody is clean", async () => {
    const root = await makeCaseDir("openclaw-rawbody-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const groupMessageCtx = {
      Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
      RawBody: "/status",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:g1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/status");
  });

  it("Reset trigger /new works with RawBody", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const groupMessageCtx = {
      Body: "[Context]\nJake: /new\n[from: Jake]",
      RawBody: "/new",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:g1:new",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("");
  });

  it("ignores /reset even when legacy config lists it as a reset trigger", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-legacy-");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new", "/reset"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/reset",
        ChatType: "direct",
        SessionKey: "agent:main:whatsapp:dm:s1",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.bodyStripped).toBeUndefined();
  });

  it("falls back to /new when legacy config only listed /reset", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-legacy-new-");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/reset"],
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        RawBody: "/new",
        ChatType: "direct",
        SessionKey: "agent:main:whatsapp:dm:s1",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-case-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as OpenClawConfig;

    const ctx = {
      RawBody: "/NEW KeepThisCase",
      ChatType: "direct",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("falls back to Body when RawBody is undefined", async () => {
    const root = await makeCaseDir("openclaw-rawbody-fallback-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const ctx = {
      Body: "/status",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/status");
  });

  it("uses the default per-agent sessions store when config store is unset", async () => {
    const root = await makeCaseDir("openclaw-session-store-default-");
    const stateDir = path.join(root, ".openclaw");
    const agentId = "worker1";
    const sessionKey = `agent:${agentId}:telegram:12345`;
    const sessionId = "sess-worker-1";
    const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      const cfg = {} as OpenClawConfig;
      const result = await initSessionState({
        ctx: {
          Body: "hello",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.sessionEntry.sessionId).toBe(sessionId);
      expect(result.sessionEntry.sessionFile).toBe(sessionFile);
      expect(result.storePath).toBe(storePath);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("initSessionState reset policy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    vi.useRealTimers();
  });

  it("defaults to daily memory capture without resetting the session at 4am local time", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-");
    const storePath = path.join(root, "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:whatsapp:dm:s1";
    const existingSessionId = "daily-session-id";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Default daily memory source" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Summarize without reset" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        sessionFile: existingSessionFile,
      },
    });

    const cfg = {
      session: { store: storePath },
      agents: { defaults: { workspace: root } },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    await expect(fs.access(existingSessionFile)).resolves.toBeUndefined();

    vi.useRealTimers();

    await vi.waitFor(
      async () => {
        const memoryContent = await fs.readFile(
          path.join(root, "memory", "2026-01-18.md"),
          "utf-8",
        );
        expect(memoryContent).toContain("**Source**: daily-rollover");
      },
      { timeout: 3000, interval: 50 },
    );

    const archivedFiles = await fs.readdir(sessionsDir);
    expect(archivedFiles.some((name) => name.startsWith(`${existingSessionId}.jsonl.reset.`))).toBe(
      false,
    );
  });

  it("treats sessions as stale before the daily reset when updated before yesterday's boundary", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    vi.mocked(runEmbeddedPiAgent).mockClear();
    const root = await makeCaseDir("openclaw-reset-daily-edge-");
    const storePath = path.join(root, "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:whatsapp:dm:s-edge";
    const existingSessionId = "daily-edge-session";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Yesterday work item" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Captured before daily rollover" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
        sessionFile: existingSessionFile,
      },
    });

    const sessionEndHandler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "session_end", handler: sessionEndHandler }]),
    );

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      agents: { defaults: { workspace: root } },
    } as OpenClawConfig;
    await fs.writeFile(
      path.join(root, "MEMORY.md"),
      [
        "<!-- OPENCLAW_STRUCTURED_MEMORY_START -->",
        "## OpenClaw Structured Memory",
        "",
        "### Facts",
        "",
        "#### fact_behavior_pref",
        "- Category: behavior",
        "- Confidence: 0.80",
        "- Content: 偏好基于官方文档做判断",
        "- Created At: 2026-01-17 22:00:00 CST",
        "- Updated At: 2026-01-17 22:00:00 CST",
        "- Source: legacy:daily-session-id",
        "",
        "<!-- OPENCLAW_STRUCTURED_MEMORY_END -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);

    await vi.waitFor(() => {
      expect(sessionEndHandler).toHaveBeenCalledTimes(1);
    });
    expect(sessionEndHandler).toHaveBeenCalledWith(
      {
        sessionId: existingSessionId,
        sessionKey,
        messageCount: 0,
        reason: "daily",
        sessionFile: existingSessionFile,
        transcriptArchived: true,
        nextSessionId: result.sessionId,
      },
      {
        sessionId: existingSessionId,
        sessionKey,
        agentId: "main",
      },
    );
    await expect(fs.access(existingSessionFile)).rejects.toThrow();
    expect(
      (await fs.readdir(sessionsDir)).some((name) =>
        name.startsWith(`${existingSessionId}.jsonl.reset.`),
      ),
    ).toBe(true);

    vi.useRealTimers();

    const memoryDir = path.join(root, "memory");
    await vi.waitFor(
      async () => {
        const files = await fs.readdir(memoryDir);
        expect(files.length).toBeGreaterThan(0);
      },
      { timeout: 3000, interval: 50 },
    );
    const files = await fs.readdir(memoryDir);
    expect(files).toEqual(["2026-01-18.md"]);
    const memoryContent = await fs.readFile(path.join(memoryDir, files[0]), "utf-8");
    expect(memoryContent).toContain("## Daily Structured Summary");
    expect(memoryContent).toContain("**Source**: daily-rollover");
    expect(memoryContent).toContain("### 最终结论");
    expect(memoryContent).toContain("### 已验证有效的方法");
    expect(memoryContent).toContain("### 稳定约束 / 用户偏好 / 重要决策");
    expect(memoryContent).toContain("### 待继续事项");
    expect(memoryContent).toContain("### 稳定失败教训");
    expect(memoryContent).not.toContain("Yesterday work item");
    expect(memoryContent).not.toContain("Captured before daily rollover");

    const rootMemoryPath = path.join(root, "MEMORY.md");
    await vi.waitFor(
      async () => {
        const content = await fs.readFile(rootMemoryPath, "utf-8");
        expect(content).toContain("## OpenClaw Structured Memory");
      },
      { timeout: 3000, interval: 50 },
    );
    const rootMemoryContent = await fs.readFile(rootMemoryPath, "utf-8");
    expect(rootMemoryContent).toContain("长期负责 OpenClaw 记忆与 session reset 机制。");
    expect(rootMemoryContent).toContain("当前在收敛 daily rollover 与长期记忆同步方案。");
    expect(rootMemoryContent).toContain("偏好基于官方文档和源码做判断");
    expect(rootMemoryContent).toContain("当前目标是让 daily rollover 自动更新长期记忆。");
    expect(rootMemoryContent).toContain("新事实是对既有行为偏好的更完整重述，适合并入原事实。");
    expect(rootMemoryContent.match(/- Category: behavior/g)?.length).toBe(1);
    expect(
      vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.some(
          ([call]) =>
            typeof call.prompt === "string" &&
            call.prompt.includes("Return strict JSON with this shape"),
        ),
    ).toBe(true);

    await vi.waitFor(
      async () => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store[sessionKey]?.dailyMemoryCaptureSessionId).toBe(existingSessionId);
      },
      { timeout: 3000, interval: 50 },
    );
    const updatedStore = loadSessionStore(storePath, { skipCache: true });
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureSessionId).toBe(existingSessionId);
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureAt).toBeTypeOf("number");
  });

  it("recovers daily rollover transcript from canonical agent sessions dir when sessionFile is missing", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-canonical-");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s-canonical";
    const existingSessionId = "canonical-daily-session";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Canonical rollover source" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Capture from canonical sessions dir" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      agents: { defaults: { workspace: workspaceDir } },
    } as OpenClawConfig;

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
      vi.useRealTimers();

      await vi.waitFor(
        async () => {
          const files = await fs.readdir(path.join(workspaceDir, "memory"));
          expect(files).toEqual(["2026-01-18.md"]);
        },
        { timeout: 3000, interval: 50 },
      );
      const memoryContent = await fs.readFile(
        path.join(workspaceDir, "memory", "2026-01-18.md"),
        "utf-8",
      );
      expect(memoryContent).toContain("## Daily Structured Summary");
      expect(memoryContent).toContain("**Source**: daily-rollover");

      const updatedStore = loadSessionStore(storePath, { skipCache: true });
      expect(updatedStore[sessionKey]?.dailyMemoryCaptureSessionId).toBe(existingSessionId);
      expect(updatedStore[sessionKey]?.dailyMemoryCaptureAt).toBeTypeOf("number");
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("archives the stale transcript after successful daily rollover capture", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-archive-");
    const storePath = path.join(root, "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:whatsapp:dm:s-daily-archive";
    const existingSessionId = "daily-archive-session";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Archive daily rollover source" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Capture then archive" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
        sessionFile: existingSessionFile,
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      agents: { defaults: { workspace: root } },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    vi.useRealTimers();

    await vi.waitFor(
      async () => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store[sessionKey]?.dailyMemoryCaptureSessionId).toBe(existingSessionId);
      },
      { timeout: 3000, interval: 50 },
    );

    await expect(fs.access(existingSessionFile)).rejects.toThrow();
    const archivedFiles = await fs.readdir(sessionsDir);
    expect(archivedFiles.some((name) => name.startsWith(`${existingSessionId}.jsonl.reset.`))).toBe(
      true,
    );
  });

  it("does not mark daily rollover complete when legacy sessionFile is missing and no transcript exists", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-missing-source-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s-missing-source";
    const existingSessionId = "missing-source-daily-session";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      agents: { defaults: { workspace: root } },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);

    vi.useRealTimers();

    await vi.waitFor(
      async () => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store[sessionKey]?.dailyMemoryCapturePendingSessionId).toBeUndefined();
      },
      { timeout: 3000, interval: 50 },
    );

    const files = await fs.readdir(path.join(root, "memory")).catch(() => []);
    expect(files).toEqual([]);
    const updatedStore = loadSessionStore(storePath, { skipCache: true });
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureSessionId).toBeUndefined();
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureAt).toBeUndefined();
  });

  it("expires sessions when idle timeout wins over daily reset", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:whatsapp:dm:s2";
    const existingSessionId = "idle-session-id";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Idle boundary only" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Should not capture on idle" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        sessionFile: existingSessionFile,
      },
    });

    const sessionEndHandler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "session_end", handler: sessionEndHandler }]),
    );

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
      },
      agents: { defaults: { workspace: root } },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);

    await vi.waitFor(() => {
      expect(sessionEndHandler).toHaveBeenCalledTimes(1);
    });
    expect(sessionEndHandler).toHaveBeenCalledWith(
      {
        sessionId: existingSessionId,
        sessionKey,
        messageCount: 0,
        reason: "idle",
        sessionFile: existingSessionFile,
        transcriptArchived: true,
        nextSessionId: result.sessionId,
      },
      {
        sessionId: existingSessionId,
        sessionKey,
        agentId: "main",
      },
    );
    await expect(fs.access(existingSessionFile)).rejects.toThrow();
    expect(
      (await fs.readdir(sessionsDir)).some((name) =>
        name.startsWith(`${existingSessionId}.jsonl.reset.`),
      ),
    ).toBe(true);

    vi.useRealTimers();

    await new Promise((resolve) => setTimeout(resolve, 150));
    const memoryDir = path.join(root, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
    const updatedStore = loadSessionStore(storePath, { skipCache: true });
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureSessionId).toBeUndefined();
  });

  it("skips daily rollover capture when session-memory hook is disabled", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-capture-disabled-");
    const storePath = path.join(root, "sessions.json");
    const sessionsDir = path.dirname(storePath);
    const sessionKey = "agent:main:whatsapp:dm:s-disabled";
    const existingSessionId = "daily-disabled-session";
    const existingSessionFile = path.join(sessionsDir, `${existingSessionId}.jsonl`);

    await fs.writeFile(
      existingSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Daily rollover should not capture" },
        }),
      ].join("\n"),
      "utf-8",
    );

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        sessionFile: existingSessionFile,
      },
    });

    const cfg = {
      session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      agents: { defaults: { workspace: root } },
      hooks: {
        internal: {
          entries: {
            "session-memory": {
              enabled: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);

    vi.useRealTimers();

    await new Promise((resolve) => setTimeout(resolve, 150));
    const memoryDir = path.join(root, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
    const updatedStore = loadSessionStore(storePath, { skipCache: true });
    expect(updatedStore[sessionKey]?.dailyMemoryCaptureSessionId).toBeUndefined();
  });

  it("uses per-type overrides for thread sessions", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const existingSessionId = "thread-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        reset: { mode: "daily", atHour: 4 },
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Slack thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("detects thread sessions without thread key suffix", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-nosuffix-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:channel:c1";
    const existingSessionId = "thread-nosuffix";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Discord thread" },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("does not default to daily reset when only another resetByType is configured", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-type-default-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s4";
    const existingSessionId = "type-default-session";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        resetByType: { thread: { mode: "idle", idleMinutes: 60 } },
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("keeps legacy idleMinutes behavior without reset config", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-legacy-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s3";
    const existingSessionId = "legacy-session-id";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        store: storePath,
        idleMinutes: 240,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      ctx: { Body: "hello", SessionKey: sessionKey },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });
});

describe("initSessionState channel reset overrides", () => {
  it("uses channel-specific reset policy when configured", async () => {
    const root = await makeCaseDir("openclaw-channel-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:dm:123";
    const sessionId = "session-override";
    const updatedAt = Date.now() - (10080 - 1) * 60_000;

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt,
      },
    });

    const cfg = {
      session: {
        store: storePath,
        idleMinutes: 60,
        resetByType: { direct: { mode: "idle", idleMinutes: 10 } },
        resetByChannel: { discord: { mode: "idle", idleMinutes: 10080 } },
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello",
        SessionKey: sessionKey,
        Provider: "discord",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
  });
});

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): OpenClawConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as OpenClawConfig;
  }

  it("applies WhatsApp group reset authorization across sender variants", async () => {
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    const cases = [
      {
        name: "authorized sender",
        storePrefix: "openclaw-group-reset-",
        allowFrom: ["+41796666864"],
        body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
        senderName: "Peschiño",
        senderE164: "+41796666864",
        senderId: "41796666864:0@s.whatsapp.net",
        expectedIsNewSession: true,
      },
      {
        name: "unauthorized sender",
        storePrefix: "openclaw-group-reset-unauth-",
        allowFrom: ["+41796666864"],
        body: `[Context]\\n[WhatsApp ...] OtherPerson: /new\\n[from: OtherPerson (+1555123456)]`,
        senderName: "OtherPerson",
        senderE164: "+1555123456",
        senderId: "1555123456:0@s.whatsapp.net",
        expectedIsNewSession: false,
      },
      {
        name: "raw body clean while body wrapped",
        storePrefix: "openclaw-group-rawbody-",
        allowFrom: ["*"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Jake: /new\n[from: Jake (+1222)]`,
        senderName: undefined,
        senderE164: "+1222",
        senderId: undefined,
        expectedIsNewSession: true,
      },
      {
        name: "LID sender with authorized E164",
        storePrefix: "openclaw-group-reset-lid-",
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Owner: /new\n[from: Owner (+41796666864)]`,
        senderName: "Owner",
        senderE164: "+41796666864",
        senderId: "123@lid",
        expectedIsNewSession: true,
      },
      {
        name: "LID sender with unauthorized E164",
        storePrefix: "openclaw-group-reset-lid-unauth-",
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
        senderName: "Other",
        senderE164: "+1555123456",
        senderId: "123@lid",
        expectedIsNewSession: false,
      },
    ] as const;

    for (const testCase of cases) {
      const storePath = await createStorePath(testCase.storePrefix);
      await seedSessionStore({
        storePath,
        sessionKey,
        sessionId: existingSessionId,
      });
      const cfg = makeCfg({
        storePath,
        allowFrom: [...testCase.allowFrom],
      });

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: "/new",
          CommandBody: "/new",
          From: "120363406150318674@g.us",
          To: "+41779241027",
          ChatType: "group",
          SessionKey: sessionKey,
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderName: testCase.senderName,
          SenderE164: testCase.senderE164,
          SenderId: testCase.senderId,
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.triggerBodyNormalized, testCase.name).toBe("/new");
      expect(result.isNewSession, testCase.name).toBe(testCase.expectedIsNewSession);
      if (testCase.expectedIsNewSession) {
        expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
        expect(result.bodyStripped, testCase.name).toBe("");
      } else {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
      }
    }
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("supports mention-prefixed Slack /new commands and preserves args", async () => {
    const existingSessionId = "existing-session-123";
    const cases = [
      {
        name: "new command with args",
        storePrefix: "openclaw-slack-channel-new-",
        sessionKey: "agent:main:slack:channel:c1",
        body: "<@U123> /new take notes",
        expectedBodyStripped: "take notes",
      },
    ] as const;

    for (const testCase of cases) {
      const storePath = await createStorePath(testCase.storePrefix);
      await seedSessionStore({
        storePath,
        sessionKey: testCase.sessionKey,
        sessionId: existingSessionId,
      });
      const cfg = {
        session: { store: storePath, idleMinutes: 999 },
      } as OpenClawConfig;

      const result = await initSessionState({
        ctx: {
          Body: testCase.body,
          RawBody: testCase.body,
          CommandBody: testCase.body,
          From: "slack:channel:C1",
          To: "channel:C1",
          ChatType: "channel",
          SessionKey: testCase.sessionKey,
          Provider: "slack",
          Surface: "slack",
          SenderId: "U123",
          SenderName: "Owner",
        },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.bodyStripped, testCase.name).toBe(testCase.expectedBodyStripped);
    }
  });
});

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.1");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const cfg = {} as OpenClawConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry: SessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: false,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});

describe("initSessionState handles behavior overrides across /new", () => {
  async function seedSessionStoreWithOverrides(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("/new preserves verboseLevel from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-verbose-");
    const sessionKey = "agent:main:telegram:dm:user1";
    const existingSessionId = "existing-session-verbose";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { verboseLevel: "on" },
    });
    await fs.writeFile(
      path.join(path.dirname(storePath), `${existingSessionId}.jsonl`),
      "",
      "utf-8",
    );

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user1",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.sessionEntry.verboseLevel).toBe("on");
  });

  it("/new clears thinkingLevel, reasoningLevel, and responseUsage from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-thinking-");
    const sessionKey = "agent:main:telegram:dm:user2";
    const existingSessionId = "existing-session-thinking";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: {
        thinkingLevel: "high",
        reasoningLevel: "low",
        responseUsage: "full",
      },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user2",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
    expect(result.sessionEntry.reasoningLevel).toBeUndefined();
    expect(result.sessionEntry.responseUsage).toBeUndefined();
  });

  it("/new preserves session label from previous session", async () => {
    const storePath = await createStorePath("openclaw-reset-label-");
    const sessionKey = "agent:main:telegram:dm:user-label";
    const existingSessionId = "existing-session-label";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { label: "telegram-priority" },
    });

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-label",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.label).toBe("telegram-priority");
  });

  it("/new in a new session does not preserve overrides", async () => {
    const storePath = await createStorePath("openclaw-new-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:user3";

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user3",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });

  it("archives the old session store entry on /new", async () => {
    const storePath = await createStorePath("openclaw-archive-old-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { verboseLevel: "on" },
    });
    const sessionUtils = await import("../../gateway/session-utils.fs.js");
    const archiveSpy = vi.spyOn(sessionUtils, "archiveSessionTranscripts");

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-archive",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(archiveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: existingSessionId,
        storePath,
        reason: "reset",
      }),
    );
    archiveSpy.mockRestore();
  });

  it("emits session_end with reason=new for /new", async () => {
    const storePath = await createStorePath("openclaw-session-end-new-");
    const sessionKey = "agent:main:telegram:dm:user-session-end-new";
    const existingSessionId = "existing-session-end-new";
    const existingSessionFile = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);

    await seedSessionStoreWithOverrides({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
      overrides: { sessionFile: existingSessionFile, verboseLevel: "on" },
    });
    await fs.writeFile(existingSessionFile, "", "utf-8");

    const sessionEndHandler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "session_end", handler: sessionEndHandler }]),
    );

    const cfg = {
      session: { store: storePath, idleMinutes: 999 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "/new",
        RawBody: "/new",
        CommandBody: "/new",
        From: "user-session-end-new",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    await vi.waitFor(() => {
      expect(sessionEndHandler).toHaveBeenCalledTimes(1);
    });
    expect(sessionEndHandler).toHaveBeenCalledWith(
      {
        sessionId: existingSessionId,
        sessionKey,
        messageCount: 0,
        reason: "new",
        sessionFile: existingSessionId
          ? expect.stringContaining(`${existingSessionId}.jsonl`)
          : undefined,
        transcriptArchived: true,
        nextSessionId: result.sessionId,
      },
      {
        sessionId: existingSessionId,
        sessionKey,
        agentId: "main",
      },
    );
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const storePath = await createStorePath("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { store: storePath, idleMinutes: 0 },
    } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        From: "new-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("prependSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await prependSystemEvents({
        cfg: {} as OpenClawConfig,
        sessionKey: "agent:main:main",
        isMainSession: false,
        isNewSession: false,
        prefixedBodyBase: "User: hi",
      });

      expect(expectedTimestamp).toBeDefined();
      expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });
});

describe("persistSessionUsageUpdate", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await fs.writeFile(
      params.storePath,
      JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
      "utf-8",
    );
  }

  it("uses lastCallUsage for totalTokens when provided", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now(), totalTokens: 100_000 },
    });

    const accumulatedUsage = { input: 180_000, output: 10_000, total: 190_000 };
    const lastCallUsage = { input: 12_000, output: 2_000, total: 14_000 };

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: accumulatedUsage,
      lastCallUsage,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(180_000);
    expect(stored[sessionKey].outputTokens).toBe(10_000);
  });

  it("marks totalTokens as unknown when no fresh context snapshot is available", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
  });

  it("uses promptTokens when available without lastCallUsage", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 50_000, output: 5_000, total: 55_000 },
      promptTokens: 42_000,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(42_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("persists totalTokens from promptTokens when usage is unavailable", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        inputTokens: 1_234,
        outputTokens: 456,
      },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: undefined,
      promptTokens: 39_000,
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(39_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(1_234);
    expect(stored[sessionKey].outputTokens).toBe(456);
  });

  it("keeps non-clamped lastCallUsage totalTokens when exceeding context window", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: { sessionId: "s1", updatedAt: Date.now() },
    });

    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 300_000, output: 10_000, total: 310_000 },
      lastCallUsage: { input: 250_000, output: 5_000, total: 255_000 },
      contextTokensUsed: 200_000,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(stored[sessionKey].totalTokens).toBe(250_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });
});

describe("initSessionState stale threadId fallback", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await fs.writeFile(
      params.storePath,
      JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
      "utf-8",
    );
  }

  it("ignores persisted lastThreadId on main sessions for non-thread messages", async () => {
    const storePath = await createStorePath("stale-main-thread-");
    const sessionKey = "agent:main:main";
    await seedSessionStore({
      storePath,
      sessionKey,
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "telegram:123",
        lastThreadId: 42,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:123",
          threadId: 42,
        },
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello from DM",
        SessionKey: sessionKey,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastThreadId).toBeUndefined();
    expect(result.sessionEntry.deliveryContext?.threadId).toBeUndefined();
  });

  it("does not inherit lastThreadId from a previous thread interaction in non-thread sessions", async () => {
    const storePath = await createStorePath("stale-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First interaction: inside a DM topic (thread session)
    const threadResult = await initSessionState({
      ctx: {
        Body: "hello from topic",
        SessionKey: "agent:main:main:thread:42",
        MessageThreadId: 42,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(threadResult.sessionEntry.lastThreadId).toBe(42);

    // Second interaction: plain DM (non-thread session), same store
    // The main session should NOT inherit threadId=42
    const mainResult = await initSessionState({
      ctx: {
        Body: "hello from DM",
        SessionKey: "agent:main:main",
      },
      cfg,
      commandAuthorized: true,
    });
    expect(mainResult.sessionEntry.lastThreadId).toBeUndefined();
  });

  it("preserves lastThreadId within the same thread session", async () => {
    const storePath = await createStorePath("preserve-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First message in thread
    await initSessionState({
      ctx: {
        Body: "first",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });

    // Second message in same thread (MessageThreadId still present)
    const result = await initSessionState({
      ctx: {
        Body: "second",
        SessionKey: "agent:main:main:thread:99",
        MessageThreadId: 99,
      },
      cfg,
      commandAuthorized: true,
    });
    expect(result.sessionEntry.lastThreadId).toBe(99);
  });
});

describe("initSessionState internal channel routing preservation", () => {
  it("keeps persisted external lastChannel when OriginatingChannel is internal", async () => {
    const storePath = await createStorePath("preserve-external-channel-");
    const sessionKey = "agent:main:telegram:group:12345";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "group:12345",
        lastAccountId: "alerts",
        lastThreadId: 42,
        deliveryContext: {
          channel: "telegram",
          to: "group:12345",
          accountId: "alerts",
          threadId: 42,
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "internal follow-up",
        From: "heartbeat",
        To: "heartbeat",
        Provider: "heartbeat",
        SessionKey: sessionKey,
        OriginatingChannel: "internal",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.lastTo).toBe("group:12345");
    expect(result.sessionEntry.lastAccountId).toBe("alerts");
    expect(result.sessionEntry.lastThreadId).toBe(42);
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "telegram",
      to: "group:12345",
      accountId: "alerts",
      threadId: 42,
    });
  });

  it("uses session key channel hint when first turn is internal", async () => {
    const storePath = await createStorePath("session-key-channel-hint-");
    const sessionKey = "agent:main:telegram:group:98765";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: sessionKey,
        OriginatingChannel: "internal",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
  });

  it("does not persist internal as the last channel for main sessions", async () => {
    const storePath = await createStorePath("internal-main-no-route-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "heartbeat",
        From: "heartbeat",
        To: "heartbeat",
        Provider: "heartbeat",
        SessionKey: "agent:main:main",
        OriginatingChannel: "internal",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBeUndefined();
    expect(result.sessionEntry.lastTo).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toBeUndefined();
  });

  it("keeps a Feishu delivery route when the Control UI sends into the session", async () => {
    const storePath = await createStorePath("control-ui-preserve-feishu-route-");
    const sessionKey = "agent:feishu-user:main";
    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "sess-feishu",
        updatedAt: Date.now(),
        lastChannel: "feishu",
        lastTo: "user:ou_123",
        lastAccountId: "researcher",
        lastThreadId: "om_456",
        deliveryContext: {
          channel: "feishu",
          to: "user:ou_123",
          accountId: "researcher",
          threadId: "om_456",
        },
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "operator follow-up",
        SessionKey: sessionKey,
        Provider: "control-ui",
        Surface: "control-ui",
        OriginatingChannel: "control-ui",
        To: "control-ui",
        AccountId: "ui-account",
        MessageThreadId: "ui-thread",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("feishu");
    expect(result.sessionEntry.lastTo).toBe("user:ou_123");
    expect(result.sessionEntry.lastAccountId).toBe("researcher");
    expect(result.sessionEntry.lastThreadId).toBe("om_456");
    expect(result.sessionEntry.deliveryContext).toEqual({
      channel: "feishu",
      to: "user:ou_123",
      accountId: "researcher",
      threadId: "om_456",
    });
    expect(result.sessionEntry.origin).toMatchObject({
      provider: "control-ui",
      surface: "control-ui",
    });
  });

  it("records Control UI origin without creating a delivery route", async () => {
    const storePath = await createStorePath("control-ui-main-no-route-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:main",
        Provider: "control-ui",
        Surface: "control-ui",
        OriginatingChannel: "control-ui",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBeUndefined();
    expect(result.sessionEntry.deliveryContext).toBeUndefined();
    expect(result.sessionEntry.origin?.provider).toBe("control-ui");
  });

  it("keeps webchat channel for webchat/main sessions", async () => {
    const storePath = await createStorePath("preserve-webchat-main-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "hello",
        SessionKey: "agent:main:main",
        OriginatingChannel: "webchat",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
  });
});
