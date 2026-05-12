import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "tinyglobby";

const usage = "Usage: node scripts/run-test-fast-shard.mjs <index>/<count> [--list]";

const shardArg = process.argv[2];
if (!shardArg || !/^\d+\/\d+$/.test(shardArg)) {
  console.error(usage);
  process.exit(1);
}

const [indexRaw, countRaw] = shardArg.split("/");
const shardIndex = Number.parseInt(indexRaw ?? "", 10);
const shardCount = Number.parseInt(countRaw ?? "", 10);
if (
  !Number.isInteger(shardIndex) ||
  !Number.isInteger(shardCount) ||
  shardIndex < 1 ||
  shardIndex > shardCount
) {
  console.error(usage);
  process.exit(1);
}

const repoRoot = process.cwd();
const configUrl = pathToFileURL(path.resolve(repoRoot, "vitest.unit.config.ts")).href;
const configModule = await import(configUrl);
const testConfig = configModule.default?.test ?? {};
const include = Array.isArray(testConfig.include) ? testConfig.include : [];
const exclude = Array.isArray(testConfig.exclude) ? testConfig.exclude : [];

const matchedFiles = await glob(include, {
  cwd: repoRoot,
  ignore: exclude,
  onlyFiles: true,
});

const uniqueFiles = [...new Set(matchedFiles)].toSorted((a, b) => a.localeCompare(b));
const weightedFiles = await Promise.all(
  uniqueFiles.map(async (file) => ({
    file,
    size: (await fs.stat(path.resolve(repoRoot, file))).size,
  })),
);

// Greedy bin-packing gives more balanced shards than raw lexical slicing.
weightedFiles.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
const shards = Array.from({ length: shardCount }, () => ({ totalSize: 0, files: [] }));
for (const entry of weightedFiles) {
  let lightest = shards[0];
  for (const shard of shards) {
    if (shard.totalSize < lightest.totalSize) {
      lightest = shard;
    }
  }
  lightest.files.push(entry.file);
  lightest.totalSize += entry.size;
}

for (const shard of shards) {
  shard.files.sort((a, b) => a.localeCompare(b));
}

const selected = shards[shardIndex - 1]?.files ?? [];
if (selected.length === 0) {
  console.error(`Shard ${shardArg} resolved to zero test files`);
  process.exit(1);
}

if (process.argv.includes("--list")) {
  const shardStats = shards.map((shard, idx) => ({
    shard: `${idx + 1}/${shardCount}`,
    fileCount: shard.files.length,
    totalSize: shard.totalSize,
  }));
  console.log(
    JSON.stringify(
      {
        shard: shardArg,
        selectedFileCount: selected.length,
        shardStats,
        files: selected,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const vitestArgs = [
  "exec",
  "vitest",
  "run",
  "--config",
  "vitest.unit.config.ts",
  "--silent=passed-only",
  ...selected,
];

const child = spawn("pnpm", vitestArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
