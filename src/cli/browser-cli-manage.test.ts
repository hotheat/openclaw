import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_parent: unknown, request: { path?: string; query?: { profile?: string } }) => {
      if (request.path === "/") {
        return {
          profile: request.query?.profile ?? "openclaw",
          running: true,
        };
      }
      return { ok: true };
    },
  ),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

let registerBrowserManageCommands: typeof import("./browser-cli-manage.js").registerBrowserManageCommands;

describe("browser manage CLI", () => {
  beforeEach(async () => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
    ({ registerBrowserManageCommands } = await import("./browser-cli-manage.js"));
  });

  async function runBrowser(args: string[]) {
    const program = new Command();
    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile")
      .option("--json", "JSON output", false);
    const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;
    registerBrowserManageCommands(browser, parentOpts);
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  it.each([
    { command: "start", path: "/start" },
    { command: "stop", path: "/stop" },
  ])("uses a 15s request timeout for browser $command", async ({ command, path }) => {
    await runBrowser(["--browser-profile", "work", command]);

    expect(mocks.callBrowserRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        path,
        query: { profile: "work" },
      }),
      { timeoutMs: 15000 },
    );
  });
});
