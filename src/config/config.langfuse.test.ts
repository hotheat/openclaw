import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("langfuse diagnostics config", () => {
  it("accepts native Langfuse diagnostics options", () => {
    const res = validateConfigObject({
      diagnostics: {
        enabled: true,
        langfuse: {
          enabled: true,
          host: "http://localhost:3005",
          publicKey: "${LANGFUSE__PUBLIC_KEY}",
          secretKey: "${LANGFUSE__SECRET_KEY}",
          serviceName: "openclaw-gateway",
          captureMode: "safe",
          flushIntervalMs: 5000,
          timeoutMs: 10000,
        },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.diagnostics?.langfuse?.captureMode).toBe("safe");
    }
  });

  it("rejects unknown Langfuse capture modes", () => {
    const res = validateConfigObject({
      diagnostics: {
        langfuse: {
          enabled: true,
          host: "http://localhost:3005",
          publicKey: "pk",
          secretKey: "sk",
          captureMode: "everything",
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
