import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMSTeamsTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isControlUiClient,
  isFirstPartyUiClient,
  isWebchatClient,
  resolveGatewayClientMessageChannel,
  resolveGatewayMessageChannel,
} from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);
const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
};

describe("message-channel", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(resolveGatewayMessageChannel("discord")).toBe("discord");
    expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageChannel("control-ui")).toBe("control-ui");
    expect(resolveGatewayMessageChannel("webchat")).toBe("webchat");
    expect(resolveGatewayMessageChannel("internal")).toBe("internal");
    expect(resolveGatewayMessageChannel("web")).toBeUndefined();
    expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
  });

  it("normalizes plugin aliases when registered", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
    expect(resolveGatewayMessageChannel("teams")).toBe("msteams");
  });

  it("separates Control UI clients from external WebChat clients", () => {
    const controlUi = {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
    };
    const staleControlUi = {
      id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    };
    const externalWebchat = {
      id: GATEWAY_CLIENT_NAMES.WEBCHAT,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    };

    expect(isControlUiClient(controlUi)).toBe(true);
    expect(isWebchatClient(controlUi)).toBe(false);
    expect(isWebchatClient(staleControlUi)).toBe(false);
    expect(resolveGatewayClientMessageChannel(staleControlUi)).toBe("control-ui");
    expect(isWebchatClient(externalWebchat)).toBe(true);
    expect(resolveGatewayClientMessageChannel(externalWebchat)).toBe("webchat");
  });

  it.each([
    GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    GATEWAY_CLIENT_NAMES.MACOS_APP,
    GATEWAY_CLIENT_NAMES.IOS_APP,
    GATEWAY_CLIENT_NAMES.ANDROID_APP,
  ])("classifies first-party UI client %s as control-ui", (id) => {
    const client = { id, mode: GATEWAY_CLIENT_MODES.UI };

    expect(isFirstPartyUiClient(client)).toBe(true);
    expect(resolveGatewayClientMessageChannel(client)).toBe("control-ui");
  });

  it("does not classify unknown or non-UI clients as control-ui", () => {
    expect(
      resolveGatewayClientMessageChannel({ id: "unknown-ui", mode: GATEWAY_CLIENT_MODES.UI }),
    ).toBe("internal");
    expect(
      resolveGatewayClientMessageChannel({
        id: GATEWAY_CLIENT_NAMES.ANDROID_APP,
        mode: GATEWAY_CLIENT_MODES.NODE,
      }),
    ).toBe("internal");
  });
});
