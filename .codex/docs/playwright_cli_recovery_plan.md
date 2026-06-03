# Playwright CLI Browser Recovery Plan

## Summary

This plan addresses leaked Chrome processes caused by `playwright-cli` sessions in
OpenClaw workspaces. It does not target Docker-owned Chromium containers,
OpenClaw sandbox browser containers, desktop Chrome, or unrelated browser
processes.

The recovery model has two layers:

- An OpenClaw CLI maintenance command that can list and reap stale
  `playwright-cli` browser sessions.
- A `playwright-cli` skill hardening pass that makes normal skill usage close
  and recover its own session automatically.

Default stale threshold: 2 hours.

## Process Sources And Scope

Targeted sources:

- Class 1: OpenClaw-named `playwright-cli` daemon sessions.
  - Daemon command contains `playwright-core/lib/tools/cli-daemon/program.js`.
  - Session name matches OpenClaw routing scope, such as `feishu-group-oc_*`,
    `feishu-ou_*`, or `group-oc_*`.
  - Chrome descendants use `/tmp/playwright_chromiumdev_profile-*`.
- Class 2: Non-standard `playwright-cli` daemon sessions owned by OpenClaw work.
  - Ownership evidence must include a dedicated OpenClaw Playwright owner marker
    and a `PW_SESSION` value that exactly matches the daemon session.
  - Ambient `OPENCLAW_*`, `CLAWDBOT_*`, workspace cwd, or generic `PW_SESSION`
    presence is not sufficient ownership proof.
  - Generic session names such as `default`, `browser`, `main`, `test`, and
    `session1` must not become Class 2 solely through built-in name matching.
- Class 3: Playwright Chrome crashpad handlers.
  - Only clean crashpad handlers captured from a target Playwright Chrome tree.
  - Only terminate them after confirming no live Chrome process still references
    the handler with `--crashpad-handler-pid=<pid>`.

Explicitly excluded:

- Docker-owned `/usr/lib/chromium` processes, including the long-running
  container that exposes CDP on port 9222.
- OpenClaw sandbox browser containers.
- Desktop Chrome or user-launched browser processes.
- Any daemon/session that cannot be tied back to OpenClaw work.

## OpenClaw CLI Recovery Mechanism

Add a maintenance surface under the browser CLI:

```text
openclaw browser playwright list [--json]
openclaw browser playwright reap [--stale-after 2h] [--dry-run] [--force] [--json]
```

Platform scope:

- The initial implementation is Linux-host only because process discovery and
  tree cleanup depend on `/proc`.
- Process age calculation must resolve Linux `CLK_TCK` dynamically, such as via
  `getconf CLK_TCK`. If that value is unavailable, the command must list the
  session with unknown age and skip age-based reaping for it.
- On non-Linux hosts, the command must return a clear unsupported-platform
  error instead of silently reporting an empty result.
- A cross-platform process-discovery abstraction can be added later before
  broadening this command's platform contract.

Behavior:

- `list` reports each detected `playwright-cli` daemon with session, pid, cwd,
  age, Chrome child count, crashpad count, classification, and classification
  reason.
- `reap` defaults to dry-run unless `--force` is supplied.
- `reap` only targets stale Class 1 and Class 2 sessions.
- `reap` must read persisted keep-open leases and skip sessions with an
  unexpired lease.
- The implementation must not call `playwright-cli close-all` or
  `playwright-cli kill-all`.

Reap sequence for each target session:

1. Run `playwright-cli -s=<session> close`.
2. Wait up to 10 seconds and rescan `/proc`.
3. If the daemon or Playwright-profile Chrome descendants remain, send
   `SIGTERM` only to the target daemon subtree.
4. Wait up to 5 seconds and then send `SIGKILL` only to still-live target PIDs.
5. Recheck captured crashpad handlers and terminate only handlers that are now
   orphaned and no longer referenced by any live Chrome process.
6. Return a non-zero exit code if any target PID remains alive.

Audit output should include:

- Total daemon sessions found.
- Total sessions eligible for reaping.
- Total Chrome descendants targeted.
- Total crashpad handlers targeted.
- Explicit skipped entries with reasons.
- Keep-open lease metadata for leased sessions, including expiry and whether
  the lease is expired.

## Keep-Open Lease Contract

`--keep-open` and `PW_KEEP_OPEN=1` are only valid for deliberate long-lived
login sessions when they create or renew a persisted lease.

Lease files live under:

```text
~/.openclaw/state/playwright-cli/leases/
```

Each lease must include:

- `session`: the exact `playwright-cli` session name.
- `keepOpen: true`.
- `expiresAt`: ISO timestamp, or equivalent timestamp field, used by the CLI
  reaper.
- Optional `createdAt`, `updatedAt`, `workspace`, and `reason` fields for
  auditability.

The CLI reaper contract:

- `list` includes the session and reports the lease state.
- `reap` excludes sessions with an unexpired lease from target eligibility.
- Expired leases do not protect a session from stale cleanup.
- Malformed or disabled lease files are ignored and must not make recovery
  unsafe.
- If duplicate lease files exist for one session, the lease with the latest
  expiry is authoritative.

## Skill-Level Auto Recovery

Harden `~/.openclaw/workspace/skills/playwright-cli/` so normal browser work is
more likely to self-clean even when the task fails.

Recommended changes:

- Enhance `scripts/pw_session_env.sh`.
  - Continue exporting `PW_USER_SCOPE`, `PW_TASK_SCOPE`, `PW_SESSION`,
    `PW_OUTPUT_DIR`, `PW_DOWNLOAD_DIR`, and `PW_STATE_DIR`.
  - Also export the dedicated OpenClaw Playwright owner marker used by the CLI
    recovery classifier.
  - Also emit shell code that installs `EXIT`, `INT`, and `TERM` traps.
  - The trap should run `playwright-cli -s="$PW_SESSION" close` and then call a
    session-scoped cleanup helper.
  - Add `--keep-open` and `PW_KEEP_OPEN=1` as explicit opt-outs for deliberate
    long-lived login sessions, and write or renew the persisted keep-open lease.
- Add `scripts/pw_session_cleanup.sh`.
  - Accept only one session at a time.
  - Close the session first, then inspect `/proc` and clean only that session's
    daemon subtree and safe orphan crashpad handlers.
  - Support `--dry-run` for debugging.
- Add `scripts/pw_session_run.sh`.
  - Usage:

    ```bash
    skills/playwright-cli/scripts/pw_session_run.sh \
      --task-scope patentscope \
      -- bash -lc 'playwright-cli -s="$PW_SESSION" open https://example.com'
    ```

  - This wrapper keeps session setup, browser commands, and trap cleanup in one
    shell lifecycle.

- Update `SKILL.md` and `references/session-management.md`.
  - Make `pw_session_run.sh` the preferred workflow for multi-step browser work.
  - Keep same-shell `eval "$(pw_session_env.sh ...)"` as the lower-level
    alternative.
  - Remove or rewrite examples that call `playwright-cli open <url>` without
    `-s="$PW_SESSION"`.
  - Document `--keep-open` as an exception, not the default.

## Prevention Policy

Rules the skill and CLI should enforce or report:

- Never use the implicit `default` session for OpenClaw multi-user work.
- Never reuse a generic session name such as `browser`, `main`, `test`, or
  `session1`.
- Always derive session names from `<user-scope>-<task-scope>`.
- Always put artifacts under the current workspace.
- Never use global Playwright teardown commands in normal user flows.
- Surface `default` session usage as a policy violation in `list` output.

## Test Plan

Unit tests:

- Classify OpenClaw-named sessions as Class 1.
- Classify non-standard sessions as Class 2 only when they have the dedicated
  OpenClaw Playwright owner marker and matching `PW_SESSION`.
- Keep `default` and other generic sessions skipped from Class 2 even when they
  have ambient OpenClaw environment variables.
- Do not classify sessions as Class 2 from ambient `OPENCLAW_*`, `CLAWDBOT_*`,
  workspace cwd, or generic `PW_SESSION` evidence alone.
- Compute `/proc` process ages with the resolved `CLK_TCK` value.
- Keep sessions with unknown age ineligible for stale reaping.
- Ignore Docker Chromium, sandbox browser containers, desktop Chrome, and
  unrelated Chrome processes.
- Identify crashpad handlers only when associated with a target Playwright tree.
- Refuse to clean crashpad handlers still referenced by live Chrome processes.
- Verify dry-run performs no close or kill operations.

CLI tests:

- `openclaw browser playwright list --json` outputs daemon classification,
  counts, and skip reasons.
- `openclaw browser playwright list --json` reports keep-open lease metadata
  for leased sessions.
- `openclaw browser playwright reap --dry-run` reports exact target sessions and
  PIDs.
- `openclaw browser playwright reap --force` performs close, targeted
  termination, crashpad cleanup, and returns non-zero on leftovers.
- `openclaw browser playwright reap --force` lists but does not close or kill
  sessions with an unexpired keep-open lease.
- Expired keep-open leases no longer protect otherwise eligible stale sessions.
- Non-Linux hosts return a clear unsupported-platform error.

Skill helper tests:

- `pw_session_env.sh --task-scope x` emits session exports and cleanup trap.
- `pw_session_env.sh --keep-open --task-scope x` emits exports without an
  auto-close trap and writes or renews a persisted keep-open lease.
- Generic session scopes remain rejected.
- `pw_session_run.sh` runs commands with `PW_SESSION` available and triggers
  cleanup on normal exit, command failure, and interrupt.
- `pw_session_cleanup.sh --dry-run` reports only the requested session and the
  matching lease deletion.
- `pw_session_cleanup.sh --preserve-lease` keeps the matching lease only when a
  manual cleanup intentionally leaves the long-lived session exempt.

Manual acceptance:

- Current stale OpenClaw-named Playwright sessions are listed with their target
  status, and generic or unmarked non-standard sessions are skipped.
- Docker-owned Chromium processes on port 9222 are skipped.
- After forced reap, targeted sessions no longer appear as open in
  `playwright-cli list`.
- Playwright-profile Chrome and associated orphan crashpad handler counts drop.
- A new browser task executed through `pw_session_run.sh` closes its session
  automatically after completion.

## Rollout

1. Land the CLI classifier and dry-run command first.
2. Validate dry-run output on the current host.
3. Enable `reap --force` for one known stale session and verify targeted cleanup.
4. Add the skill helper changes and update examples.
5. Run the helper workflow on a small browser task and confirm automatic cleanup.
6. Add an optional systemd timer or gateway maintenance job that runs:

   ```bash
   openclaw browser playwright reap --stale-after 2h --force
   ```

   The scheduled job should log JSON output for auditability.

## Assumptions

- The default automatic stale threshold is 2 hours.
- Browser recovery is Linux-host only until a cross-platform process-discovery
  abstraction is added.
- The primary implementation lives in OpenClaw CLI; the skill hardening prevents
  new leaks but does not replace the CLI reaper.
- Long-lived sessions are allowed only with explicit `--keep-open` or
  `PW_KEEP_OPEN=1` that writes or renews a persisted keep-open lease.
- Global `playwright-cli close-all` and `playwright-cli kill-all` remain
  owner-approved maintenance tools, not normal user-task cleanup paths.
