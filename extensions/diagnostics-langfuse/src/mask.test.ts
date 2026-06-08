import { describe, expect, it } from "vitest";
import { maskSensitiveData } from "./mask.js";

describe("maskSensitiveData", () => {
  it("redacts sensitive keys recursively", () => {
    expect(
      maskSensitiveData({
        apiKey: "abc",
        nested: {
          authorization: "Bearer token",
          ok: "visible",
        },
      }),
    ).toEqual({
      apiKey: "[redacted]",
      nested: {
        authorization: "[redacted]",
        ok: "visible",
      },
    });
  });
});
