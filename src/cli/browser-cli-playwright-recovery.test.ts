import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

import { registerBrowserPlaywrightCommands } from "./browser-cli-playwright.js";
import {
  buildPlaywrightRecoveryReport,
  type PlaywrightProcEntry,
  loadPlaywrightKeepOpenLeases,
  reapPlaywrightSessions,
  resolvePlaywrightKeepOpenLeasePath,
  scanProcPlaywrightEntries,
} from "./browser-playwright-recovery.js";

function proc(params: Partial<PlaywrightProcEntry> & { pid: number }): PlaywrightProcEntry {
  return {
    pid: params.pid,
    ppid: params.ppid ?? 1,
    cmdline: params.cmdline ?? [],
    cwd: params.cwd,
    env: params.env ?? {},
    startTimeMs: params.startTimeMs ?? 0,
  };
}

describe("playwright-cli recovery classifier", () => {
  const daemon = (session: string, extra?: Partial<PlaywrightProcEntry>) =>
    proc({
      pid: extra?.pid ?? 100,
      ppid: extra?.ppid ?? 1,
      cmdline: [
        "node",
        "/repo/node_modules/playwright-core/lib/tools/cli-daemon/program.js",
        `-s=${session}`,
      ],
      cwd: extra?.cwd,
      env: extra?.env,
      startTimeMs: extra?.startTimeMs ?? 0,
    });
  const chrome = (pid: number, ppid = 100, extraCmdline: string[] = []) =>
    proc({
      pid,
      ppid,
      cmdline: [
        "chrome",
        "--user-data-dir=/tmp/playwright_chromiumdev_profile-abc",
        ...extraCmdline,
      ],
    });
  const crashpad = (pid: number, ppid = 101) =>
    proc({
      pid,
      ppid,
      cmdline: ["chrome_crashpad_handler", "--type=crashpad-handler"],
    });

  it("classifies OpenClaw-named daemon sessions as class1 and counts browser descendants", () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [
        daemon("feishu-group-oc_abc"),
        proc({
          pid: 101,
          ppid: 100,
          cmdline: ["chrome", "--user-data-dir=/tmp/playwright_chromiumdev_profile-abc"],
        }),
        proc({
          pid: 102,
          ppid: 101,
          cmdline: ["chrome_crashpad_handler", "--type=crashpad-handler"],
        }),
      ],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
    });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      session: "feishu-group-oc_abc",
      classification: "class1",
      eligible: true,
      chromeChildCount: 1,
      crashpadCount: 1,
    });
    expect(report.eligibleCount).toBe(1);
  });

  it("classifies positional playwright daemon sessions as class1", () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [
        proc({
          pid: 100,
          cmdline: [
            "node",
            "/repo/node_modules/playwright-core/lib/tools/cli-daemon/program.js",
            "feishu-ou_user-login",
          ],
        }),
      ],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
    });

    expect(report.sessions[0]).toMatchObject({
      session: "feishu-ou_user-login",
      classification: "class1",
      eligible: true,
    });
    expect(report.eligibleCount).toBe(1);
  });

  it("does not treat ambient OpenClaw env as class2 ownership evidence", () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [
        daemon("default", {
          cwd: "/home/xiaolu/.openclaw/workspace/agents/main",
          env: {
            OPENCLAW_HOME: "/home/xiaolu/.openclaw",
            OPENCLAW_GATEWAY_URL: "http://127.0.0.1:3000",
            PW_SESSION: "default",
          },
        }),
        daemon("lilly-ir-real-links", {
          pid: 200,
          cwd: "/tmp/unrelated",
          env: {
            OPENCLAW_STATE_DIR: "/home/xiaolu/.openclaw/state",
            PW_SESSION: "lilly-ir-real-links",
          },
        }),
        daemon("random-browser", {
          pid: 300,
          cwd: "/tmp/unrelated",
          env: {
            OPENCLAW_HOME: "/home/xiaolu/.openclaw",
            PW_SESSION: "random-browser",
          },
        }),
      ],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
    });

    expect(report.sessions).toHaveLength(3);
    expect(report.sessions[0]).toMatchObject({
      session: "default",
      classification: "skipped",
      policyViolation: "implicit-default-session",
      eligible: false,
    });
    expect(report.sessions[1]).toMatchObject({
      session: "lilly-ir-real-links",
      classification: "skipped",
      eligible: false,
    });
    expect(report.sessions[2]).toMatchObject({
      session: "random-browser",
      classification: "skipped",
      eligible: false,
    });
  });

  it("classifies only explicitly marked helper-owned non-standard sessions as class2", () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [
        daemon("workspace-search", {
          env: {
            OPENCLAW_PLAYWRIGHT_SESSION_OWNER: "openclaw",
            PW_SESSION: "workspace-search",
          },
        }),
        daemon("workspace-mismatch", {
          pid: 200,
          env: {
            OPENCLAW_PLAYWRIGHT_SESSION_OWNER: "openclaw",
            PW_SESSION: "other-session",
          },
        }),
        daemon("default", {
          pid: 300,
          env: {
            OPENCLAW_PLAYWRIGHT_SESSION_OWNER: "openclaw",
            PW_SESSION: "default",
          },
        }),
      ],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
    });

    expect(report.sessions[0]).toMatchObject({
      session: "workspace-search",
      classification: "class2",
      eligible: true,
    });
    expect(report.sessions[1]).toMatchObject({
      session: "workspace-mismatch",
      classification: "skipped",
      eligible: false,
    });
    expect(report.sessions[2]).toMatchObject({
      session: "default",
      classification: "skipped",
      eligible: false,
      policyViolation: "implicit-default-session",
    });
  });

  it("classifies OpenClaw workspace cwd daemon sessions as class3", () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [
        daemon("lilly-ir-real-links", {
          cwd: path.join(os.homedir(), ".openclaw", "workspace-feishu-ou_user"),
        }),
        daemon("recent-default", {
          pid: 200,
          cwd: path.join(os.homedir(), ".openclaw", "workspace-feishu-group-oc_room"),
          startTimeMs: 3 * 60 * 60 * 1000,
        }),
        daemon("default-workspace", {
          pid: 300,
          cwd: path.join(os.homedir(), ".openclaw", "workspace"),
        }),
        daemon("default", {
          pid: 400,
          cwd: path.join(os.homedir(), ".openclaw", "workspace"),
        }),
      ],
      nowMs: 8 * 60 * 60 * 1000,
      staleAfterMs: 6 * 60 * 60 * 1000,
    });

    expect(report.sessions[0]).toMatchObject({
      session: "lilly-ir-real-links",
      classification: "class3",
      eligible: true,
    });
    expect(report.sessions[1]).toMatchObject({
      session: "recent-default",
      classification: "class3",
      eligible: false,
      skipReason: "session is not stale",
    });
    expect(report.sessions[2]).toMatchObject({
      session: "default-workspace",
      classification: "class3",
      eligible: true,
    });
    expect(report.sessions[3]).toMatchObject({
      session: "default",
      classification: "class3",
      eligible: false,
      policyViolation: "implicit-default-session",
      skipReason: "implicit-default-session",
    });
    expect(report.eligibleCount).toBe(2);
  });

  it("keeps dry-run from closing sessions or sending signals", async () => {
    const calls: string[] = [];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: false,
      dryRun: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => [
        daemon("feishu-ou_user", {
          startTimeMs: 0,
        }),
      ],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.dryRun).toBe(true);
    expect(result.targets.map((target) => target.session)).toEqual(["feishu-ou_user"]);
    expect(calls).toEqual([]);
  });

  it("throws a clear unsupported-platform error outside Linux proc hosts", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    try {
      await expect(scanProcPlaywrightEntries()).rejects.toThrow(
        "Playwright recovery is supported only on Linux hosts",
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(process, "platform", descriptor);
      }
    }
  });

  it("uses the resolved proc clock tick rate when computing process age", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proc-"));
    const pidDir = path.join(dir, "123");
    const cwd = path.join(dir, "workspace");
    await fs.mkdir(pidDir);
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(dir, "uptime"), "1000.00 0.00\n");
    await fs.writeFile(
      path.join(pidDir, "cmdline"),
      [
        "node",
        "/repo/node_modules/playwright-core/lib/tools/cli-daemon/program.js",
        "-s=feishu-ou_user",
      ].join("\0"),
    );
    await fs.writeFile(path.join(pidDir, "environ"), "");
    await fs.writeFile(
      path.join(pidDir, "stat"),
      `123 (node) ${["S", "1", ...Array(17).fill("0"), "125000"].join(" ")}\n`,
    );
    await fs.symlink(cwd, path.join(pidDir, "cwd"));

    const processes = await scanProcPlaywrightEntries(dir, {
      clockTicksPerSecond: async () => 250,
      nowMs: () => 2_000_000,
    });
    const report = buildPlaywrightRecoveryReport({
      processes,
      nowMs: 2_000_000,
      staleAfterMs: 400_000,
    });

    expect(processes[0]?.startTimeMs).toBe(1_500_000);
    expect(report.sessions[0]).toMatchObject({
      ageMs: 500_000,
      eligible: true,
    });
  });

  it("does not make age-based reap decisions when proc clock tick rate is unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proc-"));
    const pidDir = path.join(dir, "123");
    await fs.mkdir(pidDir);
    await fs.writeFile(path.join(dir, "uptime"), "1000.00 0.00\n");
    await fs.writeFile(
      path.join(pidDir, "cmdline"),
      [
        "node",
        "/repo/node_modules/playwright-core/lib/tools/cli-daemon/program.js",
        "-s=feishu-ou_user",
      ].join("\0"),
    );
    await fs.writeFile(path.join(pidDir, "environ"), "");
    await fs.writeFile(
      path.join(pidDir, "stat"),
      `123 (node) ${["S", "1", ...Array(17).fill("0"), "125000"].join(" ")}\n`,
    );

    const processes = await scanProcPlaywrightEntries(dir, {
      clockTicksPerSecond: async () => null,
      nowMs: () => 2_000_000,
    });
    const report = buildPlaywrightRecoveryReport({
      processes,
      nowMs: 2_000_000,
      staleAfterMs: 400_000,
    });

    expect(processes[0]?.startTimeMs).toBeUndefined();
    expect(report.sessions[0]).toMatchObject({
      ageMs: null,
      eligible: false,
      skipReason: "session is not stale",
    });
  });

  it("lists keep-open leased sessions but excludes them from reap targets", async () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [daemon("feishu-ou_user-login")],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
      keepOpenLeases: [
        {
          session: "feishu-ou_user-login",
          path: "/tmp/leases/feishu-ou_user-login.json",
          expiresAtMs: 4 * 60 * 60 * 1000,
        },
      ],
    });

    expect(report.sessions[0]).toMatchObject({
      session: "feishu-ou_user-login",
      eligible: false,
      skipReason: "keep-open-lease",
      keepOpenLease: {
        expired: false,
        path: "/tmp/leases/feishu-ou_user-login.json",
      },
    });
    expect(report.eligibleCount).toBe(0);
  });

  it("uses the longest keep-open lease when duplicate session leases are present", async () => {
    const report = buildPlaywrightRecoveryReport({
      processes: [daemon("feishu-ou_user-login")],
      nowMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 2 * 60 * 60 * 1000,
      keepOpenLeases: [
        {
          session: "feishu-ou_user-login",
          path: "/tmp/leases/active.json",
          expiresAtMs: 4 * 60 * 60 * 1000,
        },
        {
          session: "feishu-ou_user-login",
          path: "/tmp/leases/expired.json",
          expiresAtMs: 60 * 60 * 1000,
        },
      ],
    });

    expect(report.sessions[0]).toMatchObject({
      eligible: false,
      skipReason: "keep-open-lease",
      keepOpenLease: {
        expired: false,
        path: "/tmp/leases/active.json",
      },
    });
  });

  it("loads valid keep-open leases from disk and ignores malformed entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pw-leases-"));
    await fs.writeFile(
      path.join(dir, "valid.json"),
      JSON.stringify({
        session: "feishu-ou_user-login",
        keepOpen: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        workspace: "/workspace",
        reason: "login-session",
      }),
    );
    await fs.writeFile(path.join(dir, "malformed.json"), "{not-json");
    await fs.writeFile(
      path.join(dir, "disabled.json"),
      JSON.stringify({
        session: "feishu-ou_user-disabled",
        keepOpen: false,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    const leases = await loadPlaywrightKeepOpenLeases(dir);

    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      session: "feishu-ou_user-login",
      workspace: "/workspace",
      reason: "login-session",
    });
  });

  it("loads default keep-open leases from OPENCLAW_STATE_DIR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-pw-leases-"));
    const stateDir = path.join(root, "state");
    const leaseDir = path.join(stateDir, "playwright-cli", "leases");
    await fs.mkdir(leaseDir, { recursive: true });
    await fs.writeFile(
      path.join(leaseDir, "feishu-ou_user-login.json"),
      JSON.stringify({
        session: "feishu-ou_user-login",
        keepOpen: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_PLAYWRIGHT_LEASE_DIR: undefined,
      },
      async () => {
        const leases = await loadPlaywrightKeepOpenLeases();

        expect(resolvePlaywrightKeepOpenLeasePath("feishu-ou_user-login")).toBe(
          path.join(leaseDir, "feishu-ou_user-login.json"),
        );
        expect(leases).toHaveLength(1);
        expect(leases[0]).toMatchObject({
          path: path.join(leaseDir, "feishu-ou_user-login.json"),
          session: "feishu-ou_user-login",
        });
      },
    );
  });

  it("keeps OPENCLAW_PLAYWRIGHT_LEASE_DIR as the explicit lease-dir override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pw-lease-override-"));
    const stateDir = path.join(root, "state");
    const overrideDir = path.join(root, "leases");
    await fs.mkdir(overrideDir, { recursive: true });

    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: stateDir,
        CLAWDBOT_STATE_DIR: undefined,
        OPENCLAW_PLAYWRIGHT_LEASE_DIR: overrideDir,
      },
      async () => {
        expect(resolvePlaywrightKeepOpenLeasePath("feishu-ou_user-login")).toBe(
          path.join(overrideDir, "feishu-ou_user-login.json"),
        );
      },
    );
  });

  it("does not close or kill keep-open leased sessions during force reap", async () => {
    const calls: string[] = [];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      keepOpenLeases: [
        {
          session: "feishu-ou_user-login",
          path: "/tmp/leases/feishu-ou_user-login.json",
          expiresAtMs: 4 * 60 * 60 * 1000,
        },
      ],
      scan: async () => [daemon("feishu-ou_user-login")],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.targets).toEqual([]);
    expect(result.sessions[0]?.skipReason).toBe("keep-open-lease");
    expect(calls).toEqual([]);
  });

  it("reaps sessions whose keep-open lease is expired", async () => {
    const calls: string[] = [];
    const scans = [[daemon("feishu-ou_user-login")], [daemon("feishu-ou_user-login")], [], []];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      keepOpenLeases: [
        {
          session: "feishu-ou_user-login",
          path: "/tmp/leases/feishu-ou_user-login.json",
          expiresAtMs: 60 * 60 * 1000,
        },
      ],
      scan: async () => scans.shift() ?? [],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.targets[0]).toMatchObject({
      session: "feishu-ou_user-login",
      termPids: [100],
    });
    expect(calls).toContain("close:feishu-ou_user-login");
  });

  it("continues targeted cleanup when playwright close fails", async () => {
    const calls: string[] = [];
    const scans = [
      [daemon("feishu-ou_user"), chrome(101)],
      [daemon("feishu-ou_user"), chrome(101)],
      [daemon("feishu-ou_user"), chrome(101)],
      [],
      [],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
        throw new Error("close failed");
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.targets[0]).toMatchObject({
      closeError: "Error: close failed",
      termPids: [100, 101],
      killPids: [100, 101],
      remainingPids: [],
    });
    expect(calls).toEqual([
      "close:feishu-ou_user",
      "sleep:10000",
      "kill:100:SIGTERM",
      "kill:101:SIGTERM",
      "sleep:5000",
      "kill:100:SIGKILL",
      "kill:101:SIGKILL",
    ]);
  });

  it("targets Playwright-profile Chrome descendants discovered after close", async () => {
    const calls: string[] = [];
    const scans = [
      [daemon("feishu-ou_user")],
      [daemon("feishu-ou_user"), chrome(201)],
      [daemon("feishu-ou_user"), chrome(201)],
      [],
      [],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.targets[0]).toMatchObject({
      termPids: [100, 201],
      killPids: [100, 201],
      remainingPids: [],
    });
    expect(calls).toContain("kill:201:SIGTERM");
    expect(calls).toContain("kill:201:SIGKILL");
  });

  it("does not terminate crashpad handlers still referenced by live chrome", async () => {
    const calls: string[] = [];
    const scans = [
      [daemon("feishu-ou_user"), chrome(101), crashpad(102)],
      [],
      [],
      [crashpad(102), chrome(103, 1, ["--crashpad-handler-pid=102"])],
      [crashpad(102), chrome(103, 1, ["--crashpad-handler-pid=102"])],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.targets[0]?.crashpadTermPids).toEqual([]);
    expect(result.targets[0]?.remainingPids).toEqual([]);
    expect(calls).not.toContain("kill:102:SIGTERM");
    expect(calls).not.toContain("kill:102:SIGKILL");
  });

  it("terminates only orphaned crashpad handlers without escalating to SIGKILL", async () => {
    const calls: string[] = [];
    const scans = [
      [daemon("feishu-ou_user"), chrome(101), crashpad(102)],
      [],
      [],
      [crashpad(102)],
      [],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async (session) => {
        calls.push(`close:${session}`);
      },
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async (ms) => {
        calls.push(`sleep:${ms}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.targets[0]?.crashpadTermPids).toEqual([102]);
    expect(calls).toContain("kill:102:SIGTERM");
    expect(calls).not.toContain("kill:102:SIGKILL");
    expect(calls).toContain("sleep:500");
  });

  it("does not treat non-Chrome crashpad pid mentions as live references", async () => {
    const calls: string[] = [];
    const scans = [
      [daemon("feishu-ou_user"), chrome(101), crashpad(102)],
      [],
      [],
      [crashpad(102), proc({ pid: 300, cmdline: ["node", "--crashpad-handler-pid=102"] })],
      [],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async () => {},
      kill: async (pid, signal) => {
        calls.push(`kill:${pid}:${signal}`);
      },
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.targets[0]?.crashpadTermPids).toEqual([102]);
    expect(calls).toContain("kill:102:SIGTERM");
  });

  it("reports failure when target daemon or chrome PIDs remain alive", async () => {
    const scans = [
      [daemon("feishu-ou_user"), chrome(101)],
      [daemon("feishu-ou_user"), chrome(101)],
      [daemon("feishu-ou_user"), chrome(101)],
      [daemon("feishu-ou_user")],
      [daemon("feishu-ou_user")],
    ];
    const result = await reapPlaywrightSessions({
      staleAfterMs: 2 * 60 * 60 * 1000,
      force: true,
      nowMs: 3 * 60 * 60 * 1000,
      scan: async () => scans.shift() ?? [],
      closeSession: async () => {},
      kill: async () => {},
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.targets[0]?.remainingPids).toEqual([100]);
  });
});

describe("browser playwright CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints list JSON with classification data", async () => {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON", false);
    registerBrowserPlaywrightCommands(browser, () => ({}), {
      scan: async () => [
        proc({
          pid: 300,
          cmdline: [
            "node",
            "/repo/node_modules/playwright-core/lib/tools/cli-daemon/program.js",
            "-s=feishu-ou_user",
          ],
          startTimeMs: 0,
        }),
      ],
      nowMs: () => 3 * 60 * 60 * 1000,
    });

    await program.parseAsync(["browser", "playwright", "list", "--json"], { from: "user" });

    expect(mocks.runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0]));
    expect(payload.sessions[0]).toMatchObject({
      session: "feishu-ou_user",
      classification: "class1",
    });
  });
});
