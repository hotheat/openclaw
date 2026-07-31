import { afterEach, describe, expect, it, vi } from "vitest";

const { configureFsSafePython } = vi.hoisted(() => ({
  configureFsSafePython: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/config", () => ({
  configureFsSafePython,
}));

async function importDefaults() {
  vi.resetModules();
  await import("./fs-safe-defaults.js");
}

describe("fs-safe defaults", () => {
  afterEach(() => {
    configureFsSafePython.mockReset();
    delete process.env.FS_SAFE_PYTHON_MODE;
    delete process.env.OPENCLAW_FS_SAFE_PYTHON_MODE;
  });

  it("disables the Python helper by default", async () => {
    await importDefaults();

    expect(configureFsSafePython).toHaveBeenCalledWith({ mode: "off" });
  });

  it("honors the fs-safe environment override", async () => {
    process.env.FS_SAFE_PYTHON_MODE = "require";

    await importDefaults();

    expect(configureFsSafePython).not.toHaveBeenCalled();
  });

  it("honors the OpenClaw-specific environment override", async () => {
    process.env.OPENCLAW_FS_SAFE_PYTHON_MODE = "auto";

    await importDefaults();

    expect(configureFsSafePython).not.toHaveBeenCalled();
  });
});
