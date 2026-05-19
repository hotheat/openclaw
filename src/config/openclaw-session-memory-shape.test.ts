import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local openclaw config memory recall defaults", () => {
  it("disables session transcript recall in an openclaw.json profile", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-shape-"));
    try {
      const configPath = path.join(root, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              memorySearch: {
                sources: ["memory"],
                experimental: { sessionMemory: false },
              },
            },
          },
        }),
        "utf-8",
      );

      const raw = fs.readFileSync(configPath, "utf-8");
      const cfg = JSON.parse(raw) as {
        agents?: {
          defaults?: {
            memorySearch?: {
              sources?: string[];
              experimental?: { sessionMemory?: boolean };
            };
          };
        };
      };

      expect(cfg.agents?.defaults?.memorySearch?.sources).toEqual(["memory"]);
      expect(cfg.agents?.defaults?.memorySearch?.experimental?.sessionMemory).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
