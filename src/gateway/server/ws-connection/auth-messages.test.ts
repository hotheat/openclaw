import { describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../utils/message-channel.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

describe("gateway auth failure messages", () => {
  test("keeps external WebChat guidance separate from Control UI settings", () => {
    const controlUiMessage = formatGatewayAuthFailureMessage({
      authMode: "token",
      authProvided: "none",
      reason: "token_missing",
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.UI,
      },
    });
    expect(controlUiMessage).toContain("Control UI settings");

    const webchatMessage = formatGatewayAuthFailureMessage({
      authMode: "token",
      authProvided: "none",
      reason: "token_missing",
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });
    expect(webchatMessage).toContain("provide gateway auth token");
    expect(webchatMessage).not.toContain("Control UI");
  });
});
