#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const extensionIds = ["subagent-handoff-output-guard", "tool-error-latch", "tool-request-guard"];
const rootDir = process.cwd();
const testFiles = [];

for (const extensionId of extensionIds) {
  const testDir = path.join(rootDir, "extensions", extensionId, "test");
  const entries = await readdir(testDir);
  for (const entry of entries.toSorted()) {
    if (entry.endsWith(".test.cjs")) {
      testFiles.push(path.join(testDir, entry));
    }
  }
}

if (testFiles.length === 0) {
  throw new Error("No runtime guard extension tests found");
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: rootDir,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
