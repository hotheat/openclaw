import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";
import { validateConfigObject } from "./validation.js";

const legacyArtifactJobsConfig = {
  root: "/var/lib/openclaw/artifact-jobs",
  allowedSourceRoots: ["/srv/openclaw/workspaces"],
  exportDirName: "artifacts/imports",
};

describe("deprecated tools.artifactJobs compatibility", () => {
  it("accepts and preserves the legacy field during validation", () => {
    const result = validateConfigObject({
      tools: {
        artifactJobs: legacyArtifactJobsConfig,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tools?.artifactJobs).toEqual(legacyArtifactJobsConfig);
    }
  });

  it("writes an older config without dropping the deprecated field", async () => {
    await withTempHome("openclaw-artifact-jobs-compat-", async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ tools: { artifactJobs: legacyArtifactJobsConfig } }, null, 2)}\n`,
        "utf8",
      );

      const io = createConfigIO({
        env: {},
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile(snapshot.config);

      const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        tools?: { artifactJobs?: unknown };
      };
      expect(persisted.tools?.artifactJobs).toEqual(legacyArtifactJobsConfig);
    });
  });
});
