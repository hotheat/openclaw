import { spawn } from "node:child_process";

const pnpm = "pnpm";
const passthroughArgs = process.argv.slice(2);

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
      ...passthroughArgs,
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
      ...passthroughArgs,
    ],
  },
];

function runStep({ name, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
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
