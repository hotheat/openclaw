import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSkill } from "../agents/skills.e2e-test-helpers.js";
import { withEnvAsync } from "../test-utils/env.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway skills.status", () => {
  it("does not expose raw config values to operator.read clients", async () => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-status-"));
    await writeSkill({
      dir: path.join(bundledDir, "coding-agent"),
      name: "coding-agent",
      description: "Delegate coding work",
      metadata: '{"openclaw":{"requires":{"config":["skills.entries.coding-agent.enabled"]}}}',
    });

    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir }, async () => {
      const secret = "coding-agent-secret-abc";
      const { writeConfigFile } = await import("../config/config.js");
      await writeConfigFile({
        session: { mainKey: "main-test" },
        skills: {
          entries: {
            "coding-agent": {
              enabled: true,
              env: {
                SECRET_FOR_TEST: secret,
              },
            },
          },
        },
      });

      await withServer(async (ws) => {
        await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
        const res = await rpcReq<{
          skills?: Array<{
            name?: string;
            configChecks?: Array<{ path?: string; satisfied?: boolean } & Record<string, unknown>>;
          }>;
        }>(ws, "skills.status", {});

        expect(res.ok).toBe(true);
        expect(JSON.stringify(res.payload)).not.toContain(secret);

        const codingAgent = res.payload?.skills?.find((s) => s.name === "coding-agent");
        expect(codingAgent).toBeTruthy();
        const check = codingAgent?.configChecks?.find(
          (c) => c.path === "skills.entries.coding-agent.enabled",
        );
        expect(check).toBeTruthy();
        expect(check?.satisfied).toBe(true);
        expect(check && "value" in check).toBe(false);
      });
    });
  });
});
