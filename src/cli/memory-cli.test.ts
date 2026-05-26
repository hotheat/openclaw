import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");
const resolveAgentConfig = vi.fn((cfg: Record<string, unknown>, agentId: string) => {
  const agents = (cfg.agents as { list?: Array<{ id: string }> } | undefined)?.list ?? [];
  return agents.find((entry) => entry.id === agentId);
});

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentConfig,
}));

let registerMemoryCli: typeof import("./memory-cli.js").registerMemoryCli;
let defaultRuntime: typeof import("../runtime.js").defaultRuntime;
let isVerbose: typeof import("../globals.js").isVerbose;
let setVerbose: typeof import("../globals.js").setVerbose;

beforeAll(async () => {
  ({ registerMemoryCli } = await import("./memory-cli.js"));
  ({ defaultRuntime } = await import("../runtime.js"));
  ({ isVerbose, setVerbose } = await import("../globals.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  loadConfig.mockReset();
  loadConfig.mockImplementation(() => ({}));
  resolveDefaultAgentId.mockReset();
  resolveDefaultAgentId.mockImplementation(() => "main");
  resolveAgentConfig.mockReset();
  resolveAgentConfig.mockImplementation((cfg: Record<string, unknown>, agentId: string) => {
    const agents = (cfg.agents as { list?: Array<{ id: string }> } | undefined)?.list ?? [];
    return agents.find((entry) => entry.id === agentId);
  });
  process.exitCode = undefined;
  setVerbose(false);
});

describe("memory cli", () => {
  function spyRuntimeLogs() {
    return vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  }

  function spyRuntimeErrors() {
    return vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  }

  function firstLoggedJson(log: ReturnType<typeof vi.spyOn>) {
    return JSON.parse(String(log.mock.calls[0]?.[0] ?? "null")) as Record<string, unknown>;
  }

  function expectCliSync(sync: ReturnType<typeof vi.fn>) {
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", force: false, progress: expect.any(Function) }),
    );
  }

  function expectCliInitStore(initStore: ReturnType<typeof vi.fn>) {
    expect(initStore).toHaveBeenCalledWith(
      expect.objectContaining({ progress: expect.any(Function) }),
    );
  }

  function expectCliRepairStore(repairStore: ReturnType<typeof vi.fn>) {
    expect(repairStore).toHaveBeenCalledWith(
      expect.objectContaining({ progress: expect.any(Function) }),
    );
  }

  function makeMemoryStatus(overrides: Record<string, unknown> = {}) {
    return {
      files: 0,
      chunks: 0,
      dirty: false,
      workspaceDir: "/tmp/openclaw",
      dbPath: "/tmp/memory.sqlite",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
      vector: { enabled: true, available: true },
      ...overrides,
    };
  }

  function mockManager(manager: Record<string, unknown>) {
    getMemorySearchManager.mockResolvedValueOnce({ manager });
  }

  async function runMemoryCli(args: string[]) {
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", ...args], { from: "user" });
  }

  async function withTempOpenClawHome<T>(
    run: (params: { home: string; stateDir: string; workspaceDir: string }) => Promise<T>,
  ) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-home-"));
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const previousHome = process.env.HOME;
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.HOME = home;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await fs.mkdir(workspaceDir, { recursive: true });
      return await run({ home, stateDir, workspaceDir });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  async function withQmdIndexDb(content: string, run: (dbPath: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cli-qmd-index-"));
    const dbPath = path.join(tmpDir, "index.sqlite");
    try {
      await fs.writeFile(dbPath, content, "utf-8");
      await run(dbPath);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function expectCloseFailureAfterCommand(params: {
    args: string[];
    manager: Record<string, unknown>;
    beforeExpect?: () => void;
  }) {
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    mockManager({ ...params.manager, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(params.args);

    params.beforeExpect?.();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  }

  it("prints vector status when available", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () =>
        makeMemoryStatus({
          files: 2,
          chunks: 5,
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => false),
      status: () =>
        makeMemoryStatus({
          dirty: true,
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--agent", "main"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--deep"]);

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus(),
      close,
    });

    await runMemoryCli(["status", "--verbose"]);

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    await expectCloseFailureAfterCommand({
      args: ["status"],
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      },
    });
  });

  it("reindexes on status --index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      probeEmbeddingAvailability,
      sync,
      status: () => makeMemoryStatus({ files: 1, chunks: 1 }),
      close,
    });

    spyRuntimeLogs();
    await runMemoryCli(["status", "--index"]);

    expectCliSync(sync);
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ sync, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expectCliSync(sync);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("initializes memory store", async () => {
    const close = vi.fn(async () => {});
    const initStore = vi.fn(async () => {});
    mockManager({ initStore, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["init-store"]);

    expectCliInitStore(initStore);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory store initialized (main).");
  });

  it("bootstraps memory store by initializing then indexing", async () => {
    const close = vi.fn(async () => {});
    const initStore = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    mockManager({ initStore, sync, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["bootstrap-store"]);

    expectCliInitStore(initStore);
    expectCliSync(sync);
    expect(initStore.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory store initialized (main).");
    expect(log).toHaveBeenCalledWith("Memory index updated (main).");
  });

  it("repairs memory store", async () => {
    const close = vi.fn(async () => {});
    const repairStore = vi.fn(async () => {});
    mockManager({ repairStore, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["repair-store"]);

    expectCliRepairStore(repairStore);
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory store repaired (main).");
  });

  it("reports when backend does not support repair-store", async () => {
    const close = vi.fn(async () => {});
    mockManager({ close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["repair-store"]);

    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory backend does not support store repair.");
  });

  it("logs qmd index file path and size after index", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("sqlite-bytes", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const log = spyRuntimeLogs();
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("QMD index: "));
      expect(log).toHaveBeenCalledWith("Memory index updated (main).");
      expect(close).toHaveBeenCalled();
    });
  });

  it("fails index when qmd db file is empty", async () => {
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    await withQmdIndexDb("", async (dbPath) => {
      mockManager({ sync, status: () => ({ backend: "qmd", dbPath }), close });

      const error = spyRuntimeErrors();
      await runMemoryCli(["index"]);

      expectCliSync(sync);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Memory index failed (main): QMD index file is empty"),
      );
      expect(close).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  it("logs close failures without failing the command", async () => {
    const sync = vi.fn(async () => {});
    await expectCloseFailureAfterCommand({
      args: ["index"],
      manager: { sync },
      beforeExpect: () => {
        expectCliSync(sync);
      },
    });
  });

  it("logs close failure after search", async () => {
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    await expectCloseFailureAfterCommand({
      args: ["search", "hello"],
      manager: { search },
      beforeExpect: () => {
        expect(search).toHaveBeenCalled();
      },
    });
  });

  it("closes manager after search error", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    mockManager({ search, close });

    const error = spyRuntimeErrors();
    await runMemoryCli(["search", "oops"]);

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });

  it("prints status json output when requested", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      probeVectorAvailability: vi.fn(async () => true),
      status: () => makeMemoryStatus({ workspaceDir: undefined }),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload)).toBe(true);
    expect((payload[0] as Record<string, unknown>)?.agentId).toBe("main");
    expect(close).toHaveBeenCalled();
  });

  it("scans workspace memory files in status json output", async () => {
    await withTempOpenClawHome(async ({ workspaceDir }) => {
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Root memory\n", "utf-8");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "facts.md"), "# Facts\n", "utf-8");

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir, files: 2, chunks: 2 }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["status", "--json"]);

      const payload = firstLoggedJson(log) as unknown as Array<Record<string, unknown>>;
      const first = payload[0] ?? {};
      const scan = first.scan as Record<string, unknown> | undefined;
      expect(scan?.totalFiles).toBe(2);
      expect(scan?.issues).toEqual([]);
      expect(close).toHaveBeenCalled();
    });
  });

  it("applies exclude globs when scanning workspace memory files in status json output", async () => {
    await withTempOpenClawHome(async ({ workspaceDir }) => {
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Root memory\n", "utf-8");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "memory", "facts.md"), "# Facts\n", "utf-8");
      await fs.writeFile(
        path.join(workspaceDir, "memory", "agent-security-policy.md"),
        "# Security\n",
        "utf-8",
      );

      loadConfig.mockImplementation(() => ({
        agents: {
          defaults: {
            workspace: workspaceDir,
            memorySearch: {
              excludeGlobs: ["**/*-security-policy.md"],
            },
          },
        },
      }));

      const close = vi.fn(async () => {});
      mockManager({
        probeVectorAvailability: vi.fn(async () => true),
        status: () => makeMemoryStatus({ workspaceDir, files: 2, chunks: 2 }),
        close,
      });

      const log = spyRuntimeLogs();
      await runMemoryCli(["status", "--json"]);

      const payload = firstLoggedJson(log) as unknown as Array<Record<string, unknown>>;
      const first = payload[0] ?? {};
      const scan = first.scan as Record<string, unknown> | undefined;
      expect(scan?.totalFiles).toBe(2);
      expect(scan?.issues).toEqual([]);
      expect(close).toHaveBeenCalled();
    });
  });

  it("logs default message when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValueOnce({ manager: null });

    const log = spyRuntimeLogs();
    await runMemoryCli(["status"]);

    expect(log).toHaveBeenCalledWith("Memory search disabled.");
  });

  it("logs backend unsupported message when index has no sync", async () => {
    const close = vi.fn(async () => {});
    mockManager({
      status: () => makeMemoryStatus(),
      close,
    });

    const log = spyRuntimeLogs();
    await runMemoryCli(["index"]);

    expect(log).toHaveBeenCalledWith("Memory backend does not support manual reindex.");
    expect(close).toHaveBeenCalled();
  });

  it("prints no matches for empty search results", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => []);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello"]);

    expect(search).toHaveBeenCalledWith("hello", {
      maxResults: undefined,
      minScore: undefined,
    });
    expect(log).toHaveBeenCalledWith("No matches.");
    expect(close).toHaveBeenCalled();
  });

  it("prints search results as json when requested", async () => {
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    mockManager({ search, close });

    const log = spyRuntimeLogs();
    await runMemoryCli(["search", "hello", "--json"]);

    const payload = firstLoggedJson(log);
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results as unknown[]).toHaveLength(1);
    expect(close).toHaveBeenCalled();
  });
});
