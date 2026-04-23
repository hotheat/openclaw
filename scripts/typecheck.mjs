#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const maxOldSpaceSizeMb = Number.parseInt(
  process.env.OPENCLAW_TYPECHECK_MAX_OLD_SPACE_SIZE_MB ?? "6144",
  10,
);

const tscEntrypoint = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

const child = spawn(
  process.execPath,
  [
    `--max-old-space-size=${Number.isFinite(maxOldSpaceSizeMb) ? maxOldSpaceSizeMb : 6144}`,
    tscEntrypoint,
    "--noEmit",
    "-p",
    "tsconfig.json",
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(
    "[typecheck] Failed to start tsc:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
