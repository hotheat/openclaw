import { describe, expect, it, vi } from "vitest";
import { theme } from "../../terminal/theme.js";

vi.mock("../../gateway/net.js", () => ({
  pickPrimaryLanIPv4: () => "10.0.0.5",
}));

import { pickProbeHostForBind, resolveRuntimeStatusColor } from "./shared.js";

describe("resolveRuntimeStatusColor", () => {
  it("maps known runtime states to expected theme colors", () => {
    expect(resolveRuntimeStatusColor("running")).toBe(theme.success);
    expect(resolveRuntimeStatusColor("stopped")).toBe(theme.error);
    expect(resolveRuntimeStatusColor("unknown")).toBe(theme.muted);
  });

  it("falls back to warning color for unexpected states", () => {
    expect(resolveRuntimeStatusColor("degraded")).toBe(theme.warn);
    expect(resolveRuntimeStatusColor(undefined)).toBe(theme.muted);
  });
});

describe("pickProbeHostForBind", () => {
  it("uses loopback for bind=lan status probes", () => {
    expect(pickProbeHostForBind("lan", undefined)).toBe("127.0.0.1");
  });
});
