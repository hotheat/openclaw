#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");

async function importModule(label, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  await fs.access(filePath);
  await import(pathToFileURL(filePath).href);
  console.log(`[build-smoke] imported ${label}: ${relativePath}`);
}

async function importDistChunkByPrefix(prefix) {
  const entries = await fs.readdir(distDir);
  const match = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js"))
    .toSorted()[0];

  if (!match) {
    throw new Error(`missing dist chunk with prefix ${prefix}`);
  }

  await importModule(prefix, path.join("dist", match));
}

await importModule("runtime entry", "dist/entry.js");
await importModule("library entry", "dist/index.js");
await importModule("daemon cli", "dist/daemon-cli.js");
await importDistChunkByPrefix("auth-profiles-");

console.log("[build-smoke] ok");
