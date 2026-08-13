# Self-hosted native coordination

Status: accepted and implemented

## Outcome

A BB Desktop app can use a self-hosted HTTPS domain as its coordination server
without BB Connect. Chats, tasks, plugins, and orchestration state remain on the
coordinator, while Desktop's renderer, filesystem, local host daemon, terminals,
builds, and agents remain on this Mac.

The human authenticates once in the system browser through the deployment's
existing Authelia gate. Electron never receives an Authelia cookie. After
explicit device-and-code approval, Desktop receives a coordinator-scoped host
key through the existing one-time host enrollment mechanism.

This is a hard cutover for custom desktop targets. There is no fallback from a
custom domain to `getbb.app` pairing.

## Invariants

1. Selecting a coordinator never selects its filesystem as the execution
   filesystem.
2. A custom target cannot read coordinator APIs until its local execution host
   has a valid coordinator-issued host key.
3. Pairing approval requires a human-authenticated browser or a trusted
   coordinator-local CLI. A requesting native machine cannot approve itself.
4. Pairing secrets, enrollment tokens, host keys, browser cookies, and routing
   markers have distinct roles and are never treated as interchangeable.
5. `/internal` is unavailable to browsers and unauthenticated clients.
6. Gateway-supplied identity headers are stripped at every client-controlled
   boundary before trusted values are added.
7. Native enrollment is coordinator-origin-specific; switching domains cannot
   reuse another coordinator's host key.

## Layer ownership

| Layer                          | Owns                                                                                                                  | Does not own                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Domain and wire contracts      | Pairing request/response schemas, native routing marker, daemon protocol version                                      | HTTP policy, persistence, UI                     |
| Coordinator application policy | Pairing lifetime, capacity, secret verification, approval race serialization, enrollment issuance                     | Authelia sessions, Electron lifecycle            |
| Coordinator transport          | Exact public routes, owner/native admission checks, host-key verification                                             | Device UI, reverse-proxy policy                  |
| Desktop application            | Target transition, local execution-host lifecycle, pairing guide, system-browser launch, origin-scoped credential use | Browser authentication, coordinator state        |
| Host daemon                    | Auth-mode resolution, enrollment redemption, authenticated HTTP/WS routing, runtime execution                         | Coordinator selection, owner approval            |
| Browser app                    | Device/code inspection and explicit approval                                                                          | Native secrets, host-key storage, daemon startup |
| Deployment adapters            | PWA artifact, Authelia, Caddy route classes, FRP visitor                                                              | BB state, machine policy, execution              |

Dependencies point inward through typed contracts. The PWA deployment and the
standalone Session Fabric plugin do not import Desktop main-process or host
daemon implementations.

## Pairing protocol

```text
BB Desktop                         Caddy + Authelia          Coordinator
    |                                      |                    |
    | POST pairing create                 |                    |
    | X-Bb-Native-Client: host-key-v1 --->|------------------->|
    |<--- request id, poll secret, code, expiry ----------------|
    |                                      |                    |
    | open /pair-device?id&code ---------->| browser login       |
    |                                      |-- session marker -->|
    |                                      | inspect + approve    |
    |                                      |<-- approved --------|
    |                                      |                    |
    | POST poll(id, random secret) ------->|------------------->|
    |<--- one-time host id + join code --------------------------|
    |                                      |                    |
    | POST /internal/hosts/enroll -------->|------------------->|
    | native marker + join-code bearer     |                    |
    |<--- durable host key --------------------------------------|
    |                                      |                    |
    | API / WS / daemon traffic ---------->|------------------->|
    | native marker + host-key bearer      | host-key verified   |
```

The native header is routing metadata, not a credential. Pairing creation and
polling are the only requests admitted before a host key exists. Polling needs
the high-entropy request secret; browser approval needs the independently
displayed code plus an authenticated owner session. The join code is one-time,
and the resulting host key is the durable machine identity.

## Pairing state machine

```text
created --owner approval--> approved --join-code redemption--> enrolled
   |                            |
   +--expiry--------------------+--> expired
   |
   +--repeated bad poll secrets----> invalidated
```

Approval is idempotent and concurrent approvals share one enrollment issuance.
Requests live only for the approval window and are bounded both globally and
per trusted transport source, so one unauthenticated source cannot consume the
entire pending-pairing pool. A server restart intentionally invalidates pending
requests; Desktop starts a new flow.

## Request policy

| Surface                                  | Required evidence                          | Result                                |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------- |
| `POST /api/v1/native-client-pairings`    | Exact native marker; no bearer             | Create short-lived request            |
| `GET /api/v1/native-client-pairings/:id` | Owner browser/CLI; matching code           | Inspect device and status             |
| `POST .../:id/approve`                   | Owner browser/CLI; matching code           | Issue enrollment once                 |
| `POST .../:id/poll`                      | Exact native marker; random request secret | Pending status or one-time enrollment |
| `POST /internal/hosts/enroll`            | Native marker; join-code bearer            | Mint durable host key                 |
| `/api`, `/ws`, `/health`, install routes | Native marker; host-key bearer             | Native control surface                |
| Other `/internal`                        | Native marker; host-key bearer             | Host-daemon transport only            |
| Browser PWA and dynamic routes           | Authelia session                           | Owner control surface                 |

The coordinator also accepts owner operations from its trusted loopback CLI.
Public deployment policy is enforced by Caddy; the NAS coordinator remains
loopback-bound behind the FRP visitor.

## Desktop lifecycle

For a custom target, Desktop performs one target transition:

1. Stop the built-in coordinator and any previous remote services.
2. Start a local static renderer server.
3. Validate and reuse an origin-scoped host key, or run pairing and enrollment.
4. Start the local execution host pointed at the remote coordinator.
5. Start a capability-protected loopback gateway.
6. Serve static assets locally while proxying only `/api` and `/ws` to the
   coordinator with the host key and native marker.
7. Load the local gateway URL and start remote config synchronization.

Generation checks fence overlapping target switches. Any superseded transition
closes the renderer, gateway, and execution helper it allocated. Quitting or
switching back to This Mac closes all three and removes the Electron request
header hook.

The credential preflight never follows redirects and accepts only the
coordinator's typed health response. A 401/403 revocation clears that origin's
host key and host ID, then reopens the pairing guide. Network failures and
other gateway errors preserve the enrollment so a temporary NAS outage cannot
silently revoke this Mac.

Projects continue to select execution hosts independently. The canonical
sidebar badge reports the actual host for each project; a remote coordinator is
not inferred to be the execution host.

## Trust boundaries

- The Desktop gateway binds loopback and requires a process-random capability
  on every HTTP and WebSocket request. Electron injects it only for the exact
  gateway origins.
- Both Desktop and daemon proxies remove authorization, cookies, forwarding
  headers, Authelia identity headers, BB gate headers, and caller-supplied BB
  routing markers before adding trusted credentials.
- Caddy repeats that stripping at the public boundary. Browser traffic receives
  the trusted `X-Bb-Gate-Auth: session` marker only after forward-auth succeeds.
- Native host keys are verified by the coordinator before public API, health,
  update, WebSocket, or internal dispatch.
- The browser approval view receives no request secret, join code, or host key.
- The native client receives no Authelia cookie or user identity headers.

## Failure behavior

| Failure                      | Behavior                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| Authelia login cancelled     | Desktop keeps showing the matching code until the request expires                                  |
| Wrong browser code           | Coordinator returns indistinguishable not-found evidence                                           |
| Wrong poll secret            | Coordinator returns unauthorized and invalidates after bounded retries                             |
| Pairing/server restart       | Pending request disappears; Desktop starts a new approval                                          |
| Enrollment token replay      | Existing one-time enrollment policy rejects it                                                     |
| Invalid/revoked host key     | Desktop removes only that origin's enrollment and reopens the explicit pairing guide               |
| Local helper startup failure | Desktop stays on a local execution error and never opens the coordinator UI or its filesystem      |
| Local helper exits later     | Desktop closes its local gateway and renderer, then replaces the coordinator UI with a local error |
| Target switch during pairing | Generation fence cancels polling and discards allocated services                                   |
| Gateway or renderer failure  | Partial services close before an error page is shown                                               |

## Deployment boundary

The VPS hosts only the static PWA and access adapters:

```text
Internet -> Caddy :443 -> Authelia :9091
                        -> static PWA in /srv/bb-pwa/current
                        -> FRP visitor :38886 -> NAS loopback coordinator
```

It does not host the BB server, repositories, worktrees, provider runtimes, or
Session Fabric backend. The existing PhotoCloud FRPS service remains separate.
The reference config validates handler order, exact native surfaces, `/internal`
rejection, header stripping, browser authentication, and PWA environment.

## Verification matrix

| Requirement                                          | Automated evidence                                            |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| Pairing secrecy, expiry, retry bounds, approval race | Coordinator pairing service tests                             |
| Native/owner route separation and full enrollment    | Coordinator public route tests                                |
| Typed public API and SDK                             | Server-contract and SDK tests/typechecks                      |
| Native/direct/Connect hard auth union                | Host-daemon routing-auth tests                                |
| HTTP/WS header injection and spoof stripping         | Daemon and Desktop gateway tests                              |
| Pairing guide and explicit approval                  | App view tests                                                |
| Approval route stays outside interactive app runtime | App route-boundary test                                       |
| Local execution lifecycle and credential persistence | Desktop execution-host tests                                  |
| Caddy/Authelia routing policy                        | Executable PWA gateway routing test and Caddy validation      |
| Wire cutover                                         | Host daemon protocol contract test at the incremented version |

## Rollout and rollback

Deploy in this order: coordinator artifact on the NAS, PWA artifact and Caddy
config on the VPS, then the matching Desktop build. The native wire change is
guarded by the daemon protocol version; mixed versions fail closed instead of
falling back to BB Connect.

Keep the previous NAS artifact, PWA release directory, and Caddyfile available.
Rollback restores all three as one versioned set. Database rollback is not
required because pending pairing state is in memory and the durable credential
uses the existing host enrollment records.
