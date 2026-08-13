<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# Pierback

Pierback is a focused fork of [get-bb/bb](https://github.com/get-bb/bb) for a
self-hosted coordination server with execution on separately enrolled Macs.
The fork keeps the coordinator/execution split, native pairing, runtime
fencing, and stable extension points in core; Session Fabric remains a plugin,
and the browser gateway remains an independent deployment.

bb is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

Every surface — the desktop app, web app, CLI, and HTTP API — is a first-class
way to drive bb. Work runs in threads you can follow live, steer at any point,
or hand off to another agent.

> [!NOTE]
> bb is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving.

<p align="center">
  <img alt="bb desktop app showing a code review thread, dispatch panel, and task board" src="assets/app-screenshot.png" width="800">
</p>

## Use Pierback

### Download the desktop app

The recommended native client is the signed Pierback desktop app:

**[Download the latest Pierback release](https://github.com/pierback/bb/releases/latest)**

The desktop build is currently macOS Apple Silicon (arm64) only. Install it
once on each Mac and pair that Mac as an execution host. Stable clients update
from `https://updates.bb.staufingers.de/stable/`; the same signed Pierback app
can opt into `canary` under Settings → Updates. Pierback Preview is a separate
development identity with automatic updates disabled. Both published channels
contain only signed, notarized static artifacts and are intentionally outside
Authelia.

For remote browser access, use the Authelia-protected PWA at
`https://bb.staufingers.de`. The PWA stores and reads chats through the NAS
coordinator; enrolled Macs remain responsible for their own files, terminals,
builds, and agent execution.

To run the fork from source, follow the development workflow below. Pierback
does not publish the inherited `bb-app` npm package or the upstream moving
`desktop-latest` / `desktop-nightly` releases.

For development requirements, provider setup, configuration, and internal
package docs, start with
[`packages/bb-app`](./packages/bb-app/README.md).

### Telemetry

Production runs (the desktop app and deployed coordinator) send anonymous usage
telemetry (app starts, thread creation counts, and user message counts) to help
us understand adoption. Identification is a random per-install id stored in your
data dir — no user, host, project, workspace, or message content is ever
attached. Development/source runs never send. Opt out any run with
`BB_TELEMETRY=false`. See
[`apps/server/src/services/system/telemetry.ts`](./apps/server/src/services/system/telemetry.ts).

## Development

Use the development loop when working on bb itself:

```bash
pnpm dev
```

That starts the Vite app and proxies API and WebSocket traffic to a separate
dev server. The launcher prints the actual ports at startup. Each checkout gets
a data directory under
`~/.bb-dev/<checkout-instance>/` and deterministic high ports derived from the
checkout path. The checkout instance id is the sanitized path to the checkout,
relative to your home directory, plus a short hash suffix. Separate worktrees
can run alongside each other and the signed Pierback app.

To run that same source dev server with the Electron desktop shell:

```bash
pnpm dev:desktop
```

This uses `scripts/bb-dev-app current --desktop`, which stops stale launcher
sessions, checks dependencies and native modules, starts the source dev server,
then opens the desktop shell against that dev app. The launcher prints the web
URL but does not open a browser unless you pass `--open`.

To use the dev app from another machine over Tailscale, run `pnpm dev`, note the
printed app port, and publish the loopback Vite listener:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<app-port>
```

Then open `https://<machine>.<tailnet>.ts.net`. Source dev binds both the Vite
app and main server to loopback by default; Vite continues to proxy API and
WebSocket traffic.

To use the component storybook from another machine, run:

```bash
pnpm storybook
```

Ladle binds to all interfaces and configures its HMR WebSocket to use the
browser's current host instead of `localhost`. Do not run `pnpm storybook` on an
untrusted network.

Development behavior is intentionally split:

- the app hot reloads itself
- the server does not hot reload
- the host daemon does not hot reload

When you want the server and host daemon to pick up the latest build output, use:

```bash
pnpm dev:restart
pnpm dev:restart-server
pnpm dev:restart-host-daemon
```

These rebuild first, then restart only the targeted stateful services.

To run a production-mode build from a source checkout:

```bash
pnpm start
```

That builds only the app, server, and host-daemon runtime artifacts, then runs
the launcher directly against those workspace outputs. Use the `bb-app`
tarball smoke task when validating the coordinator-distributed daemon package.

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets this checkout's dev instance
pnpm reset:dev            # clear this checkout's dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

## Repository Overview

See [Repository overview](docs/repository-overview.md) for the monorepo package and app map.

## System Overview

See [System overview](docs/system-overview.md) for runtime architecture, data model, and component boundaries.

## Further Reading

- [Vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)
- [Worktrees and setup scripts](docs/worktrees.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Troubleshooting

### `Could not locate the bindings file`

bb uses native add-ons, for example `better-sqlite3` and `@parcel/watcher`. npm
downloads or builds those binaries in a package install script. If npm does not
run install scripts, the binaries are absent. bb then stops at startup with this
error:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

The usual cause is `ignore-scripts=true` in your `~/.npmrc`. Reinstall the
workspace dependencies with install scripts enabled:

```bash
npm_config_ignore_scripts=false pnpm install
```

The environment variable applies to that command only. Keep
`ignore-scripts=true` in your `~/.npmrc` if you want it for security.

The same error has other causes. A Node.js major-version change after the
install causes it. A copy of `node_modules` from a different operating system,
CPU architecture, or libc variant also causes it. To recover, reinstall the
workspace dependencies or run `pnpm rebuild better-sqlite3`.
