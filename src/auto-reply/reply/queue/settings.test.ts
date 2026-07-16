import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveQueueSettings } from "./settings.js";

describe("resolveQueueSettings", () => {
  it("falls back to legacy webchat settings for Control UI", () => {
    const cfg = {
      messages: {
        queue: {
          byChannel: { webchat: "interrupt" },
          debounceMsByChannel: { webchat: 125 },
        },
      },
    } as OpenClawConfig;

    expect(resolveQueueSettings({ cfg, channel: "control-ui" })).toMatchObject({
      mode: "interrupt",
      debounceMs: 125,
    });
  });

  it("prefers explicit Control UI settings over legacy webchat settings", () => {
    const cfg = {
      messages: {
        queue: {
          byChannel: { "control-ui": "followup", webchat: "interrupt" },
          debounceMsByChannel: { "control-ui": 250, webchat: 125 },
        },
      },
    } as OpenClawConfig;

    expect(resolveQueueSettings({ cfg, channel: "control-ui" })).toMatchObject({
      mode: "followup",
      debounceMs: 250,
    });
  });
});
