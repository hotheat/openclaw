import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  clearDevicePairing,
  getPairedDevice,
  listDevicePairing,
  type PairedDevice,
  removePairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing.js";
import { writeJsonAtomic } from "./json-files.js";
import { readJsonFile, resolvePairingPaths } from "./pairing-files.js";

async function setupPairedOperatorDevice(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, baseDir);
}

async function setupOperatorToken(scopes: string[]) {
  const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
  await setupPairedOperatorDevice(baseDir, scopes);
  const paired = await getPairedDevice("device-1", baseDir);
  const token = requireToken(paired?.tokens?.operator?.token);
  return { baseDir, token };
}

function verifyOperatorToken(params: { baseDir: string; token: string; scopes: string[] }) {
  return verifyDeviceToken({
    deviceId: "device-1",
    token: params.token,
    role: "operator",
    scopes: params.scopes,
    baseDir: params.baseDir,
  });
}

function requireToken(token: string | undefined): string {
  expect(typeof token).toBe("string");
  if (typeof token !== "string") {
    throw new Error("expected operator token to be issued");
  }
  return token;
}

describe("device pairing tokens", () => {
  test("reuses existing pending requests for the same device", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("merges pending roles/scopes for the same device before approval", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: [],
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
      baseDir,
    );

    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.roles).toEqual(["node", "operator"]);
    expect(second.request.scopes).toEqual(["operator.read", "operator.write"]);

    await approveDevicePairing(first.request.requestId, baseDir);
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.roles).toEqual(["node", "operator"]);
    expect(paired?.scopes).toEqual(["operator.read", "operator.write"]);
  });

  test("generates base64url device tokens with 256-bit entropy output length", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("allows down-scoping from admin and preserves approved scope baseline", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);

    await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("preserves existing token scopes when approving a repair without requested scopes", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const repair = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, baseDir);

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.admin"]);
  });

  test("rejects scope escalation when rotating a token and leaves state unchanged", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const before = await getPairedDevice("device-1", baseDir);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
      baseDir,
    });
    expect(rotated).toBeNull();

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("verifies token and rejects mismatches", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);

    const ok = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyOperatorToken({
      baseDir,
      token: "x".repeat(token.length),
      scopes: ["operator.read"],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });

  test("accepts operator.read/operator.write requests with an operator.admin token scope", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.admin"]);

    const readOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(readOk.ok).toBe(true);

    const writeOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.write"],
    });
    expect(writeOk.ok).toBe(true);
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(
      verifyOperatorToken({
        baseDir,
        token: multibyteToken,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
  });

  test("removes paired devices by device id", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const removed = await removePairedDevice("device-1", baseDir);
    expect(removed).toEqual({ deviceId: "device-1" });
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();

    await expect(removePairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("clears paired device state by device id", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(true);
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(false);
  });

  test("refreshes repeated list calls after an out-of-process update", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-cache-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const initial = await listDevicePairing(baseDir);
    expect(initial.paired.map((device) => device.deviceId)).toEqual(["device-1"]);

    const { pairedPath } = resolvePairingPaths(baseDir, "devices");
    await writeJsonAtomic(pairedPath, {});

    const refreshed = await listDevicePairing(baseDir);
    expect(refreshed.paired).toEqual([]);
  });

  test("returns detached paired-device records", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-snapshot-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const first = await getPairedDevice("device-1", baseDir);
    expect(first).not.toBeNull();
    if (!first) {
      throw new Error("expected paired device");
    }
    const operatorToken = first.tokens?.operator;
    if (!operatorToken) {
      throw new Error("expected operator token");
    }
    first.displayName = "mutated-outside-store";
    operatorToken.scopes.push("operator.admin");

    const second = await getPairedDevice("device-1", baseDir);
    expect(second?.displayName).not.toBe("mutated-outside-store");
    expect(second?.tokens?.operator.scopes).toEqual(["operator.read"]);
  });

  test("refreshes paired-device reads after an out-of-process update", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openclaw-device-pairing-refresh-"));
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const { pairedPath } = resolvePairingPaths(baseDir, "devices");
    const paired = (await readJsonFile<Record<string, PairedDevice>>(pairedPath)) ?? {};
    paired["device-1"] = {
      ...paired["device-1"],
      displayName: "updated-on-disk",
    } as PairedDevice;
    await writeJsonAtomic(pairedPath, paired);

    expect((await getPairedDevice("device-1", baseDir))?.displayName).toBe("updated-on-disk");
  });

  test("preserves out-of-process pairing changes during token verification", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    const { pairedPath } = resolvePairingPaths(baseDir, "devices");
    const paired = (await readJsonFile<Record<string, PairedDevice>>(pairedPath)) ?? {};
    paired["device-2"] = {
      deviceId: "device-2",
      publicKey: "public-key-2",
      createdAtMs: Date.now(),
      approvedAtMs: Date.now(),
    };
    await writeJsonAtomic(pairedPath, paired);

    await expect(
      verifyOperatorToken({
        baseDir,
        token,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });

    const persisted = (await readJsonFile<Record<string, PairedDevice>>(pairedPath)) ?? {};
    expect(persisted["device-2"]?.publicKey).toBe("public-key-2");
    expect(persisted["device-1"]?.tokens?.operator?.lastUsedAtMs).toBeTypeOf("number");
  });
});
