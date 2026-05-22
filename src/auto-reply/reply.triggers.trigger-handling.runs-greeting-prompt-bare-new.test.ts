import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("runs a greeting prompt for a bare /new", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      cfg.channels ??= {};
      cfg.channels.whatsapp = {
        ...cfg.channels.whatsapp,
        allowFrom: ["+1999"],
      };
      cfg.session = {
        ...cfg.session,
        store: join(tmpdir(), `openclaw-session-test-${Date.now()}.json`),
      };
      const res = await getReplyFromConfig(
        {
          Body: "/new",
          From: "+1999",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const prompt = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new");
      expect(Array.isArray(res) ? res[0]?.text : res?.text).toContain(
        "Type /help to see detailed commands.",
      );
    });
  });
});
