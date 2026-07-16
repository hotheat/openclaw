---
summary: "External WebChat WebSocket ingress and gateway configuration"
read_when:
  - Connecting a standalone WebChat client to the Gateway
  - Configuring external WebChat access or allowed origins
title: "WebChat"
---

# WebChat

External WebChat is the reserved Gateway WebSocket ingress for standalone chat clients whose
reported client ID or mode identifies them as WebChat. It is separate from the built-in browser
Control UI and the first-party TUI, macOS, iOS, and Android interfaces.

External WebChat is disabled by default. Enable it explicitly before connecting a standalone
client:

```json5
{
  gateway: {
    webchat: {
      enabled: true,
      allowedOrigins: ["https://chat.example.com"],
    },
    auth: {
      mode: "token",
      token: "replace-me",
    },
  },
}
```

## Connection behavior

- The client connects to the Gateway WebSocket and uses methods such as `chat.history`,
  `chat.send`, `chat.abort`, and `chat.inject`.
- `gateway.webchat.enabled` must be `true`; otherwise the Gateway rejects the handshake with
  close code `1008`.
- `gateway.webchat.allowedOrigins` controls accepted browser origins for external WebChat. It is
  independent from `gateway.controlUi.allowedOrigins`.
- Gateway authentication still applies. Use `gateway.auth` for access control on every exposed
  deployment.

`gateway.webchat.enabled` classifies clients from the identity they report in the WebSocket
handshake. It is an ingress hygiene filter, not an authentication boundary. Do not rely on this
setting in place of `gateway.auth`.

## Channel-specific configuration migration

Built-in and first-party interactive clients now use the `control-ui` message-channel key.
Standalone external WebChat clients continue to use `webchat`.

If an existing configuration used `webchat` for the built-in Control UI, move the value to
`control-ui` in these maps:

- `messages.queue.byChannel`
- `messages.queue.debounceMsByChannel`
- `tools.elevated.allowFrom`
- `agents.list[].tools.elevated.allowFrom`
- `session.resetByChannel`

The legacy `webchat` value remains a compatibility fallback for Control UI when no explicit
`control-ui` value exists. OpenClaw emits a deprecation warning when it uses that fallback. An
explicit `control-ui` value always wins.

See [Control UI](/web/control-ui) for the built-in browser interface and
[Configuration Reference](/gateway/configuration-reference) for all Gateway settings.
