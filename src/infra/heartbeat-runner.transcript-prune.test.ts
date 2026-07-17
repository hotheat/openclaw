import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initSessionState } from "../auto-reply/reply/session.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  getSessionStoreOwnershipAbortSignal,
  loadSessionStore,
  resolveMainSessionKey,
  setSessionStoreOwnership,
  updateSessionStore,
} from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

describe("heartbeat transcript retention", () => {
  async function createTranscriptWithContent(transcriptPath: string, sessionId: string) {
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const existingContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there"}\n`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, existingContent);
    return existingContent;
  }

  it("keeps acknowledgement turns in an existing transcript", async () => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const sessionId = "test-existing-heartbeat-session";
        const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
        const originalContent = await createTranscriptWithContent(transcriptPath, sessionId);
        const heartbeatContent =
          '{"role":"user","content":"Heartbeat prompt"}\n' +
          '{"role":"assistant","content":"HEARTBEAT_OK"}\n';

        await seedSessionStore(storePath, sessionKey, {
          sessionId,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        replySpy.mockImplementationOnce(async () => {
          await fs.appendFile(transcriptPath, heartbeatContent);
          return {
            text: "HEARTBEAT_OK",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        });

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          session: { store: storePath },
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        await expect(fs.readFile(transcriptPath, "utf-8")).resolves.toBe(
          originalContent + heartbeatContent,
        );
      },
      { prefix: "openclaw-hb-retain-existing-" },
    );
  });

  it("keeps a heartbeat-only session created by an acknowledgement run", async () => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const sessionId = "test-new-heartbeat-session";
        const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

        replySpy.mockImplementationOnce(async () => {
          await fs.writeFile(
            storePath,
            JSON.stringify({
              [sessionKey]: {
                sessionId,
                updatedAt: Date.now(),
                deliveryContext: { to: "heartbeat" },
                lastTo: "heartbeat",
                origin: {
                  label: "heartbeat",
                  provider: "heartbeat",
                  from: "heartbeat",
                  to: "heartbeat",
                },
              },
            }),
          );
          await createTranscriptWithContent(transcriptPath, sessionId);
          return {
            text: "HEARTBEAT_OK",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        });

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          session: { store: storePath },
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
        expect(store[sessionKey]).toBeDefined();
        await expect(fs.stat(transcriptPath)).resolves.toBeDefined();
      },
      { prefix: "openclaw-hb-retain-new-" },
    );
  });

  it("rejects acknowledgement post-processing after the user resets the session", async () => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const sessionId = "heartbeat-existing-session";
        const userSessionId = "user-reset-session";
        const runId = "heartbeat-run";
        await seedSessionStore(storePath, sessionKey, {
          sessionId,
          updatedAt: Date.now() - 1000,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        let releaseReply!: () => void;
        let signalReplyStarted!: () => void;
        const replyStarted = new Promise<void>((resolve) => {
          signalReplyStarted = resolve;
        });
        const continueReply = new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
        replySpy.mockImplementationOnce(async () => {
          await updateSessionStore(storePath, (store) => {
            const current = store[sessionKey];
            if (!current) {
              return;
            }
            store[sessionKey] = {
              ...current,
              heartbeatLease: { runId },
            };
          });
          setSessionStoreOwnership({
            storePath,
            sessionKey,
            sessionId,
            runId,
            heartbeatOnly: false,
          });
          signalReplyStarted();
          await continueReply;
          return {
            text: "HEARTBEAT_OK",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        });

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          session: { store: storePath },
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;
        const heartbeatRun = runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        await replyStarted;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = {
            sessionId: userSessionId,
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "user456",
          };
        });
        releaseReply();

        await expect(heartbeatRun).resolves.toMatchObject({
          status: "failed",
          reason: "heartbeat session ownership changed",
        });
        const finalEntry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
        expect(finalEntry?.sessionId).toBe(userSessionId);
        expect(finalEntry?.heartbeatLease).toBeUndefined();
        expect(finalEntry?.lastHeartbeatText).toBeUndefined();
        expect(finalEntry?.lastHeartbeatSentAt).toBeUndefined();
      },
      { prefix: "openclaw-hb-post-reply-ownership-" },
    );
  });

  it("actively aborts an older heartbeat when a concurrent run replaces its lease", async () => {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const sessionId = "concurrent-heartbeat-session";
        await seedSessionStore(storePath, sessionKey, {
          sessionId,
          updatedAt: Date.now() - 1000,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          session: { store: storePath },
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;
        let callCount = 0;
        let firstAbortSignal: AbortSignal | undefined;
        let secondRunId: string | undefined;
        let signalFirstReplyStarted!: () => void;
        const firstReplyStarted = new Promise<void>((resolve) => {
          signalFirstReplyStarted = resolve;
        });
        replySpy.mockImplementation(async (ctx: MsgContext) => {
          const sessionState = await initSessionState({
            ctx,
            cfg,
            commandAuthorized: true,
            isHeartbeat: true,
          });
          const abortSignal = getSessionStoreOwnershipAbortSignal();
          callCount += 1;
          if (callCount === 1) {
            firstAbortSignal = abortSignal;
            signalFirstReplyStarted();
            await new Promise<never>((_, reject) => {
              if (abortSignal?.aborted) {
                reject(abortSignal.reason);
                return;
              }
              abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), {
                once: true,
              });
            });
          }
          secondRunId = sessionState.sessionEntry.heartbeatLease?.runId;
          return { text: "HEARTBEAT_OK" };
        });

        const firstRun = runHeartbeatOnce({
          reason: "first",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });
        await firstReplyStarted;
        const secondRun = runHeartbeatOnce({
          reason: "second",
          cfg,
          deps: { sendTelegram: vi.fn() },
        });

        await expect(firstRun).resolves.toMatchObject({
          status: "failed",
          reason: "heartbeat session ownership changed",
        });
        await expect(secondRun).resolves.toMatchObject({ status: "ran" });
        expect(firstAbortSignal?.aborted).toBe(true);
        expect(secondRunId).toBeTruthy();
        expect(
          loadSessionStore(storePath, { skipCache: true })[sessionKey]?.heartbeatLease?.runId,
        ).toBe(secondRunId);
      },
      { prefix: "openclaw-hb-concurrent-runs-" },
    );
  });
});
