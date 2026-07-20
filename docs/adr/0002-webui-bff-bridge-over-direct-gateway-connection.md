# WebUI connects through an agent-server BFF bridge, not directly to the Gateway

> **Revision history.** An earlier draft of this ADR (same date) proposed making
> `agent-server` a _paired_ Gateway device via a fork-level Phase 0 change to the auth
> gate (signed-but-credentialless devices entering pairing, "paired" as trust anchor,
> per-profile keypairs). That draft was replaced after code review found that Gateway
> shared auth **bypasses** pairing (`skipPairingForOperatorSharedAuth`), not gates it — so
> shared-secret auth achieves the same connection with zero Gateway change and none of the
> Phase 0 blast radius. The rejected pairing approach is recorded under D7. This rewrite
> supersedes the draft; no code was ever written against it.

The multi-chat WebUI (`agent-frontend`) reaches OpenClaw exclusively through an
`agent-server` WebSocket bridge (`/api/v1/openclaw/ws`). The browser never speaks the
Gateway protocol, never holds the shared secret or Ed25519 private key, and never selects
a raw `agentId`. `agent-server` is the Gateway's operator client via **shared-secret auth**
plus a self-signed Ed25519 device identity; user identity, Feishu-target authorization,
session namespacing, method allowlisting, and event filtering are all enforced in the
bridge. This supersedes the earliest plan (first revision of
`webui_integration_milestones.md`) in which each browser held its own device identity and
connected to the Gateway directly.

Why the direct-connection plan was rejected: the Gateway's permission model is
device-scoped, not user-scoped — any operator connection with `operator.read` can list
every session and receive every `chat`/`agent` event (verified: gateway events are
broadcast, not per-user filtered). A multi-tenant WebUI therefore cannot get per-user
isolation from the Gateway alone; it must be imposed by a trusted middle tier that already
knows who the user is (Feishu OAuth session in agent-server). Browser-held device
identities also leak pairing UX and secure-context (`crypto.subtle`) requirements onto
every end user, and would mint one Gateway credential per browser profile.

## Decisions captured during design interviews (2026-07-09)

Refines `docs/plans/2026-07-09-openclaw-webui-m0-bff-bridge.md`.

### D1. Shared-secret bootstrap; no pairing, no deviceToken, no Gateway change

`agent-server` connects with the Gateway shared secret (`auth.token` or `auth.password`)
plus a persistent Ed25519 keypair that self-signs `operator.read,operator.write` scopes.
Gateway validates the shared secret → `authOk=true` → the existing
`skipPairingForOperatorSharedAuth` (`message-handler.ts:558-565`) skips the entire pairing
branch. `agent-server` is therefore never paired, never receives a `deviceToken`
(`ensureDeviceToken` returns null for unpaired devices; `helloOk.auth` is undefined), and
M0 requires **no Gateway code or config change**.

- Why: review found shared auth _bypasses_ pairing rather than being its prerequisite.
  Reusing the Gateway's existing, tested skip-pairing path removes the fork-level Phase 0
  change entirely and keeps dev and prod on one code path (the skip does not check
  `isLocalClient`, so it works containerized).
- Rejected: the earlier Phase 0 (modify the auth gate so credentialless signed devices can
  enter pairing; "paired" becomes the trust anchor). Its blast radius touched the banning
  semantics of _all_ existing paired devices and needed a fork-wide default change — too
  large for what shared-secret already gives for free. See D7.

### D2. Shared secret is token OR password, exactly one set; prod runs on password

The Gateway `auth.mode` is single-select: in `password` mode `auth.token` is ignored, in
`token` mode `auth.password` is ignored. The production Gateway is configured
`auth.mode=password` (`openclaw.json:3530`, so the `OPENCLAW_GATEWAY_TOKEN` env is dead).
`agent-server` settings therefore carry `gateway_token` / `gateway_password` with a
"exactly one non-empty" validator. The connect frame carries whichever is set; the device
auth payload's `token` field is the token in token mode and the empty string in password
mode (matching the Gateway's `auth.token ?? auth.deviceToken ?? null` reconstruction).

- Why: prod runs on password today; supporting both lets the same code work without
  touching the live Gateway config and without a future mode switch forcing a code change.
- Rejected: forcing a prod switch to `auth.mode=token` (an unnecessary live-config change
  that also migrates Control UI users off their current login).

### D3. One persistent keypair, self-declared scopes; full-power leakage is the real risk

A single Ed25519 keypair is persisted at
`/app/data/openclaw/gateway-device-key.json` (0600, no deviceToken field). M0 declares
`operator.read,operator.write` only. Scopes are self-signed and self-declared — the
Gateway does **not** constrain scopes for shared-auth clients (verified:
`server.auth.test.ts:1152-1164` — same shared secret + a freshly generated keypair
declaring `operator.admin` connects with `ok` and no pairing). `read+write` is therefore
agent-server self-discipline, not an enforced ceiling.

- Why: a separate keypair per profile (chat/approvals/admin) is unnecessary once pairing is
  gone — there is no per-device token slot to collide on, and a profile is just a
  different declared scope on the same keypair. One keypair is simpler and still
  sufficient.
- Consequence (recorded deliberately): the shared secret is a **full-power operator
  credential**. Its leakage grants any self-declared scope (`config.*`, `chat.inject`,
  `sessions.delete`, `device.pair.*`). Audit, alerting, and rotation must be sized to that
  level, not to read+write.

### D4. Replicas each hold their own keypair and upstream socket, sharing the secret via env

Production `agent-api` runs 2 replicas over a shared volume. Each replica lazily generates
its own keypair (last-write-wins on the shared path is harmless since devices are never
paired and deviceIds need not agree across replicas) and keeps its own upstream WebSocket.
The shared secret is injected via env to both. Gateway allows concurrent connections per
deviceId (a `Set<GatewayWsClient>`, no eviction), so two replicas coexist without
conflict. Browser connections land on whichever replica Traefik routes them to; no
cross-replica event coordination is needed (the session namespace is a deterministic hash).

- Why: shared identity bought nothing once pairing was removed, and a per-replica keypair
  avoids cross-replica file-write coordination. The only residual cost is that an upstream
  reconnect changes the connId, so in-flight tool events for an active run are lost
  (routed by connId) — M0 marks such runs degraded; M1 re-registers tool-event recipients
  after reconnect.

### D5. Isolation is target-scoped; target/agent validation uses DB plus workspace-api plus agents.list

- Feishu session users: DM target = own `feishu_open_id` (asserted, not trusted from the
  client); group target = owner-filtered DB query
  (`list_private_group_displays_for_owner`), the same source as `/workspaces/me`, with no
  openclaw.json or workspace-api HTTP dependency in the connect path.
- API-key service principals: never default to a user DM; the target must be explicit (or a
  server-configured dev default) and pass DB existence checks (`UserIdentity` /
  `ManagedGroup` enabled). Cross-user protection comes from the service-scoped session
  namespace, not from ownership checks that do not apply to services.
- `agentId` honors openclaw.json `bindings[].agentId` overrides (fetched via workspace-api
  HTTP, fail-closed — no silent fallback to the default-derived id) and is validated
  against a Gateway `agents.list` snapshot (internal call, TTL-cached, fail-closed),
  because the Gateway silently runs unknown agentIds with default config in a fresh
  workspace. The namespace is `agent:<agentId>:webchat:<hash16(tenantKey:identityId:targetKind:targetId)>:<clientSessionId>` — target-scoped, so different targets isolate naturally and
  the namespace is recomputable (no per-session DB mapping).
- `runId` is double-translated: the browser's `frontRunId` ↔ Gateway `bff-<namespace>-<frontRunId>` (the Gateway's `idempotencyKey`/`runId` is a global dedupe key, so the
  BFF namespaces it and never passes the client's value through).

### D6. WebUI sessions are independent of Feishu conversations

WebUI chats live under the `webui` namespace above. They share the agent (workspace,
memory files, model config) with the Feishu-routed conversation but are separate sessions:
the web never reads or writes `agent:<id>:main` / Feishu channel sessions, and web
messages are not delivered to Feishu.

- Why: joining the Feishu `main` session from the web would break the namespace isolation
  model and risk two writers forking one transcript. "Continue my Feishu conversation on
  the web" is deferred as an explicit future feature with its own delivery-semantics and
  concurrency review.

### D7. Rejected: device pairing + fork-level Phase 0

The superseded draft proposed making `agent-server` a paired device and changing the fork's
auth-gate default so a signed-but-credentialless device could create a pairing request
(valid signature + no credentials + not paired → pending request; valid signature + no
credentials + already paired → connect and receive a token; wrong credentials → reject).

- Why rejected: review found this rested on a misread — shared auth **bypasses** pairing,
  so the same operator connection is available with no Gateway change. The Phase 0 default
  change also had a large blast radius: "paired" would become the trust anchor, so
  revoking a token would no longer lock a device out and banning would require
  `device.pair.remove`, affecting the operational model of _all_ existing paired devices.
  Shared-secret bootstrap keeps Gateway at zero change and dev==prod on one path.
- Trade-off accepted: shared-secret banning is global (rotate the secret), there is no
  per-device revocation, and — importantly — this secret is **shared with Control UI human
  users** (`clawgateway.otr-tx.com`), so rotation also logs out every Control UI user. The
  rotation runbook must state this blast radius. D3 records that the secret is full-power,
  not read+write.

## Status

Accepted — 2026-07-09 (revised same day from a pairing-based draft). Implementation
tracked in `docs/plans/2026-07-09-openclaw-webui-m0-bff-bridge.md`; milestone roadmap in
`docs/research/openclaw-frontend-integration/webui_integration_milestones.md`.
