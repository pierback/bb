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
Before that first move, shutdown escalation resolves and signals matching
installed-app processes on every poll and requires three consecutive checks
with neither an app process nor a healthy coordinator listener. This closes the
race where Electron exits while its detached bridge starts a new PID.

Promotion is an explicit, resumable state machine. The NAS runner persists one
identity-bound journal per tag under
`~/.bb/pierback-release-promotions/`: `prepared` → `nas-installed` →
`stable-verified` → `complete`. Each phase advances only after its external
effect is verified. A failure after NAS installation or stable activation does
not guess at compensation while clients may be observing the result; rerun the
protected workflow with the same immutable tag. It revalidates the candidate,
repeats idempotent incomplete work, and resumes from the durable phase. The
workflow writes the current phase and exact recovery command to its summary on
failure.

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

| Kind     | Name                        | Purpose                                                                 |
| -------- | --------------------------- | ----------------------------------------------------------------------- |
| Variable | `PIERBACK_SIGNING_IDENTITY` | Certificate owner selector; omit the `Developer ID Application:` prefix |
| Variable | `PIERBACK_VPS_HOST`         | VPS DNS name or IP                                                      |
| Variable | `PIERBACK_VPS_USER`         | Restricted deploy user (`root` initially)                               |
| Secret   | `APPLE_ID`                  | Apple notarization account                                              |
| Secret   | `APPLE_APP_PASSWORD`        | Apple app-specific password                                             |
| Secret   | `APPLE_TEAM_ID`             | Apple developer team                                                    |
| Secret   | `PIERBACK_VPS_SSH_KEY`      | Private deploy key                                                      |
| Secret   | `PIERBACK_VPS_KNOWN_HOSTS`  | Pinned VPS SSH host-key line                                            |

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
- **Build Pierback Desktop Candidate** runs manually after the sync or feature
  PR is approved and merged. It executes only on the NAS signing runner and
  publishes `canary`.
- **Promote Pierback Desktop** accepts the immutable candidate tag. Its
  protected job updates and smokes the NAS coordinator before it can move
  `stable`; it never rebuilds.

Run the deployment-level checks locally with:

```sh
node --test \
  deploy/desktop-release/promotion-state.test.mjs \
  deploy/desktop-release/publish-channel.test.mjs \
  deploy/desktop-release/release-automation.test.mjs \
  deploy/desktop-release/release-manifest.test.mjs \
  deploy/desktop-release/verify-bb-app-tarball.test.mjs
bash -n deploy/desktop-release/*.sh
```
