import { describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";
import {
  evaluateMissingDeviceIdentity,
  resolveGatewayBrowserClientPolicy,
  resolveControlUiAuthPolicy,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";

describe("ws connect policy", () => {
  test("separates Control UI from disabled-by-default external WebChat", () => {
    const controlUi = resolveGatewayBrowserClientPolicy({
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      controlUiConfig: { allowedOrigins: ["https://control.example"] },
      webchatConfig: { allowedOrigins: ["https://chat.example"] },
    });
    expect(controlUi).toEqual({
      kind: "control-ui",
      enabled: true,
      allowedOrigins: ["https://control.example"],
    });

    const disabledWebchat = resolveGatewayBrowserClientPolicy({
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(disabledWebchat).toEqual({
      kind: "webchat",
      enabled: false,
      allowedOrigins: undefined,
    });

    const enabledWebchat = resolveGatewayBrowserClientPolicy({
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      webchatConfig: {
        enabled: true,
        allowedOrigins: ["https://chat.example"],
      },
    });
    expect(enabledWebchat).toEqual({
      kind: "webchat",
      enabled: true,
      allowedOrigins: ["https://chat.example"],
    });
  });

  test("resolves control-ui auth policy", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-1",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-1",
      },
    });
    expect(bypass.allowBypass).toBe(true);
    expect(bypass.device).toBeNull();

    const regular = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: {
        id: "dev-2",
        publicKey: "pk",
        signature: "sig",
        signedAt: Date.now(),
        nonce: "nonce-2",
      },
    });
    expect(regular.allowBypass).toBe(false);
    expect(regular.device?.id).toBe("dev-2");
  });

  test("evaluates missing-device decisions", () => {
    const policy = resolveControlUiAuthPolicy({
      isControlUi: false,
      controlUiConfig: undefined,
      deviceRaw: null,
    });

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: true,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    const controlUiStrict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    // Remote Control UI with allowInsecureAuth -> still rejected.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    // Local Control UI with allowInsecureAuth -> allowed.
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiStrict,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("allow");

    // Control UI without allowInsecureAuth, even on localhost -> rejected.
    const controlUiNoInsecure = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: false },
      deviceRaw: null,
    });
    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: true,
        controlUiAuthPolicy: controlUiNoInsecure,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: true,
      }).kind,
    ).toBe("reject-control-ui-insecure-auth");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("allow");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "operator",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        sharedAuthOk: false,
        authOk: false,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-unauthorized");

    expect(
      evaluateMissingDeviceIdentity({
        hasDeviceIdentity: false,
        role: "node",
        isControlUi: false,
        controlUiAuthPolicy: policy,
        sharedAuthOk: true,
        authOk: true,
        hasSharedAuth: true,
        isLocalClient: false,
      }).kind,
    ).toBe("reject-device-required");
  });

  test("pairing bypass requires control-ui bypass + shared auth", () => {
    const bypass = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: { dangerouslyDisableDeviceAuth: true },
      deviceRaw: null,
    });
    const strict = resolveControlUiAuthPolicy({
      isControlUi: true,
      controlUiConfig: undefined,
      deviceRaw: null,
    });
    expect(shouldSkipControlUiPairing(bypass, true)).toBe(true);
    expect(shouldSkipControlUiPairing(bypass, false)).toBe(false);
    expect(shouldSkipControlUiPairing(strict, true)).toBe(false);
  });
});
