import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  buildPlaywrightRecoveryReport,
  formatPlaywrightRecoveryText,
  loadPlaywrightKeepOpenLeases,
  parseDurationMs,
  reapPlaywrightSessions,
  scanProcPlaywrightEntries,
  type PlaywrightRecoveryDeps,
} from "./browser-playwright-recovery.js";
import { runCommandWithRuntime } from "./cli-utils.js";

type PlaywrightCliDeps = PlaywrightRecoveryDeps;

function commandTreeHasJson(cmd: Command | undefined): boolean {
  let current: Command | undefined = cmd;
  while (current) {
    if (current.opts?.().json === true) {
      return true;
    }
    current = current.parent ?? undefined;
  }
  return false;
}

function shouldUseJson(cmd: Command, parent?: BrowserParentOpts, localJson?: boolean): boolean {
  return localJson === true || commandTreeHasJson(cmd) || parent?.json === true;
}

function runPlaywrightCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerBrowserPlaywrightCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  deps: PlaywrightCliDeps = {},
) {
  const playwright = browser
    .command("playwright")
    .description("List and reap stale playwright-cli browser sessions")
    .action((_opts, cmd) => {
      cmd.outputHelp();
      defaultRuntime.exit(1);
    });

  playwright
    .command("list")
    .description("List detected playwright-cli daemon sessions")
    .option("--json", "Output machine-readable JSON", false)
    .option("--stale-after <duration>", "Stale threshold (default: 2h)", "2h")
    .action(async (opts: { json?: boolean; staleAfter?: string }, cmd) => {
      await runPlaywrightCommand(async () => {
        const staleAfterMs = parseDurationMs(opts.staleAfter, 2 * 60 * 60 * 1000);
        const [processes, keepOpenLeases] = await Promise.all([
          (deps.scan ?? scanProcPlaywrightEntries)(),
          deps.keepOpenLeases
            ? Promise.resolve(deps.keepOpenLeases)
            : (deps.loadKeepOpenLeases ?? loadPlaywrightKeepOpenLeases)(),
        ]);
        const nowSource = deps.nowMs;
        const nowMs = typeof nowSource === "function" ? nowSource() : nowSource;
        const report = buildPlaywrightRecoveryReport({
          processes,
          keepOpenLeases,
          staleAfterMs,
          nowMs,
        });
        if (shouldUseJson(cmd, parentOpts(cmd), opts.json)) {
          defaultRuntime.log(JSON.stringify(report, null, 2));
          return;
        }
        defaultRuntime.log(formatPlaywrightRecoveryText(report));
      });
    });

  playwright
    .command("reap")
    .description("Close and terminate stale playwright-cli daemon sessions")
    .option("--stale-after <duration>", "Stale threshold (default: 2h)", "2h")
    .option("--dry-run", "Show targets without closing or killing", false)
    .option("--force", "Perform targeted close and termination", false)
    .option("--json", "Output machine-readable JSON", false)
    .action(
      async (
        opts: { staleAfter?: string; dryRun?: boolean; force?: boolean; json?: boolean },
        cmd,
      ) => {
        await runPlaywrightCommand(async () => {
          const staleAfterMs = parseDurationMs(opts.staleAfter, 2 * 60 * 60 * 1000);
          const result = await reapPlaywrightSessions({
            ...deps,
            staleAfterMs,
            dryRun: opts.dryRun,
            force: opts.force,
          });
          if (shouldUseJson(cmd, parentOpts(cmd), opts.json)) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(formatPlaywrightRecoveryText(result));
          }
          if (!result.ok) {
            defaultRuntime.exit(1);
          }
        });
      },
    );
}
