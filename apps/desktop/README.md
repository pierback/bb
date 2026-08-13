# Pierback Desktop

Pierback's macOS Electron shell loads the BB web UI and uses the packaged
`bb-app` launcher for coordinator and execution-host lifecycle.

The active coordination server is selected under **Settings → BB Server** (or
the native **Window → Server** menu). “This Mac” runs the bundled server and
stores its data locally; BB Connect and custom targets load an existing remote
server. This selection never chooses a workspace filesystem. Execution hosts
and their project paths are configured separately under **Settings → Machines**
and selected when creating or reusing an environment.

## Development

From the repo root, the full source dev loop is:

```bash
pnpm dev:desktop
```

That starts the source dev server and the Electron shell through
`scripts/bb-dev-app`. To run only the desktop package task directly:

```bash
pnpm exec turbo run dev --filter=@bb/desktop
```

The dev script builds `bb-app`, compiles the Electron main/preload files, and
opens Electron directly. By default it uses the same checkout-scoped
`~/.bb-dev/<checkout-instance>` data directory and deterministic high ports as
the main repo dev launcher; it prints the resolved data dir, server URL, and
Electron user-data dir at startup. It intentionally overwrites inherited
`BB_DATA_DIR`, `BB_SERVER_PORT`, `BB_SERVER_URL`, and `BB_HOST_DAEMON_PORT` so a
desktop dev run launched from an existing bb session still targets the current
checkout. Set `BB_DESKTOP_USER_DATA_DIR` to override only Electron's user-data
directory.

The launcher probes the checkout's Vite app port at startup and adapts:

- **`pnpm dev` is already running** (Vite reachable): the shell loads the Vite
  dev URL, so you get live source and HMR for `@bb/app` changes — no rebuild
  needed. It still attaches to the same running server/daemon for all API/WS
  traffic. The launcher prints `app <url> (Vite dev server — live reload)`. This
  is the fast loop for iterating on the desktop UI.
- **`pnpm dev` is not running**: the shell starts its own `bb-app` runtime and
  loads the built UI it serves, so you must rebuild (re-run this task) to pick up
  source changes. The launcher prints `app (own bb-app runtime — …)`.

The override is plumbed via `BB_DESKTOP_APP_URL`, which the launcher only sets
when Vite is confirmed reachable; it is never set in packaged builds, so
production always loads the server's own built UI.

To run the slower unpacked Electron Builder app, which more closely matches the
packaged runtime and keeps native dependencies rebuilt for Electron's bundled
Node runtime:

```bash
pnpm exec turbo run start --filter=@bb/desktop
```

Electron is pinned to `41.7.0`, the highest stable line verified to rebuild the
packaged native modules with the current dependency set. Electron 42.2.0 was
tested, but `better-sqlite3@12.10.0` does not compile against Electron ABI 146.
Revisit the pin when `better-sqlite3` ships support or prebuilds for that ABI.

## Validation

```bash
pnpm exec turbo run typecheck --filter=@bb/desktop --filter=bb-app
pnpm exec turbo run build --filter=@bb/desktop
pnpm exec turbo run test --filter=@bb/desktop --filter=bb-app --force
pnpm exec turbo run dev --filter=@bb/desktop
```

## Packaging and local smoke

```bash
pnpm exec turbo run desktop:build --filter=@bb/desktop
pnpm exec turbo run smoke:packaged --filter=@bb/desktop
```

Artifacts are written under `apps/desktop/release/`. The desktop build is
macOS-only and Apple Silicon arm64-only. A non-signing Mac must opt out
explicitly:

```bash
BB_DESKTOP_BUILD_FLAVOR=release \
CSC_IDENTITY_AUTO_DISCOVERY=false \
pnpm --filter @bb/desktop run package
```

That command is only for local artifact and smoke validation. Every
distributable Pierback build is signed and notarized by the protected NAS
runner; no other workflow or developer machine may publish an update.

## Releasing

`bb-app` and `@bb/desktop` versions are LOCKED in lockstep. The desktop package
depends on `bb-app: workspace:*`, and the displayed release version string must
match `packages/bb-app/package.json`.

To bump for a release:

```bash
node scripts/bump-version.mjs <new-version>
```

Then commit and merge the reviewed change into the fork's default branch. You
can also use `--patch`, `--minor`, or `--major` instead of an explicit version.

CI enforces this lockstep. Direct edits that leave
`packages/bb-app/package.json` and `apps/desktop/package.json` with different
versions fail the build. Never edit either package version directly for a
release; use `scripts/bump-version.mjs` so both files move together.

The immutable GitHub tag is `pierback-desktop-v<version>`. Dispatch **Build
Pierback Desktop Candidate** only after the versioned commit reaches the default
branch. The protected NAS runner builds, signs, notarizes, smokes, and publishes
one candidate to `canary`. Dispatch **Promote Pierback Desktop** only after
manual canary approval; it installs that exact ZIP on the NAS coordinator,
verifies the app version and host-daemon protocol, and only then exposes the
same artifacts on `stable`.

The inherited moving `desktop-latest` / `desktop-nightly` jobs are deliberately
absent from the fork. Upstream releases enter through a synchronization PR and
can never merge, sign, or deploy themselves.

## Build flavors and update channels

Build flavor controls application identity, not deployment stage:

| Flavor  | Product          | Bundle identifier                         | Default channel |
| ------- | ---------------- | ----------------------------------------- | --------------- |
| release | Pierback         | `de.staufingers.pierback.desktop`         | `stable`        |
| preview | Pierback Preview | `de.staufingers.pierback.desktop.preview` | disabled        |

Each installed Pierback release build can switch between `canary` and `stable`
under **Settings → Updates**. The preference is local to that Mac and does not
move when its coordination server changes. Preview builds never auto-update.

## NAS signing + notarization

The NAS Actions runner selects one installed Developer ID Application identity
through `PIERBACK_SIGNING_IDENTITY`. Apple notarization credentials and the
pinned VPS deploy transport are stored in the protected `pierback-canary` and
`pierback-production` GitHub environments. Partial credentials, unsigned apps,
failed Gatekeeper assessment, missing stapling, mutable release tags, and
non-default-branch builds all fail closed. The full setup contract is in
[`deploy/desktop-release`](../../deploy/desktop-release/README.md).

## Auto-update

The renderer version check and `electron-updater` both derive their target from
the same durable `canary` or `stable` preference. They read only
`https://updates.bb.staufingers.de/<channel>/`; no Pierback build contains an
official `get-bb/bb` update URL. The public update host contains static signed
artifacts only and deliberately has no Authelia redirect or coordinator proxy,
because a background updater cannot complete interactive login.

Checks run on launch, hourly, and when the app becomes active. The JSON feed can
show that a version is available while the native updater downloads it; install
occurs on restart or explicit approval. Local dev builds skip native auto-update
unless `BB_DESKTOP_AUTO_UPDATE=1` is set.

To verify a downloaded or unpacked build:

```bash
spctl --assess --verbose /path/to/Pierback.app
codesign --verify --deep --strict --verbose=2 /path/to/Pierback.app
```

## Debugging

Use the View menu to toggle DevTools. To open them automatically on launch, set
`BB_DESKTOP_OPEN_DEVTOOLS=1`:

```bash
BB_DESKTOP_OPEN_DEVTOOLS=1 apps/desktop/release/mac-arm64/Pierback.app/Contents/MacOS/Pierback
```

When the desktop app spawns `bb-app`, server and daemon logs land under
`~/.bb/logs/` or `$BB_DATA_DIR/logs/` when `BB_DATA_DIR` is set.

To verify attach-if-found manually, start the source coordinator in one
terminal, then launch the desktop app from another:

```bash
pnpm start
pnpm exec turbo run dev --filter=@bb/desktop
```

The desktop supervisor handles normal quits plus `SIGINT` and `SIGTERM`, and it
writes a PID file so the next launch can reap a stale Electron-owned `bb-app`
launcher. Hard crashes such as process aborts, segfaults, or kernel-level kills
cannot run cleanup in the crashing process; the startup PID-file reap is the
recovery path for those cases.
