# Implementation Plan: Control UI and WebChat Channel Separation

## Overview

Separate the built-in Control UI from the reserved external WebChat ingress. Control UI uses
`clientMode=ui` and `channel=control-ui`; external WebChat keeps `clientMode=webchat` and remains
disabled unless explicitly enabled.

## Requirements

- Add a dedicated `control-ui` gateway message channel.
- Resolve `chat.send` origin from the connected client identity.
- Preserve Feishu delivery through the session `deliveryContext`.
- Default external WebChat ingress to disabled.
- Keep Control UI and WebChat logs, paired-device metadata, and session origin distinct.

## Architecture Changes

- `src/utils/message-channel.ts`: define Control UI channel and client classification helpers.
- `ui/src/ui/app-gateway.ts`: connect the Control UI with `clientMode=ui`.
- `src/gateway/server-methods/chat.ts`: derive origin channel from the connected client.
- `src/gateway/server/ws-connection/message-handler.ts`: reject disabled external WebChat clients.
- `src/config/types.gateway.ts` and `src/config/zod-schema.ts`: add `gateway.webchat`.
- `src/auto-reply/reply/session.ts`: prevent Control UI turns from overwriting external routes.

## Implementation Steps

### Phase 1: Channel Identity

1. Add `CONTROL_UI_MESSAGE_CHANNEL` and client-origin resolution helpers.
2. Include `control-ui` in gateway message-channel types and non-deliverable handling.
3. Change the browser Control UI client mode from `webchat` to `ui`.

### Phase 2: Ingress Policy

1. Add `gateway.webchat.enabled` with a default-disabled policy.
2. Add a separate `gateway.webchat.allowedOrigins` list.
3. Reject external WebChat connections before authentication when disabled.
4. Emit distinct Control UI and WebChat connection logs.

### Phase 3: Session and Delivery

1. Mark Control UI `chat.send` turns with `Provider`, `Surface`, and `OriginatingChannel` set to
   `control-ui`.
2. Preserve existing deliverable session routes for Control UI turns.
3. Keep `routeReply` delivery based on the captured session `deliveryContext`.
4. Update paired-device metadata on the next successful Control UI connection.

### Phase 4: Verification

1. Add message-channel and session routing unit tests.
2. Add gateway connection-policy tests for disabled and enabled WebChat.
3. Add `chat.send` tests for Control UI and external WebChat origins.
4. Run focused Vitest suites, Oxfmt, Oxlint, and diff checks.

## Risks & Mitigations

- **Cached Control UI bundle still sends `mode=webchat`**
  - Classify `openclaw-control-ui` by client ID before mode so it remains Control UI.
- **Control UI overwrites a Feishu delivery route**
  - Treat `control-ui` as a non-delivery origin and preserve the existing deliverable route.
- **Existing paired devices retain old metadata**
  - Reuse the existing successful-connect metadata update path.
- **External WebChat unexpectedly remains reachable**
  - Require `gateway.webchat.enabled=true` before accepting the connection.

## Success Criteria

- [x] Control UI sessions record `origin.provider=control-ui`.
- [x] External WebChat sessions record `origin.provider=webchat`.
- [x] External WebChat connections fail when not enabled.
- [x] Control UI replies still deliver to Feishu through the session route.
- [x] Heartbeat and subagent turns remain `internal`.
