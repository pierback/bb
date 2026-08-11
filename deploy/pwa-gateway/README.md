# BB remote PWA gateway

`bb.staufingers.de` is a remote client for the BB coordinator on the NAS. The
VPS is deliberately not a BB server or an execution machine.

This directory is an independently releasable deployment package. It may live
in the BB repository while the packaging boundary is extracted, but it must not
import or launch BB server, host-daemon, or plugin implementation code. Its only
BB inputs are a published PWA artifact and the coordinator's public HTTP and
WebSocket surface. See the accepted
[core/plugin/deployment boundary](../../docs/session-fabric-plugin-boundary.md).

## Ownership boundary

| Concern                                                | Owner                                 |
| ------------------------------------------------------ | ------------------------------------- |
| Static PWA assets                                      | VPS (`/srv/bb-pwa/current`)           |
| Public TLS and login                                   | VPS Caddy and Authelia                |
| Chats, tasks, sessions, and orchestration state        | NAS BB coordinator                    |
| Repositories, worktrees, terminals, builds, and agents | Selected execution Mac                |
| PhotoCloud public relay                                | Existing VPS FRPS service (unchanged) |

The public gateway authenticates every PWA request. Caddy serves static files
locally and forwards BB API, WebSocket, install, and health routes to the NAS
over an FRP STCP visitor bound to VPS loopback. Native BB Desktop clients use
this same origin as their coordination-server URL without an Authelia browser
session. The app renderer, execution helper, and loopback-only CLI proxy use
both the paired-machine credential and daemon host key for `/api`, `/ws`,
`/health`, and self-update traffic; the coordinator validates the host key
before dispatch. `/internal` uses the same credential pair, including the
one-time enrollment token during initial pairing. The browser PWA remains
behind Authelia. The loopback-only enrollment-key route stays blocked. The NAS
coordinator is never published on a public TCP port.

## Traffic flow

```text
browser
  -> VPS FRPS :443 (shared SNI relay)
  -> VPS Caddy 127.0.0.1:8443
       -> Authelia 127.0.0.1:9091
       -> /srv/bb-pwa/current (static PWA)
       -> FRP STCP visitor 127.0.0.1:38886
            -> NAS BB coordinator 127.0.0.1:38886
                 -> selected execution host daemon
```

The existing `photocloud-frps.service` continues to own public ports 443 and 7000. The VPS-local FRP client claims only the `bb.staufingers.de` SNI name, so
the PhotoCloud and Immich routes remain isolated.

## Files installed outside the repository

Secrets are never committed. Install them with mode `0400`:

- VPS `/etc/bb-pwa/frps-auth-token`: the existing FRPS client token.
- VPS `/etc/bb-pwa/coordinator-stcp-secret`: the coordinator STCP secret.
- VPS `/etc/authelia/secrets/{JWT_SECRET,SESSION_SECRET,STORAGE_ENCRYPTION_KEY}`.
- NAS `/Users/nas/.bb/frp/coordinator-stcp-secret`: the same coordinator STCP
  secret as the VPS visitor.

The Authelia user database, SQLite database, and notification file live at
`/etc/authelia/users_database.yml` and `/var/lib/authelia/`. Migrating the
existing files keeps the current user and WebAuthn registrations because the
relying-party domain remains `bb.staufingers.de`.

## Release procedure

1. Build the PWA from the repository root:

   ```sh
   pnpm exec turbo run build --filter=@bb/app
   ```

2. Copy `apps/app/dist/` to a new, immutable directory under
   `/srv/bb-pwa/releases/`, then atomically repoint `/srv/bb-pwa/current`.
3. Validate Authelia, Caddy, both FRP configurations, and the private NAS
   coordinator path. Run the repository routing-boundary check before copying
   the configuration:

   ```sh
   ./deploy/pwa-gateway/test-routing.mjs
   ```

4. Stop the old Mac-hosted `bb.staufingers.de` FRP proxy and start
   `bb-pwa-frpc.service` on the VPS. Two clients must never claim the same SNI
   route simultaneously.
5. Verify the public login and PWA, then verify that PhotoCloud and Immich still
   resolve through the shared FRPS service.

Rollback is the inverse of step 4: stop the VPS gateway client and restart the
old proxy. Static releases and the previous configuration remain intact.
