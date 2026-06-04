import { describe, expect, it } from "vitest";
import { FeishuMediaLimitError, maybeCreateInboundLimitError, mbToBytes } from "./media-limits.js";

describe("maybeCreateInboundLimitError", () => {
  it("classifies local media size failures as inbound media limits", () => {
    const result = maybeCreateInboundLimitError({
      err: new Error("Media exceeds 100MB limit"),
      kind: "file",
      limitBytes: mbToBytes(100),
    });

    expect(result).toBeInstanceOf(FeishuMediaLimitError);
    expect(result?.message).toBe("文件超过入站上限 100MB，请压缩后重发。");
  });

  it("does not classify generic provider rate limits as media limits", () => {
    const result = maybeCreateInboundLimitError({
      err: new Error("429 Too Many Requests: request exceeds rate limit"),
      kind: "file",
      limitBytes: mbToBytes(100),
    });

    expect(result).toBeNull();
  });
});
