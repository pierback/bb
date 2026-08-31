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
| Public signed BB Mesh update feeds                     | VPS (`/srv/bb-updates`)               |
| Public TLS and login                                   | VPS Caddy and Authelia                |
| Chats, tasks, sessions, and orchestration state        | NAS BB coordinator                    |
| Repositories, worktrees, terminals, builds, and agents | Selected execution Mac                |
| PhotoCloud public relay                                | Existing VPS FRPS service (unchanged) |

The public gateway authenticates every browser and PWA request with Authelia.
Caddy serves static files locally and forwards BB API, WebSocket, install, and
health routes to the NAS over an FRP STCP visitor bound to VPS loopback.

Machine bootstrap is the sole unauthenticated coordinator exception. `GET` or
`HEAD` for exactly `/install.sh`, `/install/version`, and
`/install/bb-app.tgz` is proxied without caller credentials so a new machine
can run its one-time join command. No API or `/internal` route shares that
boundary.

Native BB Desktop clients use the same origin without receiving or storing an
Authelia cookie. A new desktop creates a short-lived pairing request, opens the
Authelia-protected `/pair-device` guide in the system browser, and polls with a
random one-time secret. After the owner verifies the device and matching code,
the coordinator issues the existing one-time host enrollment. The enrolled app
then uses a durable daemon host key plus `X-Bb-Native-Client: host-key-v1` for
API, WebSocket, health, update, and internal daemon traffic. The coordinator
validates the host key before dispatch.

`updates.bb.staufingers.de` is deliberately outside Authelia. It is a
read-only static host containing only Apple-signed and notarized BB Mesh
artifacts plus their generated update metadata. It has no reverse proxy to the
coordinator. Desktop keeps its `canary` or `stable` selection on each Mac;
switching coordination servers cannot alter that selection.

The native marker is intentionally not a secret. It selects the Caddy route;
the random poll secret, one-time join code, and durable host key provide the
actual authentication. Caddy strips spoofed browser/gate and retired
`X-Bb-Connect-Machine` headers plus browser cookies at every native boundary.
Browser requests have native credentials and their Authelia cookie stripped
before reaching BB, then receive `X-Bb-Gate-Auth: session` only after Authelia
succeeds. The loopback-only enrollment-key route stays blocked. The NAS
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

Desktop updater
  -> https://updates.bb.staufingers.de/{canary|stable}/
       -> /srv/bb-updates (static signed artifacts only)
```

## Connect this Mac

1. In BB Desktop, select `https://bb.staufingers.de` as the coordination
   server.
2. BB Desktop displays a matching code and opens `/pair-device` in the system
   browser.
3. Sign in to Authelia if needed. Confirm that the device name and code match.
4. Choose **Approve this Mac**, close the browser tab, and return to BB
   Desktop. Enrollment and local execution startup finish automatically.

Authelia is used only for the human approval step. Normal native use does not
open a login page and does not copy the browser session into Electron.
If the coordinator later rejects a revoked host key, Desktop opens this guide
again. A network outage does not erase the saved pairing.

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

The desktop updater's complete runner, environment, credential, immutability,
and rollback contract is documented in
[`deploy/desktop-release`](../desktop-release/README.md).

Desktop releases use an immutable candidate and promotion flow. The NAS Mac is
the signing worker because its keychain owns the Developer ID identity:

1. Dispatch **Build BB Mesh Candidate**. The NAS runner builds one
   release-flavor app, signs and notarizes it, verifies the packaged smoke test,
   and creates an immutable `bb-mesh-desktop-v<version>` GitHub release.
2. The workflow publishes those exact binaries to `/srv/bb-updates/canary/`.
   Set only test Macs to **Canary** in Settings → Updates.
3. After manual approval, dispatch **Promote BB Mesh** with the
   candidate tag. It verifies the candidate checksum manifest, updates the NAS
   coordinator first, and runs its health smoke test.
4. Only after that smoke test passes does the workflow copy the same candidate
   bytes to `/srv/bb-updates/stable/`. No rebuild occurs during promotion.

The update host must remain public because a background updater cannot complete
interactive authentication. Apple code-signing verification protects installs;
the promotion workflow additionally verifies the immutable SHA-256 manifest.

### PWA release

PWA releases are independent from signed Desktop releases. Dispatch
**Deploy BB Mesh PWA** from the fork's default branch whenever the app bundle
changes. The production environment requires explicit approval.

The workflow:

1. Builds the PWA with Turbo and verifies that the emitted JavaScript contains
   both `/pair-device` and its approval view.
2. Validates the checked-in Caddyfile, atomically installs it on the VPS,
   reloads Caddy, and proves the live BB Mesh artifact matcher. A failed reload
   restores and reloads the previous config.
3. Produces a source-commit manifest and a complete `SHA256SUMS` file.
4. Uploads the package through pinned SSH, installs it under the immutable
   `/srv/bb-pwa/releases/bb-mesh-pwa-<commit>` path, and atomically repoints
   `/srv/bb-pwa/current`.
5. Verifies the active symlink and that Authelia preserves the full pairing URL
   while redirecting an unauthenticated browser.

For local preflight, run:

```sh
pnpm exec turbo run build --filter=@bb/app
node deploy/pwa-gateway/release-package.mjs prepare apps/app/dist "$(git rev-parse HEAD)"
node deploy/pwa-gateway/test-routing.mjs
node --test deploy/pwa-gateway/*.test.mjs
```

Rollback repoints `/srv/bb-pwa/current` to a previously verified immutable
release. It does not change FRP, Authelia, the coordinator, PhotoCloud, or
Immich.
