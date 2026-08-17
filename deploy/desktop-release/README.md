# Pierback desktop release pipeline

Pierback never consumes the official `get-bb/bb` desktop update feed. Every
release-flavor app reads one of these public, static feeds instead:

- `https://updates.bb.staufingers.de/canary/`
- `https://updates.bb.staufingers.de/stable/`

The feed is intentionally outside Authelia. It contains only Apple-signed and
notarized artifacts plus checksummed metadata; it has no proxy route to BB.
Channel selection is a local setting on each Mac and is independent of the
coordination server. `canary` and `stable` both carry the ordinary Pierback
bundle identity so the same immutable bytes can be promoted. The side-by-side
developer app, Pierback Preview, has automatic updates disabled and never
reads either feed.

## Release state machine

```text
approved Pierback main commit
  -> NAS runner builds, signs, notarizes, and packaged-smokes once
  -> immutable GitHub prerelease pierback-desktop-v<version>
  -> checksum-identical canary feed
  -> manual pierback-production approval
  -> NAS coordinator installs that exact ZIP
  -> version/protocol plus coordinator-built bb-app.tgz smoke
  -> checksum-identical stable feed
  -> GitHub prerelease becomes the promoted release
```

`publish-channel.sh` never edits an existing release directory or channel
view. It validates a strict filename allowlist and every `SHA256SUMS` entry,
then points the selected channel at a versioned view. A retry is accepted only
when the existing bytes are identical. `install-nas-candidate.sh` preserves
the previous Pierback app and the legacy official `bb.app` under
`/Applications/Pierback Backups/`; it restores the prior app if the new local
coordinator does not report the release's exact desktop version and daemon
protocol or cannot build a valid machine bootstrap tarball. Its rollback is
armed before the first app move, so a failed rename, launch, health check, or
bootstrap check restores every app that existed before the attempt.
After the old coordinator is stopped, the installer also creates and verifies
a consistent SQLite snapshot under `~/.bb/pierback-release-backups/` before it
moves an app. A failed candidate atomically restores that snapshot (or removes
only `bb.db` and its two exact sidecars if no database existed before cutover)
before reopening the prior app. Successful rollback consumes the adjacent
snapshot with a same-filesystem rename, avoiding a second database-sized
staging allocation; a successful candidate retains its snapshot. If database
recovery cannot be verified, the old coordinator stays closed. The snapshot
remains available when replacement did not occur; after replacement, the
restored `bb.db` itself is kept closed for manual inspection.
Before that first move, shutdown sends `SIGTERM` directly to matching installed
GUI processes instead of issuing an Apple event that can launch an otherwise
stopped app. Escalation resolves and signals every new GUI generation on every
poll, then asks the detached runtime to stop itself through its
identity-verified `bb-app-runtime.json` record. This order prevents a legacy GUI
from recreating its supervisor after it was stopped. If a verified runtime
record appears late, the fence stops that generation too and restarts its quiet
window. It finally requires five consecutive checks with neither an app process
nor a healthy coordinator listener. Candidate and rollback launches start from
an empty environment and admit only the native user's stable home, identity,
locale, temporary-directory, shell, SSH-agent, and fixed user-toolchain/system
path values. The toolchain path admits mise, Homebrew, `/usr/local`, and system
binaries without inheriting Actions paths. They reject a symlinked `~/.bb` or
persisted `BB_DATA_DIR` override and execute the exact packaged binary with the
one protected data directory supplied explicitly. This deliberately bypasses
LaunchServices, which can reapply conflicting `launchctl` environment values.
Together these rules close the renamed/supervised-runtime race, the
detached-bridge PID race, and the clean-exit-before-Electron-startup failure
seen on the self-hosted runner.

Promotion is an explicit, durable state machine. The NAS runner persists one
host-global, identity-bound journal at
`~/.bb/pierback-release-promotions/nas-coordinator.json`: `prepared` →
`nas-installing` → `nas-installed` → `stable-verified` → `complete`. A completed
release or safely prepared state may roll the journal forward to a new
candidate; installing, installed, stable-verified, and recovery-required states
block every other tag. The installer alone advances `nas-installing` after
version, protocol, bootstrap, and database safety checks all pass. A verified
automatic rollback returns to `prepared`, allowing a corrected immutable
candidate to replace the failed identity. An interrupted or incomplete cutover
remains `nas-installing` or becomes `recovery-required`, so a candidate-migrated
database can never become the next baseline snapshot. After manually restoring
and validating the pre-cutover database and coordinator, an operator must run
`promotion-state.mjs acknowledge-recovery` for that global journal and the
blocked candidate identity. Failures in later verified phases remain safely
resumable with the same immutable tag. At the schema-3 cutover, retired per-tag
schema-1/2 journals are inspected before the global journal is initialized.
Schema-1 is safe only at `complete` because its `prepared` phase did not fence
an active installer; schema-2 is safe at `prepared` or `complete`. Every other
state fails closed until an operator restores and validates the NAS and removes
the retired journal.

## One-time GitHub setup

Register the NAS Mac as a repository Actions runner with these labels:

```text
self-hosted, macOS, ARM64, pierback-signing
```

The runner must execute in the logged-in `nas` GUI session so it can read the
Developer ID identity from that user's keychain and launch the coordinator.
Start `/Users/nas/actions-runner/run.sh` from that user's LaunchAgent; do not
use the runner's `svc.sh` wrapper. GitHub's macOS service startup can enumerate
the certificate while still failing private-key access with
`errSecInternalComponent`. The candidate preflight rejects service mode and
performs a timestamped signing probe before installing dependencies.

Create two GitHub environments, both with required-reviewer protection:

- `pierback-canary`
- `pierback-production`

Configure these repository or environment values:

| Kind     | Name                           | Purpose                                                                                                |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Variable | `PIERBACK_SIGNING_IDENTITY`    | Certificate owner selector; omit the `Developer ID Application:` prefix                                |
| Variable | `PIERBACK_VPS_HOST`            | VPS DNS name or IP                                                                                     |
| Variable | `PIERBACK_VPS_USER`            | Restricted deploy user (`root` initially)                                                              |
| Secret   | `APPLE_ID`                     | Apple notarization account                                                                             |
| Secret   | `APPLE_APP_PASSWORD`           | Apple app-specific password                                                                            |
| Secret   | `APPLE_TEAM_ID`                | Apple developer team                                                                                   |
| Secret   | `PIERBACK_VPS_SSH_KEY`         | Private deploy key                                                                                     |
| Secret   | `PIERBACK_VPS_KNOWN_HOSTS`     | Pinned VPS SSH host-key line                                                                           |
| Secret   | `PIERBACK_UPSTREAM_SYNC_TOKEN` | Fine-grained token with Contents, Workflows, and pull-request write access for the daily upstream sync |

The release workflow refuses unsigned, partially configured, non-default-
branch, prerelease-version, or mutable-tag builds. Increment
`apps/desktop/package.json` (and the repository's lockstep versions) before
creating each candidate.

## Workflows

- **Propose Upstream BB Release Sync** runs daily. It publishes the exact
  official release commit to an isolated `automation/upstream-*` branch and
  opens a PR against Pierback's current default branch. GitHub exposes merge
  conflicts for manual resolution; automation never applies a conflict
  strategy, auto-merges, signs, updates the NAS, or moves a feed.
  `PIERBACK_UPSTREAM_SYNC_TOKEN` is intentionally separate from the default
  Actions token because an upstream release may change files under
  `.github/workflows/`.
- **Build Pierback Desktop Candidate** runs manually after the sync or feature
  PR is approved and merged. It executes only on the NAS signing runner and
  publishes `canary`.
- **Promote Pierback Desktop** accepts the immutable candidate tag. Its
  protected job updates and smokes the NAS coordinator before it can move
  `stable`; it never rebuilds.

Run the deployment-level checks locally with:

```sh
node --test \
  deploy/desktop-release/nas-database-rollback.test.mjs \
  deploy/desktop-release/nas-desktop-launch.test.mjs \
  deploy/desktop-release/nas-desktop-processes.test.mjs \
  deploy/desktop-release/nas-desktop-runtime.test.mjs \
  deploy/desktop-release/promotion-state.test.mjs \
  deploy/desktop-release/publish-channel.test.mjs \
  deploy/desktop-release/release-automation.test.mjs \
  deploy/desktop-release/release-manifest.test.mjs \
  deploy/desktop-release/verify-bb-app-tarball.test.mjs
bash -n deploy/desktop-release/*.sh
```
