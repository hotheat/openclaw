import { spawn } from "node:child_process";

const pnpm = "pnpm";
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const DEFAULT_WORKERS = isCI ? 4 : 2;
const MAX_WORKERS = 4;
const DEFAULT_MAX_OLD_SPACE_SIZE_MB = isCI ? 2048 : 1024;
const MIN_MAX_OLD_SPACE_SIZE_MB = 512;
const MAX_MAX_OLD_SPACE_SIZE_MB = 2048;

function resolveBoundedInteger(raw, { name, fallback, min, max }) {
  if (raw == null || raw === "") {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return Math.max(min, Math.min(max, Number.parseInt(raw, 10)));
}

function extractMaxWorkers(args) {
  const passthroughArgs = [];
  let requestedWorkers;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--maxWorkers" || arg === "--max-workers") {
      const value = args[index + 1];
      if (value == null) {
        throw new Error(`${arg} requires a value`);
      }
      requestedWorkers = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--maxWorkers=") || arg.startsWith("--max-workers=")) {
      requestedWorkers = arg.slice(arg.indexOf("=") + 1);
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { passthroughArgs, requestedWorkers };
}

function resolveNodeOptions(maxOldSpaceSizeMb) {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  const withoutHeapLimit = nodeOptions
    .replace(/(?:^|\s)--max-old-space-size(?:=|\s+)\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${withoutHeapLimit} --max-old-space-size=${maxOldSpaceSizeMb}`.trim();
}

const extractedArgs = extractMaxWorkers(process.argv.slice(2));
const maxWorkers = resolveBoundedInteger(
  extractedArgs.requestedWorkers ?? process.env.OPENCLAW_FAST_TEST_WORKERS,
  {
    name: "OPENCLAW_FAST_TEST_WORKERS",
    fallback: DEFAULT_WORKERS,
    min: 1,
    max: MAX_WORKERS,
  },
);
const maxOldSpaceSizeMb = resolveBoundedInteger(
  process.env.OPENCLAW_FAST_TEST_MAX_OLD_SPACE_SIZE_MB,
  {
    name: "OPENCLAW_FAST_TEST_MAX_OLD_SPACE_SIZE_MB",
    fallback: DEFAULT_MAX_OLD_SPACE_SIZE_MB,
    min: MIN_MAX_OLD_SPACE_SIZE_MB,
    max: MAX_MAX_OLD_SPACE_SIZE_MB,
  },
);
const resourceArgs = ["--maxWorkers", String(maxWorkers)];
const childEnv = {
  ...process.env,
  NODE_OPTIONS: resolveNodeOptions(maxOldSpaceSizeMb),
};

const runs = [
  {
    name: "fast-core",
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.unit.config.ts",
      "--pool=vmForks",
      "--exclude",
      "src/plugins/loader.test.ts",
      ...extractedArgs.passthroughArgs,
      ...resourceArgs,
    ],
  },
  {
    name: "fast-isolated",
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.unit.config.ts",
      "--pool=forks",
      "src/plugins/loader.test.ts",
      ...extractedArgs.passthroughArgs,
      ...resourceArgs,
    ],
  },
];

console.log(
  `[test-fast] resource limits: maxWorkers=${maxWorkers}, maxOldSpaceSizeMb=${maxOldSpaceSizeMb}`,
);

function runStep({ name, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: childEnv,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${name} exited via signal ${signal}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with code ${code ?? 1}`));
    });
  });
}

for (const run of runs) {
  await runStep(run);
}
