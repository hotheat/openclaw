#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const tempDir = await fs.mkdtemp(path.join(rootDir, ".npm-pack-plugin-smoke-"));
const expectedPluginIds = [
  "subagent-handoff-output-guard",
  "tool-error-latch",
  "tool-request-guard",
  "webui-artifacts",
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
    ...options,
  });
}

function parseJsonReport(output) {
  const starts = [0];
  for (let index = output.indexOf("\n{"); index >= 0; index = output.indexOf("\n{", index + 2)) {
    starts.push(index + 1);
  }
  for (const start of starts.toReversed()) {
    try {
      return JSON.parse(output.slice(start));
    } catch {
      // Continue past non-JSON CLI log lines.
    }
  }
  throw new Error("packed OpenClaw CLI did not emit a JSON plugin report");
}

try {
  const packResult = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tempDir]),
  );
  const filename = packResult[0]?.filename;
  if (typeof filename !== "string" || !filename) {
    throw new Error("npm pack did not return a tarball filename");
  }

  run("tar", ["-xzf", path.join(tempDir, filename), "-C", tempDir]);
  const packageDir = path.join(tempDir, "package");
  const sourceDir = path.join(packageDir, "src");
  const sourceStat = await fs.stat(sourceDir).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (sourceStat) {
    throw new Error("packed package unexpectedly contains src/");
  }

  const stateDir = path.join(tempDir, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        plugins: {
          allow: expectedPluginIds,
          entries: {
            "subagent-handoff-output-guard": {
              enabled: true,
            },
            "tool-error-latch": {
              enabled: true,
            },
            "tool-request-guard": {
              enabled: true,
            },
            "webui-artifacts": {
              enabled: true,
              config: {
                endpoint: "http://127.0.0.1:8303",
                apiKey: "npm-pack-smoke",
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const stdout = run(
    process.execPath,
    [path.join(packageDir, "openclaw.mjs"), "plugins", "list", "--json"],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NO_COLOR: "1",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_LOG_LEVEL: "error",
        OPENCLAW_STATE_DIR: stateDir,
      },
    },
  );
  const report = parseJsonReport(stdout);
  for (const pluginId of expectedPluginIds) {
    const plugin = report.plugins?.find((entry) => entry.id === pluginId);
    if (!plugin) {
      throw new Error(`packed package did not discover ${pluginId}`);
    }
    if (plugin.status !== "loaded" || plugin.origin !== "bundled") {
      throw new Error(
        `packed ${pluginId} failed bundled loading: ${plugin.error ?? plugin.status ?? plugin.origin ?? "unknown error"}`,
      );
    }
  }

  console.log(
    `[npm-pack-plugin-smoke] bundled plugins loaded without src/: ${expectedPluginIds.join(", ")}`,
  );
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
