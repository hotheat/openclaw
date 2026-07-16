import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetControlUiConfigCompatWarningsForTesting,
  resolveControlUiConfigValue,
} from "./control-ui-config-compat.js";

describe("resolveControlUiConfigValue", () => {
  beforeEach(() => {
    resetControlUiConfigCompatWarningsForTesting();
  });

  it("warns once per config path when using the legacy webchat fallback", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    for (let index = 0; index < 2; index += 1) {
      expect(
        resolveControlUiConfigValue({
          values: { webchat: "legacy" },
          channel: "control-ui",
          configPath: "messages.queue.byChannel",
        }),
      ).toBe("legacy");
    }

    expect(emitWarning).toHaveBeenCalledOnce();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("messages.queue.byChannel.control-ui"),
      expect.objectContaining({
        type: "DeprecationWarning",
        code: "OPENCLAW_CONTROL_UI_LEGACY_WEBCHAT_CONFIG",
      }),
    );
    emitWarning.mockRestore();
  });

  it("prefers an explicit Control UI value without warning", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    expect(
      resolveControlUiConfigValue({
        values: { "control-ui": "current", webchat: "legacy" },
        channel: "control-ui",
        configPath: "messages.queue.byChannel",
      }),
    ).toBe("current");
    expect(emitWarning).not.toHaveBeenCalled();
    emitWarning.mockRestore();
  });
});
