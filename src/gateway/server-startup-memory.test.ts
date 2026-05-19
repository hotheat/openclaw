import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
}));

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
  });

  it("skips initialization when memory search is disabled", async () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
        list: [{ id: "main", default: true }],
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes qmd backend for each configured agent", async () => {
    const cfg = {
      agents: { list: [{ id: "ops", default: true }, { id: "main" }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "ops" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "main" });
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'qmd memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'qmd memory startup sync completed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      3,
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      4,
      'qmd memory startup sync completed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes builtin postgres memory for each configured agent", async () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            store: {
              driver: "postgres",
              postgres: {
                host: "127.0.0.1",
                port: 5432,
                database: "openclaw",
                user: "tester",
                password: "secret",
                schema: "agent_memory",
              },
            },
          },
        },
        list: [{ id: "ops", default: true }, { id: "main" }],
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(1, { cfg, agentId: "ops" });
    expect(getMemorySearchManagerMock).toHaveBeenNthCalledWith(2, { cfg, agentId: "main" });
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'builtin-postgres memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'builtin-postgres memory startup sync completed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      3,
      'builtin-postgres memory startup initialization armed for agent "main"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      4,
      'builtin-postgres memory startup sync completed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("initializes builtin sqlite memory for each configured agent", async () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            store: {
              driver: "sqlite",
            },
          },
        },
        list: [{ id: "ops", default: true }, { id: "main" }],
      },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenNthCalledWith(
      1,
      'builtin-sqlite memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      2,
      'builtin-sqlite memory startup sync completed for agent "ops"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      3,
      'builtin-sqlite memory startup initialization armed for agent "main"',
    );
    expect(log.info).toHaveBeenNthCalledWith(
      4,
      'builtin-sqlite memory startup sync completed for agent "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when qmd manager init fails and continues with other agents", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock
      .mockResolvedValueOnce({ manager: null, error: "qmd missing" })
      .mockResolvedValueOnce({
        manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
      });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'qmd memory startup initialization failed for agent "main": qmd missing',
    );
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "ops"',
    );
    expect(log.info).toHaveBeenCalledWith('qmd memory startup sync completed for agent "ops"');
  });

  it("skips agents with memory search disabled", async () => {
    const cfg = {
      agents: {
        defaults: { memorySearch: { enabled: true } },
        list: [
          { id: "main", default: true },
          { id: "ops", memorySearch: { enabled: false } },
        ],
      },
      memory: { backend: "qmd", qmd: {} },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
    });

    await startGatewayMemoryBackend({ cfg, log });

    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
    expect(log.info).toHaveBeenCalledWith(
      'qmd memory startup initialization armed for agent "main"',
    );
    expect(log.info).toHaveBeenCalledWith('qmd memory startup sync completed for agent "main"');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a warning when startup sync fails and continues", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      memory: { backend: "builtin" },
    } as OpenClawConfig;
    const log = { info: vi.fn(), warn: vi.fn() };
    getMemorySearchManagerMock
      .mockResolvedValueOnce({
        manager: { search: vi.fn(), sync: vi.fn(async () => Promise.reject(new Error("boom"))) },
      })
      .mockResolvedValueOnce({
        manager: { search: vi.fn(), sync: vi.fn(async () => undefined) },
      });

    await startGatewayMemoryBackend({ cfg, log });

    expect(log.warn).toHaveBeenCalledWith(
      'builtin-sqlite memory startup sync failed for agent "main": boom',
    );
    expect(log.info).toHaveBeenCalledWith(
      'builtin-sqlite memory startup sync completed for agent "ops"',
    );
  });
});
